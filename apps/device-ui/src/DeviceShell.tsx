import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, type Location } from 'react-router-dom';
import { DeviceTopChrome } from './DeviceTopChrome';
import { SystemVolumeProvider } from './SystemVolumeContext';
import { SpotifyPlayerProvider } from './spotify/SpotifyPlayerContext';
import { SpotifyBrowseProvider } from './spotify/SpotifyBrowseContext';
import { SpotifyFavoritesProvider } from './spotify/SpotifyFavoritesContext';
import { useVoiceTurn } from './VoiceTurnContext';
import { fetchConfig } from './api';
import { useCameraPreview } from './useCameraPreview';
import { CamerasPage } from './pages/CamerasPage';

/** Return to the standby screen when the kiosk is idle; does not unmount music/timer providers. */
const STANDBY_IDLE_MS = 5 * 60 * 1000;

function IconHome() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1v-9.5z"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMusic() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 3v12.2a3.8 3.8 0 1 0 2 3.3V7h4V3h-6z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8h2l1.5-2h5L14 8h4a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2v-8a2 2 0 012-2z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="14" r="3.25" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function IconTimer() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="13" r="7" stroke="currentColor" strokeWidth="1.75" />
      <path d="M12 9v4.5l3 2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconTv() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path d="M8 21h8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconCode() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path d="M7 9l3 3-3 3M12 16h5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function VoiceActiveChip() {
  const { pathname } = useLocation();
  const { voiceTurn, connecting, requestVoiceTap } = useVoiceTurn();
  if (pathname === '/standby') return null;
  if (!voiceTurn && !connecting) return null;
  const label = connecting && !voiceTurn ? 'Starting…' : 'Listening — tap to stop';
  return (
    <button
      type="button"
      className="voice-active-chip tap-target"
      onClick={requestVoiceTap}
      aria-label="Stop voice chat"
    >
      <span className="voice-active-chip-dot" aria-hidden />
      {label}
    </button>
  );
}

function JarvisUnreachableBanner() {
  const { jarvisUnreachable } = useVoiceTurn();
  if (!jarvisUnreachable) return null;
  return (
    <div className="jarvis-unreachable-banner" role="status" aria-live="polite">
      Can't reach Jarvis
    </div>
  );
}

export function DeviceShell({ children }: {
  children: (location: Location, previewActive: boolean) => ReactNode;
}) {
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();
  const { voiceTurn } = useVoiceTurn();
  const idleTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const pathnameRef = useRef(pathname);
  const voiceTurnRef = useRef(voiceTurn);
  const reportReadingRef = useRef(false);
  const browserWindowRef = useRef<Window | null>(null);
  const [codingTasksEnabled, setCodingTasksEnabled] = useState(false);
  const [musicTabEnabled, setMusicTabEnabled] = useState<boolean | null>(null);
  pathnameRef.current = pathname;
  voiceTurnRef.current = voiceTurn;

  useEffect(() => {
    let current = true;
    void fetchConfig()
      .then((config) => {
        if (!current) return;
        setCodingTasksEnabled(config.coding_tasks_enabled === true);
        setMusicTabEnabled(config.music_tab_enabled === true);
      })
      .catch(() => {
        if (current) setMusicTabEnabled(false);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (musicTabEnabled !== false) return;
    if (pathname === '/spotify' || pathname.startsWith('/spotify/')) {
      navigate('/standby', { replace: true });
    }
  }, [musicTabEnabled, pathname, navigate]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const scheduleStandbyOnIdle = useCallback(() => {
    clearIdleTimer();
    if (voiceTurnRef.current || reportReadingRef.current) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (voiceTurnRef.current || reportReadingRef.current) return;
      if (pathnameRef.current !== '/standby') {
        navigate('/standby', { replace: true });
      }
    }, STANDBY_IDLE_MS);
  }, [clearIdleTimer, navigate]);

  const cameraPreview = useCameraPreview(scheduleStandbyOnIdle);

  useEffect(() => {
    const reading = (event: Event) => {
      reportReadingRef.current = (event as CustomEvent<{ active: boolean }>).detail.active;
      scheduleStandbyOnIdle();
    };
    window.addEventListener('jarvis-report-reading', reading);
    return () => window.removeEventListener('jarvis-report-reading', reading);
  }, [scheduleStandbyOnIdle]);

  useEffect(() => {
    const onActivity = () => scheduleStandbyOnIdle();
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', onActivity, opts);
    window.addEventListener('keydown', onActivity, opts);
    scheduleStandbyOnIdle();
    return () => {
      window.removeEventListener('pointerdown', onActivity, opts);
      window.removeEventListener('keydown', onActivity, opts);
      clearIdleTimer();
    };
  }, [scheduleStandbyOnIdle, clearIdleTimer]);

  useEffect(() => {
    if (voiceTurn) {
      clearIdleTimer();
    } else {
      scheduleStandbyOnIdle();
    }
  }, [voiceTurn, clearIdleTimer, scheduleStandbyOnIdle]);

  useEffect(() => {
    const onJarvisAction = (event: Event) => {
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!payload || payload.type !== 'client_action') return;
      const action = String(payload.action || '');
      const args = (payload.args as Record<string, unknown>) || {};

      if (action === 'navigate_device_ui') {
        const destination = String(args.destination || '');
        if (destination === 'spotify' && musicTabEnabled !== true) return;
        const routes: Record<string, string> = {
          standby: '/standby',
          spotify: '/spotify',
          timer: '/timer',
          timer_alarms: '/timer/alarms',
          tv: '/tv',
          cameras: '/cameras',
        };
        let route = routes[destination];
        const cameraId = String(args.camera_device_id || '').trim();
        if (destination === 'cameras' && cameraId) {
          route = `/cameras/${encodeURIComponent(cameraId)}`;
        }
        if (route) navigate(route);
        return;
      }

      if (action === 'browser_open') {
        const raw = String(args.url || '');
        try {
          const url = new URL(raw);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
          const opened = window.open(url.toString(), 'jarvis-browse');
          if (opened) {
            opened.opener = null;
            browserWindowRef.current = opened;
            opened.focus();
          }
        } catch {
          /* Reject malformed or non-web URLs from device actions. */
        }
        return;
      }

      if (action === 'browser_close') {
        browserWindowRef.current?.close();
        browserWindowRef.current = null;
        window.focus();
      }
    };
    window.addEventListener('jarvis-device-action', onJarvisAction);
    return () => window.removeEventListener('jarvis-device-action', onJarvisAction);
  }, [navigate, musicTabEnabled]);

  const camerasActive = pathname === '/cameras' || pathname.startsWith('/cameras/');
  const musicActive = pathname === '/spotify' || pathname.startsWith('/spotify/');
  return (
    <SystemVolumeProvider>
      <SpotifyPlayerProvider>
        <SpotifyBrowseProvider>
          <SpotifyFavoritesProvider>
        <div className={`device-shell${cameraPreview ? ' device-shell--camera-preview' : ''}`}>
          <JarvisUnreachableBanner />
          <DeviceTopChrome />
          <main className="device-shell-main">
            <div style={{ display: cameraPreview ? 'none' : 'contents' }}>
              {children(cameraPreview?.returnLocation ?? location, cameraPreview !== null)}
            </div>
            {cameraPreview && <CamerasPage cameraDeviceId={cameraPreview.cameraDeviceId} />}
          </main>
          <VoiceActiveChip />
          <nav className="bottom-nav" aria-label="Main">
            <NavLink
              to="/standby"
              aria-label="Home"
              className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
              end
            >
              <IconHome />
            </NavLink>
            {musicTabEnabled === true ? (
              <Link to="/spotify" aria-label="Music" aria-current={musicActive ? 'page' : undefined} className={`bottom-nav-item${musicActive ? ' active' : ''}`}>
                <IconMusic />
              </Link>
            ) : null}
            <Link to="/cameras" aria-label="Cameras" aria-current={camerasActive ? 'page' : undefined} className={`bottom-nav-item${camerasActive ? ' active' : ''}`}>
              <IconCamera />
            </Link>
            <NavLink
              to="/tv"
              aria-label="TV"
              className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
            >
              <IconTv />
            </NavLink>
            <NavLink
              to="/timer"
              aria-label="Timer"
              className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
            >
              <IconTimer />
            </NavLink>
            {codingTasksEnabled ? (
              <NavLink
                to="/code"
                aria-label="Code"
                className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
              >
                <IconCode />
              </NavLink>
            ) : null}
          </nav>
        </div>
          </SpotifyFavoritesProvider>
        </SpotifyBrowseProvider>
      </SpotifyPlayerProvider>
    </SystemVolumeProvider>
  );
}
