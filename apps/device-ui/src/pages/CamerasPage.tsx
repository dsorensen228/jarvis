import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  cameraSnapshotUrl,
  fetchCameras,
  fetchConfig,
  type CameraRow,
  type UiConfig,
} from '../api';

export function CamerasPage() {
  const { deviceId } = useParams<{ deviceId?: string }>();
  const navigate = useNavigate();
  const [cfg, setCfg] = useState<UiConfig | null>(null);
  const [cams, setCams] = useState<CameraRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, list] = await Promise.all([fetchConfig(), fetchCameras()]);
        if (cancelled) return;
        setCfg(c);
        setCams(list);
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!deviceId && cams.length > 0) {
      navigate(`/cameras/${encodeURIComponent(cams[0].id)}`, { replace: true });
    }
  }, [deviceId, cams, navigate]);

  const selectedId = deviceId ?? cams[0]?.id ?? null;
  const roomHasLight = Boolean((cfg?.room_name || '').trim());

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | null = null;
    let currentFrameUrl: string | null = null;

    const schedule = (delay: number) => {
      refreshTimer = window.setTimeout(() => void loadFrame(), delay);
    };
    const loadFrame = async () => {
      if (!selectedId || cancelled) return;
      try {
        const response = await fetch(cameraSnapshotUrl(selectedId, Date.now()), {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`camera frame ${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        try {
          await new Promise<void>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('camera frame decode failed'));
            image.src = objectUrl;
          });
        } catch (error) {
          URL.revokeObjectURL(objectUrl);
          throw error;
        }
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        const previousFrameUrl = currentFrameUrl;
        currentFrameUrl = objectUrl;
        setFrameUrl(objectUrl);
        if (previousFrameUrl) {
          window.requestAnimationFrame(() => URL.revokeObjectURL(previousFrameUrl));
        }
        setLoadErr(null);
        schedule(250);
      } catch (error) {
        if (cancelled) return;
        setLoadErr(error instanceof Error ? `${error.message}; reconnecting` : 'camera frame failed');
        schedule(2000);
      }
    };

    setLoadErr(null);
    setFrameUrl(null);
    void loadFrame();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (currentFrameUrl) URL.revokeObjectURL(currentFrameUrl);
    };
  }, [selectedId]);

  const pick = (id: string) => {
    navigate(`/cameras/${encodeURIComponent(id)}`);
  };

  if (err) {
    return (
      <div className="page cameras">
        <p className="error-text">{err}</p>
      </div>
    );
  }

  return (
    <div className="page cameras">
      <div
        className={`cameras-tabs-bar${roomHasLight ? ' cameras-tabs-bar--lights' : ''}`}
      >
        <div className="cameras-tabs-scroll" role="tablist" aria-label="Cameras">
          {cams.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === selectedId}
              className={`cam-item ${c.id === selectedId ? 'active' : ''}`}
              onClick={() => pick(c.id)}
            >
              {c.device_name || c.id}
            </button>
          ))}
        </div>
      </div>
      <div className="cameras-stream-area">
        {!selectedId && <p className="muted">No cameras</p>}
        {loadErr && <p className="error-text">{loadErr}</p>}
        {selectedId && frameUrl && (
          <div className="cameras-stream-inner">
            <img
              className="cam-stream"
              src={frameUrl}
              alt=""
              draggable={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
