import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';

const CAMERA_PREVIEW_MS = 10_000;

type CameraPreview = {
  cameraDeviceId: string;
  returnLocation: Location;
  token: number;
};

/** Keep the original screen alive until the latest door alert expires or navigation takes over. */
export function useCameraPreview(onActivity: () => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<CameraPreview | null>(null);
  const current = useRef({ location, navigate, onActivity });
  const previewRef = useRef<CameraPreview | null>(null);
  const timerRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  current.current = { location, navigate, onActivity };

  useLayoutEffect(() => {
    // A fresh history entry (even for the same camera) is an intentional navigation.
    if (previewRef.current && location.state?.cameraPreview !== previewRef.current.token) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      previewRef.current = null;
      setPreview(null);
    }
  }, [location]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      if (payload?.type !== 'client_action' || payload.action !== 'show_camera_preview') return;
      const args = payload.args as Record<string, unknown> | undefined;
      const cameraDeviceId = args?.camera_device_id;
      if (typeof cameraDeviceId !== 'string' || !cameraDeviceId.trim()) return;

      const next: CameraPreview = {
        cameraDeviceId: cameraDeviceId.trim(),
        returnLocation: previewRef.current?.returnLocation ?? current.current.location,
        token: ++sequenceRef.current,
      };
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      previewRef.current = next;
      setPreview(next);
      current.current.onActivity();
      current.current.navigate(`/cameras/${encodeURIComponent(next.cameraDeviceId)}`, {
        replace: true,
        state: { cameraPreview: next.token },
      });
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const { location: latest, navigate: go, onActivity: activity } = current.current;
        if (latest.state?.cameraPreview !== next.token) return;
        // Navigation may be a React transition. Keep the background frozen until the
        // location effect observes the return, or it would briefly mount the camera.
        go(next.returnLocation, { replace: true, state: next.returnLocation.state });
        activity();
      }, CAMERA_PREVIEW_MS);
    };
    window.addEventListener('jarvis-device-action', onAction);
    return () => {
      window.removeEventListener('jarvis-device-action', onAction);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  return preview;
}
