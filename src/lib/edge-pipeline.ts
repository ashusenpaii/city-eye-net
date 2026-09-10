/**
 * Standalone edge perception pipeline.
 *
 * Samples frames from whatever source the edge camera module publishes, runs
 * them through the on-device vision endpoint at a configurable rate, and emits
 * detections plus rolling quality metrics. It holds no UI and no camera code,
 * so the same pipeline can drive the viewfinder, a headless run, or a test.
 */

import { HAZARD_META, type SimDetection } from "@/lib/dashcam-engine";
import { analyzeFrame, type FrameDetection } from "@/lib/vision.functions";

export type PipelineStatus = "idle" | "warming" | "live" | "error";

export interface PipelineFrame {
  /** JPEG data URL of the sampled frame. */
  image: string;
  width: number;
  height: number;
}

export interface PipelineUpdate {
  status: PipelineStatus;
  detections: SimDetection[];
  latencyMs: number;
  error?: string;
  scene?: string;
  meanConfidence: number;
  frameSuccessRate: number;
  framesSampled: number;
  detectionsScored: number;
  /** Detections worth an evidence snapshot (defects + critical events). */
  captures: SimDetection[];
}

export interface PipelineOptions {
  /** Pulls the next frame from the sensor; return null when none is ready. */
  grab: () => PipelineFrame | null;
  threshold: () => number;
  /** Inference passes per second (0.5 – 4). */
  targetFps: () => number;
  onUpdate: (u: PipelineUpdate) => void;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

function toDetection(d: FrameDetection, now: number): SimDetection {
  seq += 1;
  const meta = HAZARD_META[d.kind];
  return {
    id: `det-${now.toString(36)}-${seq}`,
    kind: d.kind,
    ...(d.vehicle_class ? { vehicleClass: d.vehicle_class } : {}),
    box: {
      x: clamp01(d.box.x),
      y: clamp01(d.box.y),
      w: clamp01(d.box.w) || 0.05,
      h: clamp01(d.box.h) || 0.05,
    },
    vx: 0,
    vy: 0,
    confidence: Math.min(100, Math.max(0, d.confidence)),
    ...(d.plate ? { plate: d.plate.toUpperCase().replace(/\s+/g, "") } : {}),
    ...(typeof d.speed_kph === "number" ? { speedKph: Math.round(d.speed_kph) } : {}),
    ttl: 999,
    born: now,
    ...(meta.group === "critical" ? { reticle: true } : {}),
  };
}

export class EdgePipeline {
  private cancelled = false;
  private running = false;
  private framesSampled = 0;
  private framesRead = 0;
  private confSum = 0;
  private confCount = 0;
  private seen = new Set<string>();

  constructor(private opts: PipelineOptions) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    void this.loop();
  }

  stop() {
    this.cancelled = true;
    this.running = false;
  }

  private emit(u: Omit<PipelineUpdate, "meanConfidence" | "frameSuccessRate" | "framesSampled" | "detectionsScored">) {
    this.opts.onUpdate({
      ...u,
      meanConfidence: this.confCount ? this.confSum / this.confCount : 0,
      frameSuccessRate: this.framesSampled ? (this.framesRead / this.framesSampled) * 100 : 0,
      framesSampled: this.framesSampled,
      detectionsScored: this.confCount,
    });
  }

  /** Interval between passes, derived from the requested inference rate. */
  private interval() {
    const fps = Math.min(4, Math.max(0.5, this.opts.targetFps() || 1));
    return 1000 / fps;
  }

  private async loop() {
    while (!this.cancelled) {
      const frame = this.opts.grab();
      if (!frame) {
        await wait(500);
        continue;
      }
      const threshold = this.opts.threshold();
      const started = performance.now();
      this.framesSampled += 1;
      try {
        const res = await analyzeFrame({
          data: {
            image: frame.image,
            threshold,
            width: frame.width,
            height: frame.height,
          },
        });
        if (this.cancelled) return;
        const latencyMs = performance.now() - started;

        if (!res.ok) {
          this.emit({
            status: "error",
            detections: [],
            latencyMs,
            error: res.error,
            captures: [],
          });
          const retryable = res.status === 429 || res.status >= 500;
          await wait(retryable ? Math.max(4000, (res.retryAfterSec ?? 5) * 1000) : 9000);
          continue;
        }

        this.framesRead += 1;
        const now = Date.now();
        const detections = res.detections.map((d) => toDetection(d, now));
        const captures: SimDetection[] = [];
        for (const d of detections) {
          if (d.confidence < threshold) continue;
          this.confSum += d.confidence;
          this.confCount += 1;
          const meta = HAZARD_META[d.kind];
          const key = `${d.kind}:${Math.round(d.box.x * 12)}:${Math.round(d.box.y * 12)}:${d.plate ?? ""}`;
          if ((meta.group === "defect" || meta.group === "critical") && !this.seen.has(key)) {
            this.seen.add(key);
            captures.push(d);
          }
        }
        this.emit({
          status: "live",
          detections,
          latencyMs,
          captures,
          ...(res.scene ? { scene: res.scene } : {}),
        });
      } catch (err) {
        if (this.cancelled) return;
        this.emit({
          status: "error",
          detections: [],
          latencyMs: performance.now() - started,
          error: err instanceof Error ? err.message : "Perception request failed.",
          captures: [],
        });
        await wait(6000);
        continue;
      }
      await wait(this.interval());
    }
  }
}
