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
import { fetchSystemVolume, postSystemVolume, type SystemVolumeState } from './api';

const DEBOUNCE_MS = 110;

export interface SystemVolumeContextValue {
  percent: number;
  muted: boolean;
  loading: boolean;
  error: string | null;
  /** 0–100; debounced POST to device */
  setPercent: (p: number) => void;
  setMuted: (muted: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const SystemVolumeContext = createContext<SystemVolumeContextValue | null>(null);

export function SystemVolumeProvider({ children }: { children: ReactNode }) {
  const [percent, setPercentState] = useState(0);
  const [muted, setMutedState] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const s: SystemVolumeState = await fetchSystemVolume();
      setPercentState(s.percent);
      setMutedState(s.muted);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'volume');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setPercent = useCallback((p: number) => {
    const cl = Math.max(0, Math.min(100, Math.round(p)));
    setPercentState(cl);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void (async () => {
        try {
          setError(null);
          const s = await postSystemVolume({ percent: cl });
          setPercentState(s.percent);
          setMutedState(s.muted);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'volume');
        }
      })();
    }, DEBOUNCE_MS);
  }, []);

  const setMuted = useCallback(async (m: boolean) => {
    try {
      setError(null);
      const s = await postSystemVolume({ muted: m });
      setPercentState(s.percent);
      setMutedState(s.muted);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'volume');
      throw e;
    }
  }, []);

  const value = useMemo<SystemVolumeContextValue>(
    () => ({
      percent,
      muted,
      loading,
      error,
      setPercent,
      setMuted,
      refresh,
    }),
    [percent, muted, loading, error, setPercent, setMuted, refresh]
  );

  return <SystemVolumeContext.Provider value={value}>{children}</SystemVolumeContext.Provider>;
}

export function useSystemVolume(): SystemVolumeContextValue {
  const ctx = useContext(SystemVolumeContext);
  if (!ctx) throw new Error('useSystemVolume must be used under SystemVolumeProvider');
  return ctx;
}
