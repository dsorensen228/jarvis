import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  cameraSnapshotUrl,
  fetchCameras,
  type CameraRow,
} from '../api';

export function CamerasPage({ cameraDeviceId, suspended = false }: {
  cameraDeviceId?: string;
  suspended?: boolean;
}) {
  const { deviceId: routeDeviceId } = useParams<{ deviceId?: string }>();
  const deviceId = cameraDeviceId ?? routeDeviceId;
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [listRevision, setListRevision] = useState(0);
  const [feedRevision, setFeedRevision] = useState(0);
  const [cams, setCams] = useState<CameraRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const list = await fetchCameras();
        if (cancelled) return;
        setCams(list);
        setErr(null);
      } catch {
        if (!cancelled) setErr('Could not load cameras');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listRevision]);

  useEffect(() => {
    if (!suspended && !deviceId && cams.length > 0) {
      navigate(`/cameras/${encodeURIComponent(cams[0].id)}`, { replace: true });
    }
  }, [deviceId, cams, navigate, suspended]);

  const selectedId = deviceId ?? cams[0]?.id ?? null;

  useEffect(() => {
    if (suspended) return;
    let cancelled = false;
    let refreshTimer: number | null = null;
    let currentFrameUrl: string | null = null;
    let request: AbortController | null = null;

    const schedule = (delay: number) => {
      refreshTimer = window.setTimeout(() => void loadFrame(), delay);
    };
    const loadFrame = async () => {
      if (!selectedId || cancelled) return;
      request = new AbortController();
      // Let the device proxy finish its 30-second upstream request before retrying.
      const timeout = window.setTimeout(() => request?.abort(), 35000);
      try {
        const response = await fetch(cameraSnapshotUrl(selectedId, Date.now()), {
          cache: 'no-store',
          signal: request.signal,
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
        setLoadErr('Camera unavailable');
        schedule(2000);
      } finally {
        window.clearTimeout(timeout);
      }
    };

    setLoadErr(null);
    setFrameUrl(null);
    void loadFrame();
    return () => {
      cancelled = true;
      request?.abort();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      if (currentFrameUrl) URL.revokeObjectURL(currentFrameUrl);
    };
  }, [selectedId, suspended, feedRevision]);

  const pick = (id: string) => {
    navigate(`/cameras/${encodeURIComponent(id)}`);
  };

  if (err) {
    return (
      <div className="page cameras">
        <div className="cameras-stream-area">
          <div className="camera-status" role="status">
            <span>{err}</span>
            <button type="button" onClick={() => setListRevision(v => v + 1)}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page cameras">
      <div className="cameras-tabs-bar">
        <div className="cameras-tabs-scroll" role="tablist" aria-label="Cameras">
          {cams.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === selectedId}
              title={c.device_name || c.id}
              className={`cam-item ${c.id === selectedId ? 'active' : ''}`}
              onClick={() => pick(c.id)}
            >
              {c.device_name || c.id}
            </button>
          ))}
        </div>
      </div>
      <div className="cameras-stream-area">
        {!selectedId && <div className="camera-status" role="status">
          <span>{loading ? 'Loading cameras…' : 'No cameras'}</span>
          {!loading && <button type="button" onClick={() => setListRevision(v => v + 1)}>Refresh</button>}
        </div>}
        {selectedId && !frameUrl && !loadErr && <div className="camera-status" role="status">Connecting…</div>}
        {loadErr && <div className="camera-status" role="status">
          <span>{loadErr}{frameUrl ? ' · Last frame' : ''}</span>
          <button type="button" onClick={() => setFeedRevision(v => v + 1)}>Retry</button>
        </div>}
        {selectedId && frameUrl && (
          <div className={`cameras-stream-inner${loadErr ? ' cameras-stream-inner--stale' : ''}`}>
            <img
              className="cam-stream"
              src={frameUrl}
              alt={cams.find(c => c.id === selectedId)?.device_name || selectedId}
              draggable={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
