import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { SpotifySearchItem } from '../api';
import { useKioskToast } from '../KioskToastContext';

const FAVORITES_KEY = 'jarvis.spotify.favorites.v1';
export const SPOTIFY_FAVORITES_LIMIT = 24;

export function validateFavorite(value: unknown): SpotifySearchItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SpotifySearchItem>;
  if (typeof item.uri !== 'string' || !/^spotify:(track|album|artist|playlist):[a-zA-Z0-9]+$/.test(item.uri)) return null;
  if (typeof item.name !== 'string' || !item.name.trim()) return null;
  let image: string | null = null;
  try {
    if (typeof item.image === 'string' && new URL(item.image).protocol === 'https:') image = item.image;
  } catch { /* Invalid stored artwork falls back to the record placeholder. */ }
  return {
    uri: item.uri,
    name: item.name.trim().slice(0, 240),
    subtitle: typeof item.subtitle === 'string' ? item.subtitle.slice(0, 240) : '',
    image,
    kind: item.uri.split(':')[1],
  };
}

export function normalizeFavorites(value: unknown): SpotifySearchItem[] {
  if (!Array.isArray(value)) return [];
  const favorites: SpotifySearchItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = validateFavorite(raw);
    if (!item || seen.has(item.uri)) continue;
    favorites.push(item);
    seen.add(item.uri);
    if (favorites.length === SPOTIFY_FAVORITES_LIMIT) break;
  }
  return favorites;
}

function loadFavorites(): SpotifySearchItem[] {
  try {
    return normalizeFavorites(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'));
  } catch { return []; }
}

interface SpotifyFavoritesValue {
  favorites: SpotifySearchItem[];
  toggleFavorite: (item: SpotifySearchItem) => void;
  isFavorite: (uri: string) => boolean;
}

const SpotifyFavoritesContext = createContext<SpotifyFavoritesValue | null>(null);

/** Device-local quick picks; this does not modify the user's Spotify library. */
export function SpotifyFavoritesProvider({ children }: { children: ReactNode }) {
  const [favorites, setFavorites] = useState(loadFavorites);
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const { showToast } = useKioskToast();
  useEffect(() => {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* Session-only fallback. */ }
  }, [favorites]);
  useEffect(() => {
    const clear = () => { favoritesRef.current = []; setFavorites([]); };
    window.addEventListener('jarvis-spotify-disconnected', clear);
    return () => window.removeEventListener('jarvis-spotify-disconnected', clear);
  }, []);

  const toggleFavorite = useCallback((raw: SpotifySearchItem) => {
    const item = validateFavorite(raw);
    if (!item) return;
    const previous = favoritesRef.current;
    const exists = previous.some((favorite) => favorite.uri === item.uri);
    if (!exists && previous.length >= SPOTIFY_FAVORITES_LIMIT) {
      showToast('Your 24 favorites are full. Remove one before saving another.');
      return;
    }
    const next = exists ? previous.filter((favorite) => favorite.uri !== item.uri) : [item, ...previous];
    favoritesRef.current = next;
    setFavorites(next);
  }, [showToast]);
  const isFavorite = useCallback((uri: string) => favorites.some((item) => item.uri === uri), [favorites]);
  const value = useMemo(() => ({ favorites, toggleFavorite, isFavorite }), [favorites, toggleFavorite, isFavorite]);
  return <SpotifyFavoritesContext.Provider value={value}>{children}</SpotifyFavoritesContext.Provider>;
}

export function useSpotifyFavorites(): SpotifyFavoritesValue {
  const value = useContext(SpotifyFavoritesContext);
  if (!value) throw new Error('useSpotifyFavorites must be used under SpotifyFavoritesProvider');
  return value;
}
