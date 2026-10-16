import { getGmailDigest } from '@/lib/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function useGmailDigest() {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cachedAtRef = useRef<number | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    const now = Date.now();
    if (!forceRefresh && cachedAtRef.current && now - cachedAtRef.current < CACHE_TTL_MS) {
      return;
    }
    try {
      setError(null);
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);
      const data = await getGmailDigest();
      setSummary(data.summary || '');
      cachedAtRef.current = Date.now();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load digest');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { summary, loading, error, refreshing, load, refresh: () => load(true) };
}
