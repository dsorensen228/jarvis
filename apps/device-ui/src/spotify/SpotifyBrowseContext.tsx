import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchSpotifySearch, type SpotifySearchItem } from '../api';

export const SPOTIFY_SEARCH_CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'track', label: 'Tracks' },
  { value: 'album', label: 'Albums' },
  { value: 'artist', label: 'Artists' },
  { value: 'playlist', label: 'Playlists' },
] as const;

export type SpotifySearchCategory = typeof SPOTIFY_SEARCH_CATEGORIES[number]['value'];
const RECENT_SEARCHES_KEY = 'jarvis.spotify.recent-searches.v1';
const RECENT_SEARCHES_LIMIT = 6;

export function addRecentSearch(previous: string[], query: string): string[] {
  const clean = query.trim().slice(0, 200);
  if (!clean) return previous;
  return [clean, ...previous.filter((item) => item.toLocaleLowerCase() !== clean.toLocaleLowerCase())]
    .slice(0, RECENT_SEARCHES_LIMIT);
}

function loadRecentSearches(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 200)).slice(0, RECENT_SEARCHES_LIMIT);
  } catch {
    return [];
  }
}

interface SpotifyBrowseValue {
  query: string;
  setQuery: (query: string) => void;
  category: SpotifySearchCategory;
  selectCategory: (category: SpotifySearchCategory) => void;
  items: SpotifySearchItem[];
  loading: boolean;
  error: string | null;
  searchedQuery: string;
  recentSearches: string[];
  clearRecentSearches: () => void;
  search: (query?: string, category?: SpotifySearchCategory) => Promise<void>;
  clearSearch: () => void;
}

const SpotifyBrowseContext = createContext<SpotifyBrowseValue | null>(null);

/** Lives with the player so browsing survives Back, other tabs, and the idle screen. */
export function SpotifyBrowseProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SpotifySearchCategory>('all');
  const [items, setItems] = useState<SpotifySearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState(loadRecentSearches);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recentSearches));
    } catch {
      // Storage may be disabled; the current session still retains recent searches.
    }
  }, [recentSearches]);

  useEffect(() => () => {
    generationRef.current += 1;
    requestRef.current?.abort();
  }, []);

  const clearSearch = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setQuery('');
    setSearchedQuery('');
    setItems([]);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const clear = () => {
      clearSearch();
      setRecentSearches([]);
    };
    window.addEventListener('jarvis-spotify-disconnected', clear);
    return () => window.removeEventListener('jarvis-spotify-disconnected', clear);
  }, [clearSearch]);

  const search = useCallback(async (nextQuery = query, nextCategory = category) => {
    const clean = nextQuery.trim();
    if (!clean) {
      clearSearch();
      return;
    }
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const generation = ++generationRef.current;
    setQuery(clean);
    setCategory(nextCategory);
    setSearchedQuery(clean);
    setLoading(true);
    setError(null);
    setItems([]);
    try {
      const found = await fetchSpotifySearch(clean, {
        types: nextCategory === 'all' ? 'track,album,artist,playlist' : nextCategory,
        limit: 8,
        signal: request.signal,
      });
      if (generation !== generationRef.current) return;
      setItems(found);
      if (found.length) setRecentSearches((previous) => addRecentSearch(previous, clean));
    } catch (reason) {
      if (generation !== generationRef.current || request.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Spotify search is unavailable. Try again.');
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        requestRef.current = null;
      }
    }
  }, [category, clearSearch, query]);

  const selectCategory = useCallback((nextCategory: SpotifySearchCategory) => {
    setCategory(nextCategory);
    if (query.trim()) void search(query, nextCategory);
  }, [query, search]);

  const clearRecentSearches = useCallback(() => setRecentSearches([]), []);
  const value = useMemo(() => ({
    query, setQuery, category, selectCategory, items, loading, error, searchedQuery,
    recentSearches, clearRecentSearches, search, clearSearch,
  }), [query, category, selectCategory, items, loading, error, searchedQuery,
    recentSearches, clearRecentSearches, search, clearSearch]);

  return <SpotifyBrowseContext.Provider value={value}>{children}</SpotifyBrowseContext.Provider>;
}

export function useSpotifyBrowse(): SpotifyBrowseValue {
  const value = useContext(SpotifyBrowseContext);
  if (!value) throw new Error('useSpotifyBrowse must be used under SpotifyBrowseProvider');
  return value;
}
