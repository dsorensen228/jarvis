import { Link } from 'react-router-dom';
import {
  isPaused,
  trackLabel,
  useSpotifyPlayer,
  SPOTIFY_MISSING_LABEL,
} from '../spotify/SpotifyPlayerContext';

function IconSearch() {
  return (
    <svg className="spotify-hub-search-svg" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="M15 15l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlayerBlock({
  tl,
  paused,
  onTransport,
}: {
  tl: ReturnType<typeof trackLabel>;
  paused: boolean;
  onTransport: (a: 'toggle' | 'next' | 'prev') => void | Promise<void>;
}) {
  return (
    <>
      {tl && (
        <div className="spotify-now-playing">
          <div className="spotify-track-title">{tl.title}</div>
          <div className="spotify-track-artist">{tl.artist}</div>
        </div>
      )}
      <div className="spotify-transport">
        <button
          type="button"
          className="spotify-transport-btn"
          aria-label="Previous track"
          onClick={() => void onTransport('prev')}
        >
          <svg className="spotify-transport-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
          </svg>
        </button>
        <button
          type="button"
          className="spotify-transport-btn spotify-transport-play"
          aria-label={paused ? 'Play' : 'Pause'}
          onClick={() => void onTransport('toggle')}
        >
          {paused ? (
            <svg className="spotify-transport-play-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg className="spotify-transport-play-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="spotify-transport-btn"
          aria-label="Next track"
          onClick={() => void onTransport('next')}
        >
          <svg className="spotify-transport-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M16 18h2V6h-2v12zM6 18l8.5-6L6 6v12z" />
          </svg>
        </button>
      </div>
    </>
  );
}

export function SpotifyNowPage() {
  const {
    cfg,
    err,
    sdkOffline,
    playerState,
    isReady,
    connectSpotify,
    disconnect,
    onTransport,
  } = useSpotifyPlayer();

  const tl = trackLabel(playerState);
  const paused = isPaused(playerState);

  const spotifyMissing = cfg?.spotify_missing?.length
    ? cfg.spotify_missing.map((k) => SPOTIFY_MISSING_LABEL[k] || k).join(' · ')
    : null;

  if (err && !cfg) {
    return (
      <div className="page spotify spotify--setup">
        <p className="error-text">{err}</p>
      </div>
    );
  }

  if (isReady) {
    return (
      <div className="page spotify spotify--hub">
        <header className="spotify-hub-header">
          <div className="spotify-hub-actions">
            <Link to="/spotify/search" className="spotify-hub-icon-btn" aria-label="Search Spotify">
              <IconSearch />
            </Link>
            <details className="spotify-hub-menu">
              <summary className="spotify-hub-menu-trigger" aria-label="Account menu">
                ···
              </summary>
              <div className="spotify-hub-menu-panel">
                <button type="button" className="spotify-hub-menu-item" onClick={() => disconnect()}>
                  Sign out (this device)
                </button>
              </div>
            </details>
          </div>
        </header>
        {err && <p className="error-text spotify-hub-banner">{err}</p>}
        {sdkOffline && (
          <p className="spotify-offline-banner" role="status">
            Offline — check Spotify Connect
          </p>
        )}
        <div className="spotify-hub-body">
          <PlayerBlock tl={tl} paused={paused} onTransport={onTransport} />
        </div>
      </div>
    );
  }

  return (
    <div className="page spotify spotify--setup">
      {err && <p className="error-text">{err}</p>}
      {!cfg?.spotify_client_id && (
        <p className="muted">Set spotify_client_id in jarvis_device config to enable Web Playback.</p>
      )}
      {cfg?.spotify_client_id && cfg.spotify_ready === false && (
        <p className="muted small spotify-voice-hint">
          {spotifyMissing ? `Missing: ${spotifyMissing}` : 'Web API not configured on device.'}
        </p>
      )}
      {cfg?.spotify_client_id && !cfg.spotify_ready && (
        <button type="button" className="primary-btn" onClick={connectSpotify}>
          Connect Spotify
        </button>
      )}
    </div>
  );
}
