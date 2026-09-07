import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Camera,
  Gauge,
  MapPin,
  MessageSquare,
  Radio,
  Send,
  Smartphone,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { AccentBadge, Panel, PanelHeader, glass } from "@/components/hud/panel";
import { Viewfinder, type CaptureEvent, type EngineStats } from "@/components/dashcam/Viewfinder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ACCENT_CLASSES, CITY_CENTER } from "@/data/fleet";
import {
  HAZARD_META,
  VEHICLE_CLASS_LABEL,
  formatCoord,
  istStamp,
  type VehicleClass,
} from "@/lib/dashcam-engine";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashcam")({
  head: () => ({
    meta: [
      { title: "Live Dashcam & Multi-Hazard Inspection Hub — Urban Intel" },
      {
        name: "description",
        content:
          "Live phone-camera and uploaded dashcam analysis with multi-hazard detection, ALPR, latency HUD and SMS alert dispatch for Jamshedpur transport fleets.",
      },
      {
        property: "og:title",
        content: "Live Dashcam & Multi-Hazard Inspection Hub — Urban Intel",
      },
      {
        property: "og:description",
        content:
          "Edge-AI dashcam node: road defects, vehicle density, pedestrian risk and hit-and-run ALPR with one-tap command dispatch.",
      },
    ],
  }),
  component: DashcamPage,
});

const COUNTRY_CODES = [
  { code: "+91", label: "India (+91)" },
  { code: "+1", label: "USA (+1)" },
  { code: "+44", label: "UK (+44)" },
  { code: "+971", label: "UAE (+971)" },
  { code: "+65", label: "Singapore (+65)" },
];

const MAX_BYTES = 200 * 1024 * 1024;
const ACCEPTED = [".mp4", ".webm", ".mov"];
const BUS_ID = "FLEET-BUS-04";

const TAB =
  "border border-transparent text-zinc-400 data-[state=active]:border-emerald-400/40 data-[state=active]:bg-emerald-400/10 data-[state=active]:text-emerald-400 data-[state=active]:shadow-none";

function DashcamPage() {
  const [mode, setMode] = useState<"live" | "upload">("live");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [threshold, setThreshold] = useState(72);
  const [stats, setStats] = useState<EngineStats>({
    fps: 0,
    latencyMs: 0,
    detections: [],
    status: "idle",
    model: "URBAN-INTEL EDGE-VISION",
    meanConfidence: 0,
    frameSuccessRate: 0,
    framesSampled: 0,
    detectionsScored: 0,
  });
  const [captures, setCaptures] = useState<CaptureEvent[]>([]);
  const [reviews, setReviews] = useState<Record<string, "correct" | "wrong">>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [geo, setGeo] = useState<{ lat: number; lng: number; live: boolean; accuracy?: number }>({
    lat: CITY_CENTER[0],
    lng: CITY_CENTER[1],
    live: false,
  });
  const [dialCode, setDialCode] = useState("+91");
  const [phone, setPhone] = useState("9876543210");
  const [instant, setInstant] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastDispatchRef = useRef<string | null>(null);
  const [clock, setClock] = useState<Date | null>(null);

  useEffect(() => {
    setClock(new Date());
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // GPS telemetry
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        setGeo({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          live: true,
          accuracy: pos.coords.accuracy,
        }),
      () => setGeo({ lat: CITY_CENTER[0], lng: CITY_CENTER[1], live: false }),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Live camera
  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    let local: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        local = s;
        setCamError(null);
        setStream(s);
      })
      .catch(() =>
        setCamError(
          "Camera access denied or unavailable. Grant permission, or switch to uploaded footage.",
        ),
      );
    return () => {
      cancelled = true;
      local?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [mode]);

  const handleFile = useCallback((file: File) => {
    const ok = ACCEPTED.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!ok) {
      toast.error("Unsupported file", { description: "Use .mp4, .webm or .mov footage." });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File too large", { description: "Maximum dashcam clip size is 200MB." });
      return;
    }
    setFileUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setFileName(`${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`);
  }, []);

  const onCapture = useCallback((c: CaptureEvent) => {
    setCaptures((prev) => [c, ...prev].slice(0, 24));
    setSelectedId((cur) => cur ?? c.id);
  }, []);

  const active = mode === "live" ? !!stream : !!fileUrl;
  const visible = useMemo(
    () => stats.detections.filter((d) => d.confidence >= threshold),
    [stats.detections, threshold],
  );

  // Live perception quality: model confidence weighted by how many sampled frames it read.
  const liveQuality = useMemo(() => {
    if (!stats.framesSampled || !stats.detectionsScored) return null;
    return (stats.meanConfidence * stats.frameSuccessRate) / 100;
  }, [stats.framesSampled, stats.detectionsScored, stats.meanConfidence, stats.frameSuccessRate]);

  // Verified accuracy: reviewer-confirmed correct rate over reviewed captures.
  const verified = useMemo(() => {
    const marks = Object.values(reviews);
    if (!marks.length) return null;
    const correct = marks.filter((m) => m === "correct").length;
    return { rate: (correct / marks.length) * 100, reviewed: marks.length, correct };
  }, [reviews]);


  const vehicleCounts = useMemo(() => {
    const base: Record<VehicleClass, number> = { car: 0, bus: 0, truck: 0, two_wheeler: 0 };
    for (const d of visible) if (d.kind === "vehicle" && d.vehicleClass) base[d.vehicleClass] += 1;
    return base;
  }, [visible]);

  const totalVehicles = Object.values(vehicleCounts).reduce((a, b) => a + b, 0);
  const bottleneck = totalVehicles >= 5;
  const criticalLive = visible.filter((d) => HAZARD_META[d.kind].group === "critical");
  const defectsLive = visible.filter((d) => HAZARD_META[d.kind].group === "defect");
  const schoolRisk = visible.some((d) => d.kind === "school_zone");

  const selected = useMemo(
    () => captures.find((c) => c.id === selectedId) ?? captures[0] ?? null,
    [captures, selectedId],
  );

  const payload = useMemo(() => {
    const type = selected ? HAZARD_META[selected.kind].alertType : "Standby — No Event Selected";
    const lat = selected?.lat ?? geo.lat;
    const lng = selected?.lng ?? geo.lng;
    const plate = selected?.plate
      ? `${selected.plate} (Conf: ${selected.confidence.toFixed(1)}%)`
      : `UNRESOLVED (Conf: ${selected ? selected.confidence.toFixed(1) : "0.0"}%)`;
    return [
      "🚨 URBAN INTEL CRITICAL ALERT",
      `Type: ${type}`,
      `Vehicle/Plate: ${plate}`,
      `Location: ${formatCoord(lat, lng)}`,
      `Maps Link: https://maps.google.com/?q=${lat.toFixed(4)},${lng.toFixed(4)}`,
      `Timestamp: ${selected ? istStamp(new Date(selected.at)) : clock ? istStamp(clock) : "awaiting gps clock sync"}`,
      `Bus ID: ${BUS_ID}`,
    ].join("\n");
  }, [selected, geo.lat, geo.lng, clock]);

  const dispatch = useCallback(() => {
    toast.success("Alert Transmitted to Central Command & Target Phone", {
      description: `${dialCode} ${phone} · ${istStamp()}`,
    });
  }, [dialCode, phone]);

  // Instant Alert Mode auto-dispatches new critical captures.
  useEffect(() => {
    if (!instant) return;
    const latest = captures[0];
    if (!latest || lastDispatchRef.current === latest.id) return;
    if (HAZARD_META[latest.kind].group !== "critical") return;
    lastDispatchRef.current = latest.id;
    toast.error("Instant Alert dispatched", {
      description: `${HAZARD_META[latest.kind].alertType} · ${latest.plate ?? "no plate"} → ${dialCode} ${phone}`,
    });
  }, [captures, instant, dialCode, phone]);

  const smsHref = `sms:${dialCode}${phone.replace(/\D/g, "")}?body=${encodeURIComponent(payload)}`;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <Panel className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
              Live Dashcam &amp; Multi-Hazard Inspection Hub
            </h1>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-500">
              edge sensor node · {BUS_ID} · cam-front-02
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AccentBadge accent={geo.live ? "emerald" : "amber"} pulse={geo.live}>
              {geo.live ? "gps lock" : "gps fallback"}
            </AccentBadge>
            <span className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 font-mono text-[11px] text-zinc-300">
              {formatCoord(geo.lat, geo.lng)}
            </span>
            <AccentBadge accent={active ? "emerald" : "rose"} pulse={active}>
              {active ? "inference running" : "idle"}
            </AccentBadge>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Panel className="p-3 sm:p-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as "live" | "upload")}>
              <TabsList className="w-full bg-zinc-950/70 backdrop-blur-xl">
                <TabsTrigger value="live" className={cn("flex-1 gap-2 text-xs", TAB)}>
                  <Radio className="size-3.5" /> Live Phone Camera Feed
                </TabsTrigger>
                <TabsTrigger value="upload" className={cn("flex-1 gap-2 text-xs", TAB)}>
                  <Upload className="size-3.5" /> Upload Dashcam Footage
                </TabsTrigger>
              </TabsList>

              <TabsContent value="live" className="mt-3">
                {camError ? (
                  <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 font-mono text-[11px] text-amber-400">
                    {camError}
                  </p>
                ) : null}
              </TabsContent>

              <TabsContent value="upload" className="mt-3">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) handleFile(f);
                  }}
                  className={cn(
                    "mb-3 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
                    dragging
                      ? "border-emerald-400/60 bg-emerald-400/5"
                      : "border-zinc-700/80 bg-zinc-950/50",
                  )}
                >
                  <Upload className="size-5 text-zinc-500" />
                  <p className="text-sm text-zinc-300">Drag &amp; drop dashcam footage here</p>
                  <p className="font-mono text-[11px] text-zinc-500">
                    .mp4 · .webm · .mov · max 200MB
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 border-zinc-700 bg-zinc-950/60 text-zinc-200 hover:bg-zinc-900 hover:text-zinc-50"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Browse files
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFile(f);
                    }}
                  />
                  {fileName ? (
                    <p className="font-mono text-[11px] text-emerald-400">{fileName}</p>
                  ) : null}
                </div>
              </TabsContent>
            </Tabs>

            <div className="relative">
              <Viewfinder
                active={active}
                stream={mode === "live" ? stream : null}
                fileUrl={mode === "upload" ? fileUrl : null}
                threshold={threshold}
                lat={geo.lat}
                lng={geo.lng}
                onStats={setStats}
                onCapture={onCapture}
              />

              {/* Performance HUD */}
              <div
                className={cn(
                  glass,
                  "pointer-events-none absolute left-3 top-3 rounded-lg px-3 py-2 font-mono text-[10px] leading-relaxed sm:text-[11px]",
                )}
              >
                <div
                  className={cn(
                    "flex items-center gap-1.5",
                    stats.status === "error" ? "text-rose-500" : "text-emerald-400",
                  )}
                >
                  <Gauge className="size-3" /> INFERENCE:{" "}
                  {stats.latencyMs ? stats.latencyMs.toFixed(0) : "—"} MS ·{" "}
                  {stats.status === "live"
                    ? "MODEL LOCK"
                    : stats.status === "warming"
                      ? "WARMING"
                      : stats.status === "error"
                        ? "DEGRADED"
                        : "IDLE"}
                </div>
                <div className="text-zinc-300">
                  {stats.fps.toFixed(1)} FPS RENDER · {stats.model}
                </div>
                <div className="text-amber-400">
                  ACCURACY:{" "}
                  {liveQuality === null ? "CALIBRATING" : `${liveQuality.toFixed(1)}% LIVE`}
                  {" · "}
                  {verified
                    ? `${verified.rate.toFixed(1)}% VERIFIED (${verified.reviewed})`
                    : "0 REVIEWED"}
                </div>
                <div className="text-zinc-500">
                  FRAMES READ {stats.frameSuccessRate.toFixed(0)}% OF {stats.framesSampled}
                </div>
                <div className="text-zinc-500">THRESH {threshold}% · OBJECTS {visible.length}</div>

              </div>

              {/* Live tallies */}
              <div
                className={cn(
                  glass,
                  "pointer-events-none absolute right-3 top-3 hidden rounded-lg px-3 py-2 font-mono text-[11px] sm:block",
                )}
              >
                <div className="text-emerald-400">VEHICLES {totalVehicles}</div>
                <div className="text-amber-400">DEFECTS {defectsLive.length}</div>
                <div className="text-rose-500">CRITICAL {criticalLive.length}</div>
              </div>

              {schoolRisk ? (
                <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 font-mono text-[11px] text-rose-500">
                  <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-rose-500" />
                  SCHOOL CHILDREN CROSSING ZONE — SLOW DOWN
                </div>
              ) : null}
              {bottleneck ? (
                <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 font-mono text-[11px] text-emerald-400">
                  TRAFFIC BOTTLENECK — DENSITY HIGH
                </div>
              ) : null}
              {stats.error ? (
                <div className="absolute inset-x-3 bottom-12 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 font-mono text-[11px] text-rose-400">
                  PERCEPTION ERROR · {stats.error}
                </div>
              ) : stats.scene ? (
                <div className="pointer-events-none absolute inset-x-3 bottom-12 truncate rounded-md border border-zinc-800/80 bg-zinc-950/70 px-3 py-1.5 font-mono text-[11px] text-zinc-400">
                  SCENE · {stats.scene}
                </div>
              ) : null}
            </div>


            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <Label className="font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-400">
                  Confidence threshold · {threshold}%
                </Label>
                <Slider
                  className="mt-3"
                  min={50}
                  max={95}
                  step={1}
                  value={[threshold]}
                  onValueChange={(v) => setThreshold(v[0] ?? 72)}
                />
                <p className="mt-2 font-mono text-[10px] text-zinc-500">
                  filters detections below sensitivity · 50% – 95%
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(Object.keys(VEHICLE_CLASS_LABEL) as VehicleClass[]).map((k) => (
                  <div
                    key={k}
                    className="rounded-md border border-emerald-400/20 bg-emerald-400/5 px-2 py-2 text-center"
                  >
                    <p className="font-mono text-lg text-emerald-400">{vehicleCounts[k]}</p>
                    <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                      {VEHICLE_CLASS_LABEL[k]}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          {/* Live detection ledger */}
          <Panel>
            <PanelHeader
              title="Live Detection Stack"
              meta={`${visible.length} tracked objects above threshold`}
            />
            <div className="max-h-52 divide-y divide-zinc-800/70 overflow-y-auto">
              {visible.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[11px] text-zinc-500">
                  awaiting detections…
                </p>
              ) : (
                visible.map((d) => {
                  const meta = HAZARD_META[d.kind];
                  return (
                    <div key={d.id} className="flex items-center gap-3 px-4 py-2">
                      <AccentBadge accent={meta.accent} pulse={meta.group === "critical"}>
                        {meta.group}
                      </AccentBadge>
                      <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                        {d.kind === "vehicle" && d.vehicleClass
                          ? VEHICLE_CLASS_LABEL[d.vehicleClass]
                          : meta.label}
                      </span>
                      {d.plate ? (
                        <span className="font-mono text-[11px] text-rose-400">{d.plate}</span>
                      ) : null}
                      {d.speedKph ? (
                        <span className="font-mono text-[11px] text-zinc-500">
                          {d.speedKph} km/h
                        </span>
                      ) : null}
                      <span
                        className={cn("font-mono text-[11px]", ACCENT_CLASSES[meta.accent].text)}
                      >
                        {d.confidence.toFixed(1)}%
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </Panel>

          {/* Capture drawer */}
          <Panel>
            <PanelHeader
              title="Captured Incidents & Event History"
              meta={`${captures.length} snapshots · mark each read correct or wrong to build the verified accuracy score`}
            />
            <div className="flex gap-3 overflow-x-auto px-4 py-4">
              {captures.length === 0 ? (
                <p className="font-mono text-[11px] text-zinc-500">
                  no captures yet — defects and critical events snapshot automatically
                </p>
              ) : (
                captures.map((c) => {
                  const meta = HAZARD_META[c.kind];
                  const mark = reviews[c.id];
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "w-52 shrink-0 overflow-hidden rounded-lg border bg-zinc-950/60 text-left transition-colors",
                        selected?.id === c.id
                          ? "border-emerald-400/60"
                          : "border-zinc-800 hover:border-zinc-700",
                      )}
                    >
                      <button onClick={() => setSelectedId(c.id)} className="block w-full text-left">
                        <img
                          src={c.image}
                          alt={`${meta.label} snapshot`}
                          width={208}
                          height={117}
                          loading="lazy"
                          className="h-28 w-full object-cover"
                        />
                        <div className="space-y-1 p-2">
                          <AccentBadge accent={meta.accent}>{meta.alertType}</AccentBadge>
                          <p className="font-mono text-[10px] text-zinc-400">
                            {formatCoord(c.lat, c.lng)}
                          </p>
                          <p className="font-mono text-[10px] text-zinc-500">
                            {istStamp(new Date(c.at))}
                          </p>
                          <p
                            className={cn(
                              "font-mono text-[10px]",
                              ACCENT_CLASSES[meta.accent].text,
                            )}
                          >
                            conf {c.confidence.toFixed(1)}%{c.plate ? ` · ${c.plate}` : ""}
                          </p>
                        </div>
                      </button>
                      <div className="flex gap-1 border-t border-zinc-800/70 p-2">
                        <button
                          onClick={() =>
                            setReviews((prev) => ({ ...prev, [c.id]: "correct" }))
                          }
                          className={cn(
                            "flex-1 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                            mark === "correct"
                              ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-400"
                              : "border-zinc-800 text-zinc-500 hover:text-zinc-300",
                          )}
                        >
                          Correct
                        </button>
                        <button
                          onClick={() => setReviews((prev) => ({ ...prev, [c.id]: "wrong" }))}
                          className={cn(
                            "flex-1 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                            mark === "wrong"
                              ? "border-rose-500/60 bg-rose-500/10 text-rose-500"
                              : "border-zinc-800 text-zinc-500 hover:text-zinc-300",
                          )}
                        >
                          Wrong
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

          </Panel>
        </div>

        {/* Dispatch panel */}
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Central Command Dispatch" meta="sms + command payload routing" />
            <div className="space-y-4 p-4">
              <div>
                <Label className="font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-400">
                  Target alert number
                </Label>
                <div className="mt-2 flex gap-2">
                  <Select value={dialCode} onValueChange={setDialCode}>
                    <SelectTrigger className="w-[132px] font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COUNTRY_CODES.map((c) => (
                        <SelectItem key={c.code} value={c.code} className="font-mono text-xs">
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={phone}
                    inputMode="tel"
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="9876543210"
                    className="font-mono text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-3">
                <div>
                  <p className="text-xs font-medium text-zinc-200">
                    {instant ? "Instant Alert Mode" : "Manual Operator Review"}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                    {instant
                      ? "critical events auto-dispatch on detection"
                      : "operator confirms every transmission"}
                  </p>
                </div>
                <Switch checked={instant} onCheckedChange={setInstant} />
              </div>

              <div>
                <Label className="font-mono text-[11px] uppercase tracking-[0.16em] text-zinc-400">
                  Payload preview
                </Label>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                  {payload}
                </pre>
              </div>

              <div className="space-y-2">
                <Button className="w-full gap-2" onClick={dispatch}>
                  <Send className="size-4" /> Send Alert to Command &amp; SMS
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="w-full gap-2 border-zinc-700 bg-zinc-950/60 text-zinc-200 hover:bg-zinc-900 hover:text-zinc-50"
                >
                  <a href={smsHref}>
                    <MessageSquare className="size-4" /> Direct Mobile SMS Deep-Link
                  </a>
                </Button>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Node Telemetry" meta="edge device health" />
            <dl className="divide-y divide-zinc-800/70">
              {[
                { k: "Source", v: mode === "live" ? "PHONE REAR CAMERA" : "UPLOADED CLIP", i: Camera },
                { k: "GPS accuracy", v: geo.accuracy ? `±${geo.accuracy.toFixed(0)} m` : "FALLBACK", i: MapPin },
                { k: "Inference", v: `${stats.latencyMs.toFixed(1)} ms`, i: Activity },
                { k: "Frame rate", v: `${stats.fps.toFixed(1)} fps`, i: Gauge },
                {
                  k: "Live accuracy",
                  v: liveQuality === null ? "calibrating" : `${liveQuality.toFixed(1)}%`,
                  i: Gauge,
                },
                {
                  k: "Verified accuracy",
                  v: verified
                    ? `${verified.rate.toFixed(1)}% (${verified.correct}/${verified.reviewed})`
                    : "no reviews yet",
                  i: Activity,
                },

                { k: "Dispatch route", v: `${dialCode} ${phone || "—"}`, i: Smartphone },
              ].map((row) => (
                <div key={row.k} className="flex items-center gap-3 px-4 py-2.5">
                  <row.i className="size-3.5 text-zinc-500" />
                  <dt className="flex-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    {row.k}
                  </dt>
                  <dd className="font-mono text-[11px] text-zinc-200">{row.v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
