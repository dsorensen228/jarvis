import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchSpotifyQueue, type SpotifySearchItem } from '../api';
import { useSpotifyPlayer } from '../spotify/SpotifyPlayerContext';
import { useSpotifyFavorites } from '../spotify/SpotifyFavoritesContext';
import { SpotifyMiniPlayer } from '../spotify/SpotifyMiniPlayer';
import { SpotifyCoverArt } from '../spotify/SpotifyTiles';
import '../spotify/queue.css';

export function SpotifyQueuePage() {
  const { playerDeviceId, playerState, canControl, pendingAction, retryConnection, sdkOffline } = useSpotifyPlayer();
  const { toggleFavorite, isFavorite } = useSpotifyFavorites();
  const [items, setItems] = useState<SpotifySearchItem[]>([]);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const previousPending = useRef(pendingAction);
  const previousIdentity = useRef('');
  const trackUri = (playerState as { track_window?: { current_track?: { uri?: string } } } | null)
    ?.track_window?.current_track?.uri;

  useEffect(() => {
    if (previousPending.current && !pendingAction && ['play', 'next', 'prev', 'queue', 'shuffle', 'repeat'].includes(previousPending.current)) {
      setRevision((n) => n + 1);
    }
    previousPending.current = pendingAction;
  }, [pendingAction]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    const identity = JSON.stringify([playerDeviceId, canControl, trackUri]);
    if (previousIdentity.current !== identity) {
      setItems([]);
      setActive(false);
      previousIdentity.current = identity;
    }
    setError(null);
    if (!playerDeviceId || !canControl || !trackUri) {
      setLoading(false);
      return () => controller.abort();
    }
    const load = async (initial = false) => {
      if (inFlight || controller.signal.aborted || document.hidden) return;
      inFlight = true;
      if (initial) setLoading(true);
      try {
        const queue = await fetchSpotifyQueue(playerDeviceId, controller.signal);
        if (controller.signal.aborted) return;
        setItems(queue.items);
        setActive(queue.active);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Could not load your queue.');
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          // Keep the existing queue visible between refreshes.
        }
      }
    };
    const poll = async () => {
      await load();
      if (!controller.signal.aborted) timer = setTimeout(poll, 20_000);
    };
    const visible = () => { if (!document.hidden) void load(); };
    void load(true);
    timer = setTimeout(poll, 20_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [playerDeviceId, canControl, trackUri, revision]);

  return (
    <section className="sq-page" aria-label="Spotify queue">
      <header className="sq-header">
        <Link to="/spotify" className="sq-button">← Now playing</Link>
        <h1>Up next</h1>
        <button type="button" className="sq-button" disabled={loading || !canControl || !trackUri}
          onClick={() => setRevision((n) => n + 1)} aria-label="Refresh queue">Refresh</button>
      </header>
      <div className="sq-body" aria-busy={loading}>
        {sdkOffline ? (
          <div className="sq-empty" role="status">
            <h2>Reconnect to see what’s next</h2>
            <p>Your music and sign-in are still saved.</p>
            <button type="button" className="sq-button sq-button--primary" onClick={retryConnection}>Retry connection</button>
          </div>
        ) : loading && !items.length ? <p className="sq-message" role="status">Loading your queue…</p>
          : error && !items.length ? (
            <div className="sq-empty" role="alert">
              <h2>Couldn’t load the queue</h2><p>{error}</p>
              <button type="button" className="sq-button" onClick={() => setRevision((n) => n + 1)}>Try again</button>
            </div>
          ) : !active ? (
            <div className="sq-empty">
              <h2>Start something here</h2>
              <p>Play music on this device to see its upcoming tracks.</p>
              <Link to="/spotify/search" className="sq-button sq-button--primary">Find music</Link>
            </div>
          ) : items.length === 0 ? (
            <div className="sq-empty">
              <h2>Make room for your next favorite</h2>
              <p>Your queue is empty. Add tracks from search without interrupting the music.</p>
              <Link to="/spotify/search" className="sq-button sq-button--primary">Add music</Link>
            </div>
          ) : (
            <>
              {error && <div className="sq-warning" role="alert"><span>Couldn’t refresh. Showing the last queue.</span><button type="button" className="sq-button" onClick={() => setRevision((n) => n + 1)}>Try again</button></div>}
              <div className="sq-intro"><p>Coming up on this device</p><Link to="/spotify/search" className="sq-button">＋ Add music</Link></div>
              <ol className="sq-list" aria-label="Upcoming tracks">
                {items.map((item, index) => (
                  <li key={`${item.uri}-${index}`} className="sq-track">
                    <span className="sq-number" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
                    <SpotifyCoverArt src={item.image} />
                    <div className="sq-track-copy"><strong>{item.name}</strong><span>{item.subtitle}</span></div>
                    {index === 0 && <span className="sq-next-label">Next</span>}
                    <button type="button" className="sq-favorite" aria-pressed={isFavorite(item.uri)}
                      aria-label={`${isFavorite(item.uri) ? 'Remove' : 'Save'} ${item.name} ${isFavorite(item.uri) ? 'from' : 'to'} favorites`}
                      onClick={() => toggleFavorite(item)}>{isFavorite(item.uri) ? '★' : '☆'}</button>
                  </li>
                ))}
              </ol>
            </>
          )}
      </div>
      <SpotifyMiniPlayer />
    </section>
  );
}
