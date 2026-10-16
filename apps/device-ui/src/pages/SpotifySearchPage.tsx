import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SpotifySearchItem } from '../api';
import { SpotifyCoverArt } from '../spotify/SpotifyTiles';
import { SPOTIFY_MISSING_LABEL, useSpotifyPlayer } from '../spotify/SpotifyPlayerContext';
import { SPOTIFY_SEARCH_CATEGORIES, useSpotifyBrowse } from '../spotify/SpotifyBrowseContext';
import { useSpotifyFavorites } from '../spotify/SpotifyFavoritesContext';
import { SpotifyMiniPlayer } from '../spotify/SpotifyMiniPlayer';
import { editSearchText } from '../spotify/searchText';
import { OnScreenKeyboard } from '../ui/OnScreenKeyboard';
import '../spotify/search.css';

function currentTrackUri(state: unknown): string | undefined {
  return (state as { track_window?: { current_track?: { uri?: string } } } | null)?.track_window?.current_track?.uri;
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill={filled ? 'currentColor' : 'none'} aria-hidden>
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function SpotifySearchPage() {
  const { cfg, err, sdkOffline, retryConnection, canControl, pendingAction, playItem, addToQueue, playerState } = useSpotifyPlayer();
  const {
    query, setQuery, category, selectCategory, items, loading, error, searchedQuery,
    recentSearches, clearRecentSearches, search, clearSearch,
  } = useSpotifyBrowse();
  const { isFavorite, toggleFavorite } = useSpotifyFavorites();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedAction, setSelectedAction] = useState<{ uri: string; action: 'play' | 'queue' } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const spotifyReady = cfg?.spotify_ready === true;
  const spotifyMissing = cfg?.spotify_missing?.length
    ? cfg.spotify_missing.map((key) => SPOTIFY_MISSING_LABEL[key] || key).join(' · ')
    : null;
  const activeUri = currentTrackUri(playerState);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const hideKeyboard = () => {
    setKeyboardOpen(false);
    inputRef.current?.blur();
  };
  const submitSearch = () => {
    hideKeyboard();
    setNotice('');
    void search();
  };
  const editAtCaret = (text: string | null) => {
    const input = inputRef.current;
    const result = editSearchText(query, input?.selectionStart ?? query.length, input?.selectionEnd ?? query.length, text);
    setQuery(result.value.slice(0, 200));
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      const caret = Math.min(result.caret, 200);
      input?.setSelectionRange(caret, caret);
    });
  };
  const onItemAction = async (item: SpotifySearchItem, action: 'play' | 'queue') => {
    if (pendingAction || selectedAction) return;
    setNotice('');
    setSelectedAction({ uri: item.uri, action });
    try {
      const ok = action === 'play' ? await playItem(item) : await addToQueue(item);
      if (ok && mountedRef.current) {
        setNotice(action === 'play' ? `Playing ${item.name}` : `Added ${item.name} to queue`);
      }
    } finally {
      if (mountedRef.current) setSelectedAction(null);
    }
  };

  return (
    <div className={`page spotify spotify--search spotify-search-workspace${keyboardOpen ? ' spotify-search-workspace--keyboard' : ''}`}>
      <header className="spotify-search-topbar">
        <Link to="/spotify" className="spotify-search-return" aria-label="Back to Now playing">←</Link>
        <h1>Find your next listen</h1>
        <span className="spotify-search-eyebrow">SPOTIFY</span>
      </header>
      {!spotifyReady ? (
        <div className="spotify-search-empty">
          <h2>Connect your music</h2>
          <p>{spotifyMissing || 'Connect Spotify on this device to start searching.'}</p>
          <Link to="/spotify" className="spotify-search-link">Go to Music →</Link>
        </div>
      ) : (
        <>
          <form className="spotify-search-form" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
            <div className="spotify-search-field">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
                <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                role="searchbox"
                inputMode="search"
                enterKeyHint="search"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={200}
                className="spotify-search-input"
                placeholder="Songs, artists, albums, playlists"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setKeyboardOpen(true)}
                onBlur={() => setKeyboardOpen(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { event.preventDefault(); hideKeyboard(); }
                }}
                aria-label="Search Spotify"
              />
              {query && (
                <button
                  type="button"
                  className="spotify-search-clear"
                  aria-label="Clear search"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => { clearSearch(); setNotice(''); inputRef.current?.focus(); }}
                >×</button>
              )}
            </div>
            <button type="submit" className="spotify-search-submit" disabled={!query.trim()}>Search</button>
          </form>
          <div className="spotify-search-filters" role="group" aria-label="Search categories">
            {SPOTIFY_SEARCH_CATEGORIES.map((option) => (
              <button
                type="button"
                key={option.value}
                aria-pressed={category === option.value}
                onClick={() => { hideKeyboard(); setNotice(''); selectCategory(option.value); }}
              >{option.label}</button>
            ))}
          </div>
          <div className="spotify-search-results" aria-busy={loading}>
            {sdkOffline ? (
              <div className="spotify-search-alert spotify-search-connection" role="status">
                <span>{err || 'Spotify is offline. Reconnect to play on this device.'}</span>
                <button type="button" className="spotify-search-secondary" onClick={retryConnection}>Retry connection</button>
              </div>
            ) : err && <p className="spotify-search-alert" role="alert">{err}</p>}
            {notice && <p className="spotify-search-notice" role="status">✓ {notice}</p>}
            {loading ? (
              <div className="spotify-search-empty" role="status">
                <span className="spotify-search-spinner" aria-hidden />
                <p>Searching for “{searchedQuery}”…</p>
              </div>
            ) : error ? (
              <div className="spotify-search-empty" role="alert">
                <h2>Search couldn't load</h2>
                <p>{error}</p>
                <button className="spotify-search-secondary" type="button" onClick={() => void search(searchedQuery)}>Try again</button>
              </div>
            ) : searchedQuery && !items.length ? (
              <div className="spotify-search-empty" role="status">
                <h2>No matches for “{searchedQuery}”</h2>
                <p>Try a different spelling or search another category.</p>
                {category !== 'all' && <button className="spotify-search-secondary" type="button" onClick={() => selectCategory('all')}>Search everything</button>}
              </div>
            ) : items.length ? (
              <>
                <div className="spotify-search-results-heading">
                  <span>{items.length} results for <strong>“{searchedQuery}”</strong></span>
                  {!canControl ? <span>{sdkOffline ? 'Player offline' : 'Player connecting…'}</span>
                    : !activeUri && <span>Play something here to start a queue</span>}
                </div>
                <ul className="spotify-search-catalog">
                  {items.map((item) => {
                    const favorite = isFavorite(item.uri);
                    const selected = selectedAction?.uri === item.uri;
                    const active = activeUri === item.uri;
                    return (
                      <li className={`spotify-result${active ? ' spotify-result--active' : ''}`} key={item.uri}>
                        <button
                          type="button"
                          className="spotify-result-play"
                          aria-label={`Play ${item.kind} ${item.name}${item.subtitle ? ` by ${item.subtitle}` : ''}`}
                          disabled={!canControl || Boolean(pendingAction) || Boolean(selectedAction)}
                          onClick={() => void onItemAction(item, 'play')}
                        >
                          <SpotifyCoverArt src={item.image} />
                          <span className="spotify-result-label">
                            <span className="spotify-result-kind">{selected && selectedAction.action === 'play' ? 'Starting…' : active ? 'Now playing' : item.kind === 'track' ? 'Track' : item.kind}</span>
                            <span className="spotify-result-title">{item.name}</span>
                            {item.subtitle && <span className="spotify-result-subtitle">{item.subtitle}</span>}
                          </span>
                        </button>
                        <div className="spotify-result-actions">
                          <button
                            type="button"
                            className={`spotify-result-action${favorite ? ' spotify-result-action--saved' : ''}`}
                            aria-label={`${favorite ? 'Remove' : 'Save'} ${item.name} ${favorite ? 'from' : 'to'} favorites on this device`}
                            aria-pressed={favorite}
                            title={favorite ? 'Remove favorite' : 'Save on this device'}
                            onClick={() => toggleFavorite(item)}
                          ><StarIcon filled={favorite} /></button>
                          {item.kind === 'track' && (
                            <button
                              type="button"
                              className="spotify-result-action"
                              aria-label={`Add ${item.name} to queue`}
                              title={activeUri ? 'Add to queue' : 'Start music on this device to add to its queue'}
                              disabled={!canControl || !activeUri || Boolean(pendingAction) || Boolean(selectedAction)}
                              onClick={() => void onItemAction(item, 'queue')}
                            >{selected && selectedAction.action === 'queue' ? '…' : <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden><path d="M4 6h12M4 11h9M4 16h7M18 12v8m-4-4h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>}</button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <div className="spotify-search-discovery">
                {recentSearches.length ? (
                  <>
                    <div className="spotify-search-recent-heading">
                      <h2>Recent searches</h2>
                      <button type="button" onClick={clearRecentSearches}>Clear history</button>
                    </div>
                    <div className="spotify-search-recents">
                      {recentSearches.map((recent) => (
                        <button type="button" key={recent} onClick={() => { hideKeyboard(); void search(recent); }}>
                          <span aria-hidden>↶</span><span>{recent}</span><span aria-hidden>↗</span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="spotify-search-empty">
                    <h2>A song, a mood, an old favorite.</h2>
                    <p>Find something to play. Save favorites here for one-tap listening from Music.</p>
                  </div>
                )}
              </div>
            )}
          </div>
          {!keyboardOpen && <SpotifyMiniPlayer />}
          <OnScreenKeyboard
            open={keyboardOpen}
            compact
            onChar={editAtCaret}
            onBackspace={() => editAtCaret(null)}
            onSubmit={submitSearch}
            submitDisabled={!query.trim()}
            onDismiss={hideKeyboard}
          />
        </>
      )}
    </div>
  );
}
