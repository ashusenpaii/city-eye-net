/**
 * Standalone edge camera module.
 *
 * Owns everything about the physical sensor on the device: which camera is
 * bound, at what resolution, whether the torch is lit, and what the driver
 * actually granted. It knows nothing about perception or UI — the Dashcam
 * viewfinder simply consumes the MediaStream it publishes.
 */

export type EdgeResolution = "480p" | "720p" | "1080p";

export const EDGE_RESOLUTIONS: Record<
  EdgeResolution,
  { width: number; height: number; label: string }
> = {
  "480p": { width: 854, height: 480, label: "854 × 480 · low bandwidth" },
  "720p": { width: 1280, height: 720, label: "1280 × 720 · fleet default" },
  "1080p": { width: 1920, height: 1080, label: "1920 × 1080 · high detail" },
};

export interface EdgeCameraDevice {
  deviceId: string;
  label: string;
}

export type EdgeCameraState = "idle" | "starting" | "streaming" | "error";

export interface EdgeCameraStatus {
  state: EdgeCameraState;
  error?: string;
  /** Human label of the bound sensor, as reported by the device. */
  sensor?: string;
  /** Negotiated capture geometry — may differ from the requested preset. */
  width?: number;
  height?: number;
  /** Capture rate the driver granted. */
  captureFps?: number;
  torchSupported: boolean;
  torchOn: boolean;
}

export interface EdgeCameraOptions {
  deviceId?: string;
  resolution: EdgeResolution;
  facing?: "environment" | "user";
}

const IDLE: EdgeCameraStatus = { state: "idle", torchSupported: false, torchOn: false };

function friendlyError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera permission denied. Allow camera access for this site, then retry.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera matched this request. Pick another sensor or a lower resolution.";
  if (name === "NotReadableError")
    return "The camera is busy in another app. Close it and retry.";
  return err instanceof Error && err.message ? err.message : "Camera could not be started.";
}

export class EdgeCamera {
  private stream: MediaStream | null = null;
  private status: EdgeCameraStatus = IDLE;
  private listeners = new Set<(s: EdgeCameraStatus, stream: MediaStream | null) => void>();

  subscribe(fn: (s: EdgeCameraStatus, stream: MediaStream | null) => void) {
    this.listeners.add(fn);
    fn(this.status, this.stream);
    return () => this.listeners.delete(fn);
  }

  private emit(next: Partial<EdgeCameraStatus>) {
    this.status = { ...this.status, ...next };
    for (const fn of this.listeners) fn(this.status, this.stream);
  }

  get supported() {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  /** Sensors visible to the page; labels only populate after a grant. */
  async devices(): Promise<EdgeCameraDevice[]> {
    if (!this.supported || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  async start(opts: EdgeCameraOptions): Promise<MediaStream | null> {
    if (!this.supported) {
      this.emit({ state: "error", error: "This device exposes no camera API." });
      return null;
    }
    this.stop();
    this.emit({ state: "starting", error: undefined });

    const preset = EDGE_RESOLUTIONS[opts.resolution];
    const video: MediaTrackConstraints = {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: 30 },
      ...(opts.deviceId
        ? { deviceId: { exact: opts.deviceId } }
        : { facingMode: { ideal: opts.facing ?? "environment" } }),
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() ?? {};
      const caps =
        typeof track?.getCapabilities === "function"
          ? (track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean })
          : {};
      this.emit({
        state: "streaming",
        error: undefined,
        ...(track?.label ? { sensor: track.label } : {}),
        ...(settings.width ? { width: settings.width } : {}),
        ...(settings.height ? { height: settings.height } : {}),
        ...(settings.frameRate ? { captureFps: Math.round(settings.frameRate) } : {}),
        torchSupported: !!caps.torch,
        torchOn: false,
      });
      track?.addEventListener("ended", () => {
        this.emit({ state: "error", error: "Camera stream ended unexpectedly." });
      });
      return stream;
    } catch (err) {
      this.stream = null;
      this.emit({ state: "error", error: friendlyError(err), torchSupported: false, torchOn: false });
      return null;
    }
  }

  /** Night-run headlamp: only available where the driver exposes the torch. */
  async setTorch(on: boolean) {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.status.torchSupported) return false;
    try {
      await track.applyConstraints({
        advanced: [{ torch: on }],
      } as MediaTrackConstraints);
      this.emit({ torchOn: on });
      return true;
    } catch {
      this.emit({ torchSupported: false, torchOn: false });
      return false;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.status = { ...IDLE };
    for (const fn of this.listeners) fn(this.status, null);
  }
}
