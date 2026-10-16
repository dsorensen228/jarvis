import { loadAlarms, saveAlarms } from './alarmStorage';
import { migrateRuntime, parseRuntime } from './timerRuntime';
import type { SessionTimerState, TimerRuntime } from './types';

export const SESSION_TIMER_KEY = 'jarvis_timer_session_v1';
export const TIMER_RUNTIME_KEY = 'jarvis_timer_runtime_v2';

export function loadSessionTimer(): SessionTimerState | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(SESSION_TIMER_KEY);
    if (!raw) return null;
    const t: unknown = JSON.parse(raw);
    if (typeof t === 'object' && t !== null && 'mode' in t && t.mode === 'running' && 'endTime' in t &&
        typeof t.endTime === 'number' && Number.isFinite(t.endTime) && t.endTime >= 0 && t.endTime < 8_640_000_000_000_000) {
      return { mode: 'running', endTime: t.endTime };
    }
  } catch { /* Unavailable or malformed legacy storage must not prevent startup. */ }
  return null;
}

export function saveSessionTimer(state: SessionTimerState | null): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (state === null) sessionStorage.removeItem(SESSION_TIMER_KEY);
    else sessionStorage.setItem(SESSION_TIMER_KEY, JSON.stringify(state));
  } catch { /* Legacy storage is only used for migration. */ }
}

export function loadTimerRuntime(now = Date.now()): TimerRuntime {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = parseRuntime(localStorage.getItem(TIMER_RUNTIME_KEY), now);
      if (saved) return saved;
    }
  } catch { /* Fall back to the previous keys if the new store cannot be read. */ }
  return migrateRuntime(loadAlarms(), loadSessionTimer(), now);
}

export function saveTimerRuntime(state: TimerRuntime): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(TIMER_RUNTIME_KEY, JSON.stringify(state));
    // Only remove the session deadline after the entire migrated runtime is durable.
    saveSessionTimer(null);
    saveAlarms(state.alarms);
    return true;
  } catch { return false; }
}
