import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchSpotifySearch, postSpotifyPlay, type SpotifySearchItem } from '../api';
import { SpotifyCoverArt } from '../spotify/SpotifyTiles';
import { SPOTIFY_MISSING_LABEL, useSpotifyPlayer } from '../spotify/SpotifyPlayerContext';
import { OnScreenKeyboard } from '../ui/OnScreenKeyboard';

export function SpotifySearchPage() {
  const { cfg } = useSpotifyPlayer();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [browseQ, setBrowseQ] = useState('');
  const [browseItems, setBrowseItems] = useState<SpotifySearchItem[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseErr, setBrowseErr] = useState<string | null>(null);
  const [playFromBrowseErr, setPlayFromBrowseErr] = useState<string | null>(null);
  const [playingUri, setPlayingUri] = useState<string | null>(null);

  const spotifyReady = cfg?.spotify_ready === true;
  const spotifyMissing = cfg?.spotify_missing?.length
    ? cfg.spotify_missing.map((k) => SPOTIFY_MISSING_LABEL[k] || k).join(' · ')
    : null;

  const runBrowseSearch = useCallback(() => {
    const q = browseQ.trim();
    if (!q) {
      setBrowseErr(null);
      setBrowseItems([]);
      return;
    }
    setBrowseErr(null);
    setBrowseLoading(true);
    void (async () => {
      try {
        const items = await fetchSpotifySearch(q, { types: 'album,playlist,track', limit: 8 });
        setBrowseItems(items);
      } catch (e) {
        setBrowseItems([]);
        setBrowseErr(e instanceof Error ? e.message : 'search failed');
      } finally {
        setBrowseLoading(false);
      }
    })();
  }, [browseQ]);

  const onPlayTile = useCallback((uri: string) => {
    setPlayFromBrowseErr(null);
    setPlayingUri(uri);
    void (async () => {
      try {
        await postSpotifyPlay({ spotify_uri: uri });
      } catch (e) {
        setPlayFromBrowseErr(e instanceof Error ? e.message : 'playback failed');
      } finally {
        setPlayingUri(null);
      }
    })();
  }, []);

  return (
    <div className="page spotify spotify--search">
      <header className="spotify-search-header">
        <Link to="/spotify" className="spotify-search-back">
          ← Back
        </Link>
      </header>
      {!spotifyReady && (
        <div className="spotify-search-gate">
          <p className="muted small">
            {spotifyMissing ? `Missing: ${spotifyMissing}` : 'Configure Web API on device.'}
          </p>
          <p className="muted small">Use Music tab to finish setup.</p>
        </div>
      )}
      {spotifyReady && (
        <>
          <div className="spotify-search-body">
            <div className="spotify-search-row">
              <input
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="spotify-search-input"
                placeholder="Albums, playlists, tracks…"
                value={browseQ}
                onChange={(e) => setBrowseQ(e.target.value)}
                onFocus={(e) => {
                  setKeyboardOpen(true);
                  e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }}
                onBlur={() => setKeyboardOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runBrowseSearch();
                  }
                }}
                aria-label="Search Spotify"
              />
              <button type="button" className="spotify-search-btn" onClick={runBrowseSearch} disabled={browseLoading}>
                {browseLoading ? '…' : 'Search'}
              </button>
            </div>
            {browseErr && <p className="error-text spotify-browse-msg">{browseErr}</p>}
            {playFromBrowseErr && <p className="error-text spotify-browse-msg">{playFromBrowseErr}</p>}
            {browseItems.length > 0 && (
              <div className="spotify-grid" role="list">
                {browseItems.map((it) => (
                  <button
                    key={it.uri}
                    type="button"
                    className="spotify-tile"
                    role="listitem"
                    aria-label={`Play ${it.name}`}
                    disabled={playingUri === it.uri}
                    onClick={() => onPlayTile(it.uri)}
                  >
                    <SpotifyCoverArt src={it.image} />
                    <div className="spotify-tile-label">
                      <span className="spotify-tile-title">{it.name}</span>
                      {it.subtitle ? <span className="spotify-tile-sub">{it.subtitle}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <OnScreenKeyboard
            open={keyboardOpen}
            onChar={(c) => setBrowseQ((q) => q + c)}
            onBackspace={() => setBrowseQ((q) => [...q].slice(0, -1).join(''))}
          />
        </>
      )}
    </div>
  );
}
