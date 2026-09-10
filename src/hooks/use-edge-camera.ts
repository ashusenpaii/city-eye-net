import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EdgeCamera,
  type EdgeCameraDevice,
  type EdgeCameraStatus,
  type EdgeResolution,
} from "@/lib/edge-camera";

/** React binding for the standalone edge camera module. */
export function useEdgeCamera(enabled: boolean) {
  const cameraRef = useRef<EdgeCamera | null>(null);
  const camera = useMemo(() => {
    if (!cameraRef.current) cameraRef.current = new EdgeCamera();
    return cameraRef.current;
  }, []);

  const [status, setStatus] = useState<EdgeCameraStatus>({
    state: "idle",
    torchSupported: false,
    torchOn: false,
  });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<EdgeCameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [resolution, setResolution] = useState<EdgeResolution>("720p");

  useEffect(
    () =>
      camera.subscribe((s, str) => {
        setStatus(s);
        setStream(str);
      }),
    [camera],
  );

  // Bind / rebind the sensor whenever the module is enabled or retuned.
  useEffect(() => {
    if (!enabled) {
      camera.stop();
      return;
    }
    let cancelled = false;
    void camera
      .start({ resolution, ...(deviceId ? { deviceId } : {}) })
      .then(async () => {
        if (cancelled) return;
        setDevices(await camera.devices());
      });
    return () => {
      cancelled = true;
      camera.stop();
    };
  }, [camera, enabled, deviceId, resolution]);

  const setTorch = useCallback((on: boolean) => void camera.setTorch(on), [camera]);

  return {
    stream,
    status,
    devices,
    deviceId,
    setDeviceId,
    resolution,
    setResolution,
    setTorch,
    supported: camera.supported,
  };
}
