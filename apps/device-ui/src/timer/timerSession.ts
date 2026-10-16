import type { SessionTimerState } from './types';

const KEY = 'jarvis_timer_session_v1';

export function loadSessionTimer(): SessionTimerState | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as {
      mode?: string;
      endTime?: number;
    };
    if (t.mode === 'running' && typeof t.endTime === 'number') {
      return { mode: 'running', endTime: t.endTime };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveSessionTimer(state: SessionTimerState | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (state === null) sessionStorage.removeItem(KEY);
  else sessionStorage.setItem(KEY, JSON.stringify(state));
}
