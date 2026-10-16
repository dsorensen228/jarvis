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

const TOAST_MS = 3200;

const KioskToastContext = createContext<{
  showToast: (message: string) => void;
} | null>(null);

export function KioskToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    const trimmed = msg.trim();
    if (!trimmed) return;
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    setMessage(trimmed);
    clearTimer.current = window.setTimeout(() => {
      clearTimer.current = null;
      setMessage(null);
    }, TOAST_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    };
  }, []);

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <KioskToastContext.Provider value={value}>
      {children}
      {message ? (
        <div className="kiosk-toast" role="status" aria-live="polite">
          {message}
        </div>
      ) : null}
    </KioskToastContext.Provider>
  );
}

export function useKioskToast() {
  const ctx = useContext(KioskToastContext);
  if (!ctx) throw new Error('useKioskToast outside provider');
  return ctx;
}
