import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBanterState, postBanterTrigger, type BanterState } from './api';
import { useKioskToast } from './KioskToastContext';

const POLL_MS = 3000;

export function useBanter(standby: boolean) {
  const { showToast } = useKioskToast();
  const [state, setState] = useState<BanterState | null>(null);
  const [pending, setPending] = useState(false);
  const requestInFlight = useRef(false);
  const requestVersion = useRef(0);
  const watchingInteraction = useRef(false);

  useEffect(() => {
    if (!standby) return;
    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | undefined;

    const poll = async () => {
      const version = requestVersion.current;
      try {
        if (!requestInFlight.current) {
          const next = await fetchBanterState();
          if (cancelled || version !== requestVersion.current) return;
          setState(next);
          if (watchingInteraction.current && !next.busy) {
            if (next.status === 'completed') {
              watchingInteraction.current = false;
              showToast('Sherman and Jarvis finished chatting');
            } else if (next.status === 'failed') {
              watchingInteraction.current = false;
              showToast("Sherman and Jarvis couldn't finish chatting. Try again.");
            }
          }
        }
      } catch {
        if (!cancelled && version === requestVersion.current) {
          // Keep the paired icon in place, but require a fresh status before retrying.
          setState((previous) => previous ? { ...previous, available: false } : null);
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [standby, showToast]);

  const trigger = useCallback(() => {
    if (requestInFlight.current || !state?.paired || !state.available || state.busy) return;
    requestInFlight.current = true;
    requestVersion.current += 1;
    setPending(true);
    void postBanterTrigger()
      .then((next) => {
        setState(next);
        watchingInteraction.current = true;
        showToast('Starting Sherman and Jarvis…');
      })
      .catch((error: unknown) => {
        setState((previous) => previous ? { ...previous, available: false } : null);
        showToast(error instanceof Error ? error.message : "Couldn't start Sherman and Jarvis");
      })
      .finally(() => {
        requestInFlight.current = false;
        setPending(false);
      });
  }, [state, showToast]);

  return { state, pending, trigger };
}
