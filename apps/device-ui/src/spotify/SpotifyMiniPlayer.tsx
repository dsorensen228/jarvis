import { Link } from 'react-router-dom';
import { useSpotifyPlayer } from './SpotifyPlayerContext';
import { SpotifyCoverArt } from './SpotifyTiles';
import { readPlaybackState } from './playerState';
import './player.css';

export function PlaybackIcon({ kind }: { kind: 'play' | 'pause' | 'next' | 'prev' | 'search' | 'shuffle' | 'repeat' | 'queue' | 'star' }) {
  const paths: Record<typeof kind, string> = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
    prev: 'M6 6h2v12H6zm3.5 6L18 6v12z',
    next: 'M16 6h2v12h-2zM6 6l8.5 6L6 18z',
    search: '',
    shuffle: 'M3 6h3l12 12h3m-4-4 4 4-4 4M3 18h3l4-4m4-4 4-4h3m-4-4 4 4-4 4',
    repeat: 'm18 2 4 4-4 4M2 11V9a3 3 0 0 1 3-3h17M6 22l-4-4 4-4m16-1v2a3 3 0 0 1-3 3H2',
    queue: 'M3 5h18M3 11h18M3 17h10m5-2 4 3-4 3z',
    star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
  };
  const outlined = ['search', 'shuffle', 'repeat', 'queue', 'star'].includes(kind);
  return (
    <svg viewBox="0 0 24 24" fill={outlined ? 'none' : 'currentColor'} stroke={outlined ? 'currentColor' : undefined} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'search' ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></> : <path d={paths[kind]} />}
    </svg>
  );
}

/** Keeps playback one tap away while browsing. The provider lives above all Music routes. */
export function SpotifyMiniPlayer() {
  const { playerState, canControl, pendingAction, onTransport, sdkOffline } = useSpotifyPlayer();
  const state = readPlaybackState(playerState);
  if (!state.track) return null;
  const blocked = !canControl || Boolean(pendingAction);
  return (
    <aside className="sp-mini" aria-label="Now playing">
      <Link to="/spotify" className="sp-mini-track" aria-label={`Now playing: ${state.track.title} by ${state.track.artist}`}>
        <SpotifyCoverArt src={state.track.image} />
        <span className="sp-mini-copy">
          <strong>{state.track.title}</strong>
          <span>{sdkOffline ? 'Reconnecting to Spotify…' : state.track.artist}</span>
        </span>
      </Link>
      <button type="button" className="sp-mini-button" aria-label={state.paused ? 'Play' : 'Pause'} aria-busy={pendingAction === 'toggle'} disabled={blocked || state.disallows[state.paused ? 'resuming' : 'pausing']} onClick={() => void onTransport('toggle')}>
        <PlaybackIcon kind={state.paused ? 'play' : 'pause'} />
      </button>
      <button type="button" className="sp-mini-button" aria-label="Next track" disabled={blocked || state.disallows.skipping_next} onClick={() => void onTransport('next')}>
        <PlaybackIcon kind="next" />
      </button>
    </aside>
  );
}
