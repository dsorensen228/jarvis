import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useSpotifyPlayer } from '../spotify/SpotifyPlayerContext';
import { useSpotifyFavorites } from '../spotify/SpotifyFavoritesContext';
import { SpotifyCoverArt } from '../spotify/SpotifyTiles';
import { PlaybackIcon } from '../spotify/SpotifyMiniPlayer';
import { formatPlaybackTime, playbackPosition, readPlaybackState } from '../spotify/playerState';
import '../spotify/player.css';

export function SpotifyNowPage() {
  const {
    cfg, err, sdkReady, sdkOffline, playerState, stateUpdatedAt, isReady, canControl,
    pendingAction, connectSpotify, disconnect, retryConnection, onTransport, seek,
    setShuffle, setRepeat, playItem,
  } = useSpotifyPlayer();
  const { favorites, toggleFavorite, isFavorite } = useSpotifyFavorites();
  const state = readPlaybackState(playerState);
  const track = state.track;
  const [clock, setClock] = useState(Date.now);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [showAllFavorites, setShowAllFavorites] = useState(false);
  const seekPreviewRef = useRef<number | null>(null);
  const favoritesRef = useRef<HTMLElement | null>(null);
  const trackUri = track?.uri;

  useEffect(() => {
    setClock(Date.now());
    if (state.paused || !trackUri || sdkOffline) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.paused, trackUri, stateUpdatedAt, sdkOffline]);

  useEffect(() => {
    seekPreviewRef.current = null;
    setSeekPreview(null);
  }, [trackUri]);

  const blocked = !canControl || Boolean(pendingAction);
  const position = seekPreview ?? playbackPosition(state, stateUpdatedAt, sdkOffline ? stateUpdatedAt : clock);
  const deviceName = cfg?.spotify_player_name || cfg?.device_id || 'This device';
  const nextRepeat = state.repeat === 'off' ? 'context' : state.repeat === 'context' ? 'track' : 'off';
  const repeatLabel = state.repeat === 'track' ? 'Repeat one' : state.repeat === 'context' ? 'Repeat all' : 'Repeat off';

  const commitSeek = () => {
    const value = seekPreviewRef.current;
    if (value === null) return;
    seekPreviewRef.current = null;
    void seek(value).finally(() => setSeekPreview(null));
  };

  if (!isReady) {
    return (
      <section className="page sp-setup" aria-label="Connect Spotify">
        <div className="sp-setup-symbol"><PlaybackIcon kind="play" /></div>
        <p className="sp-eyebrow">Spotify on Jarvis</p>
        <h1>{!cfg && !err ? 'Getting music ready…' : !cfg && err ? 'Music is unavailable' : cfg?.spotify_client_id ? 'Your music. Right here.' : 'Spotify needs a little setup'}</h1>
        <p className="sp-setup-description">
          {!cfg && !err ? 'Checking the connection to this device.' : !cfg && err ? 'We couldn’t reach the music service on this device.' : cfg?.spotify_client_id ? 'Connect your Spotify account to search, save favorites, and listen on this device.' : 'Enable Spotify in this device’s configuration, then come back here to connect your account.'}
        </p>
        {err && <p className="sp-setup-error" role="alert">{err}</p>}
        {cfg?.spotify_client_id ? (
          <button type="button" className="sp-button sp-button--primary" onClick={connectSpotify}>Connect Spotify</button>
        ) : err || cfg ? (
          <button type="button" className="sp-button" onClick={retryConnection}>Try again</button>
        ) : <span className="sp-loading" role="status" aria-label="Loading Spotify" />}
        {cfg?.spotify_client_id && <p className="sp-setup-footnote">Playback requires Spotify Premium.</p>}
      </section>
    );
  }

  return (
    <section className="page sp-now" aria-label="Spotify player">
      <header className="sp-now-header">
        <div className="sp-now-heading">
          <h1>Now playing</h1>
          <p className={`sp-device${sdkOffline ? ' sp-device--offline' : !sdkReady ? ' sp-device--connecting' : ''}`}>
            <span className="sp-device-dot" aria-hidden="true" />
            <span>{sdkOffline ? 'Connection interrupted' : sdkReady ? deviceName : 'Connecting to Spotify…'}</span>
          </p>
        </div>
        <nav className="sp-now-actions" aria-label="Music">
          {favorites.length > 0 && <button type="button" className="sp-button sp-button--quiet sp-favorites-jump" aria-label={`View ${favorites.length} device favorites`} onClick={() => {
            favoritesRef.current?.focus({ preventScroll: true });
            favoritesRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
          }}><PlaybackIcon kind="star" /><span>Favorites <small>{favorites.length}</small></span></button>}
          <Link to="/spotify/queue" className="sp-button sp-button--quiet sp-up-next" aria-label="Up next"><PlaybackIcon kind="queue" /><span>Up next</span></Link>
          <Link to="/spotify/search" className="sp-button" aria-label="Search Spotify"><PlaybackIcon kind="search" /><span>Search</span></Link>
          <details className="sp-account">
            <summary aria-label="Spotify account menu">···</summary>
            <div className="sp-account-panel">
              <span>Spotify on this device</span>
              <button type="button" onClick={() => disconnect()}>Sign out of Spotify</button>
            </div>
          </details>
        </nav>
      </header>

      {(err || sdkOffline) && (
        <div className="sp-notice" role={err ? 'alert' : 'status'}>
          <span>{err || 'Spotify is offline. Reconnect to use playback controls.'}</span>
          <button type="button" onClick={retryConnection}>Retry</button>
        </div>
      )}

      <div className={`sp-now-scroll${favorites.length ? ' sp-now-scroll--favorites' : ''}`}>
        {track ? (
          <section className="sp-now-content" aria-label="Current track">
            <div className="sp-now-art"><SpotifyCoverArt src={track.image} /></div>
            <div className="sp-now-details">
              <div className="sp-track-heading">
                <div className="sp-track-copy">
                  <h2 title={track.title}>{track.title}</h2>
                  <p className="sp-track-artist" title={track.artist}>{track.artist}</p>
                </div>
                {track.uri && <button type="button" className="sp-icon-button sp-favorite" aria-label={isFavorite(track.uri) ? 'Remove from device favorites' : 'Save to device favorites'} aria-pressed={isFavorite(track.uri)} onClick={() => toggleFavorite({ uri: track.uri, name: track.title, subtitle: track.artist, image: track.image, kind: 'track' })}>
                  <PlaybackIcon kind="star" />
                </button>}
              </div>
              {track.album && <p className="sp-track-album" title={track.album}>{track.album}</p>}

              <div className="sp-progress">
                <input
                  type="range" min="0" max={state.duration || 1} step="1000" value={Math.min(position, state.duration || 1)}
                  className="sp-seek" aria-label="Playback position" aria-valuetext={`${formatPlaybackTime(position)} of ${formatPlaybackTime(state.duration)}`}
                  disabled={blocked || state.disallows.seeking || !state.duration}
                  style={{ '--sp-progress': `${state.duration ? position / state.duration * 100 : 0}%` } as CSSProperties}
                  onChange={(event) => { const value = Number(event.target.value); seekPreviewRef.current = value; setSeekPreview(value); }}
                  onPointerUp={commitSeek}
                  onPointerCancel={() => { seekPreviewRef.current = null; setSeekPreview(null); }}
                  onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitSeek(); }}
                  onBlur={commitSeek}
                />
                <div className="sp-progress-times" aria-hidden="true"><span>{formatPlaybackTime(position)}</span><span>{formatPlaybackTime(state.duration)}</span></div>
              </div>

              <div className="sp-controls" aria-label="Playback controls" aria-busy={Boolean(pendingAction)}>
                <button type="button" className="sp-icon-button sp-mode" aria-label={state.shuffle ? 'Turn shuffle off' : 'Turn shuffle on'} aria-pressed={state.shuffle} disabled={blocked || state.disallows.toggling_shuffle} onClick={() => void setShuffle(!state.shuffle)}><PlaybackIcon kind="shuffle" /></button>
                <button type="button" className="sp-transport" aria-label="Previous track" disabled={blocked || state.disallows.skipping_prev} onClick={() => void onTransport('prev')}><PlaybackIcon kind="prev" /></button>
                <button type="button" className="sp-transport sp-transport--play" aria-label={state.paused ? 'Play' : 'Pause'} disabled={blocked || state.disallows[state.paused ? 'resuming' : 'pausing']} onClick={() => void onTransport('toggle')}><PlaybackIcon kind={state.paused ? 'play' : 'pause'} /></button>
                <button type="button" className="sp-transport" aria-label="Next track" disabled={blocked || state.disallows.skipping_next} onClick={() => void onTransport('next')}><PlaybackIcon kind="next" /></button>
                <button type="button" className="sp-icon-button sp-mode" aria-label={`${repeatLabel}; ${nextRepeat === 'context' ? 'repeat all' : nextRepeat === 'track' ? 'repeat one track' : 'turn repeat off'}`} aria-pressed={state.repeat !== 'off'} disabled={blocked || state.disallows[nextRepeat === 'track' ? 'toggling_repeat_track' : 'toggling_repeat_context']} onClick={() => void setRepeat(nextRepeat)}><PlaybackIcon kind="repeat" />{state.repeat === 'track' && <span className="sp-repeat-one" aria-hidden="true">1</span>}</button>
              </div>
              <span className="sp-action-status" role="status">{pendingAction ? 'Updating playback…' : ''}</span>
            </div>
          </section>
        ) : (
          <section className="sp-now-empty">
            <div className="sp-empty-art"><SpotifyCoverArt src={null} /></div>
            <div className="sp-empty-copy">
              <p className="sp-eyebrow">Your listening space</p>
              <h2>{sdkOffline ? 'Let’s get reconnected' : sdkReady ? 'Ready when you are' : 'Connecting your music…'}</h2>
              <p>{sdkOffline ? 'Your Spotify account is still connected. Retry to bring this player back online.' : sdkReady ? 'Find a song, album, artist, or playlist. Play it here, or choose this device in Spotify Connect.' : 'Getting this device ready for Spotify Connect. Your music will appear here.'}</p>
              <Link to="/spotify/search" className="sp-button sp-button--primary"><PlaybackIcon kind="search" />Find something to play</Link>
            </div>
          </section>
        )}

        {favorites.length > 0 && (
          <section className="sp-quick-picks" aria-label="Device favorites" ref={favoritesRef} tabIndex={-1}>
            <div className="sp-section-heading">
              <div><h2>Your favorites</h2><span>Saved on this device</span></div>
              {favorites.length > 6 && <button type="button" className="sp-button sp-button--quiet" aria-expanded={showAllFavorites} aria-controls="spotify-favorites" onClick={() => setShowAllFavorites(!showAllFavorites)}>{showAllFavorites ? 'Show fewer' : `Show all ${favorites.length}`}</button>}
            </div>
            <div className="sp-quick-grid" id="spotify-favorites">
              {(showAllFavorites ? favorites : favorites.slice(0, 6)).map((item) => <div key={item.uri} className="sp-quick-card">
                <button type="button" className="sp-quick-pick" disabled={blocked} onClick={() => void playItem(item)} aria-label={`Play ${item.name}`}>
                  <SpotifyCoverArt src={item.image} /><span><strong>{item.name}</strong><small>{item.subtitle || item.kind}</small></span>
                </button>
                <button type="button" className="sp-icon-button sp-favorite" aria-label={`Remove ${item.name} from device favorites`} aria-pressed="true" onClick={() => toggleFavorite(item)}><PlaybackIcon kind="star" /></button>
              </div>)}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
