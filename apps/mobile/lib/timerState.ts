export type TimerStatus = 'idle' | 'running' | 'paused' | 'alarming';
export const MAX_TIMER_MS = (99 * 3600 + 59 * 60 + 59) * 1000;
export const TIMER_SOUND_MS = 30_000;
export type TimerState = {
  v: 2;
  id: string;
  revision: number;
  status: TimerStatus;
  label: string;
  durationMs: number;
  endAtMs: number | null;
  pausedRemainingMs: number | null;
  alarmedAtMs: number | null;
  silenced: boolean;
  recentDurations: number[];
};
export const EMPTY_TIMER: TimerState = {
  v: 2, id: '', revision: 0, status: 'idle', label: '', durationMs: 0,
  endAtMs: null, pausedRemainingMs: null, alarmedAtMs: null, silenced: false,
  recentDurations: [],
};
export const cleanTimerLabel = (label: unknown) => typeof label === 'string'
  ? label.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
export function clampDuration(ms: number): number {
  return Number.isFinite(ms) && ms >= 1000 ? Math.min(MAX_TIMER_MS, Math.round(ms / 1000) * 1000) : 0;
}
export function timePart(raw: string, maximum: number): number {
  return Math.min(maximum, Math.max(0, Number.parseInt(raw.replace(/\D/g, ''), 10) || 0));
}
export function durationFromParts(hours: string, minutes: string, seconds: string): number {
  return (timePart(hours, 99) * 3600 + timePart(minutes, 59) * 60 + timePart(seconds, 59)) * 1000;
}
export function splitDuration(ms: number) {
  const seconds = Math.floor(clampDuration(ms) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0'));
}
export function timerRemaining(state: TimerState, now: number): number {
  return state.status === 'running' ? Math.min(state.durationMs, Math.max(0, (state.endAtMs ?? now) - now))
    : state.status === 'paused' ? state.pausedRemainingMs ?? 0 : 0;
}
export function rememberDuration(durations: number[], duration: number): number[] {
  return [...new Set([duration, ...durations].map(clampDuration).filter(Boolean))].slice(0, 6);
}
export type TimerAction =
  | { type: 'start'; durationMs: number; label: string; id: string; now: number }
  | { type: 'restart'; id: string; now: number }
  | { type: 'pause' | 'resume' | 'add-minute' | 'finish' | 'stop' | 'silence'; now: number };
export function reduceTimer(state: TimerState, action: TimerAction): TimerState {
  const changed = (patch: Partial<TimerState>): TimerState => ({ ...state, ...patch, revision: state.revision + 1 });
  const finish = () => ({ ...changed({ status: 'alarming', alarmedAtMs: state.endAtMs ?? action.now,
    endAtMs: null, pausedRemainingMs: null, silenced: action.now - (state.endAtMs ?? action.now) >= TIMER_SOUND_MS, }), revision: state.revision });
  switch (action.type) {
    case 'start': {
      const durationMs = clampDuration(action.durationMs);
      if (!durationMs) return state;
      return changed({ id: action.id, status: 'running', label: cleanTimerLabel(action.label), durationMs,
        endAtMs: action.now + durationMs, pausedRemainingMs: null, alarmedAtMs: null, silenced: false,
        recentDurations: rememberDuration(state.recentDurations, durationMs) });
    }
    case 'restart': return reduceTimer(state, { type: 'start', durationMs: state.durationMs, label: state.label, now: action.now, id: action.id });
    case 'pause': {
      if (state.status !== 'running') return state;
      const remaining = timerRemaining(state, action.now);
      return remaining <= 0 ? finish() : changed({ status: 'paused', pausedRemainingMs: remaining, endAtMs: null });
    }
    case 'resume': return state.status !== 'paused' || !state.pausedRemainingMs ? state : changed({
      status: 'running', endAtMs: action.now + state.pausedRemainingMs, pausedRemainingMs: null });
    case 'add-minute': {
      if (state.status !== 'running' && state.status !== 'paused') return state;
      if (state.status === 'running' && timerRemaining(state, action.now) <= 0) return finish();
      const extra = Math.min(60_000, MAX_TIMER_MS - state.durationMs);
      if (!extra) return state;
      return changed({ durationMs: state.durationMs + extra,
        endAtMs: state.endAtMs === null ? null : state.endAtMs + extra,
        pausedRemainingMs: state.pausedRemainingMs === null ? null : state.pausedRemainingMs + extra });
    }
    case 'finish': return state.status === 'running' && timerRemaining(state, action.now) <= 0 ? finish() : state;
    case 'silence': return state.status === 'alarming' && !state.silenced ? { ...state, silenced: true } : state;
    case 'stop': return state.status === 'idle' ? state : changed({ status: 'idle', endAtMs: null, pausedRemainingMs: null, alarmedAtMs: null, silenced: false });
  }
}
/** Validate untrusted storage and migrate the original Android v1 timer in place. */
export function restoreTimer(raw: string | null, now: number): TimerState {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (!value || ![1, 2].includes(value.v)) return EMPTY_TIMER;
    const durationMs = clampDuration(value.durationMs);
    const status: TimerStatus = ['idle', 'running', 'paused', 'alarming'].includes(value.status) ? value.status : 'idle';
    const state: TimerState = { ...EMPTY_TIMER, status, durationMs,
      id: typeof value.id === 'string' && value.id ? value.id : `legacy-${value.endAtMs ?? value.pausedRemainingMs ?? now}`,
      revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
      label: cleanTimerLabel(value.label),
      endAtMs: Number.isFinite(value.endAtMs) && value.endAtMs > 0 ? value.endAtMs : null,
      pausedRemainingMs: Number.isFinite(value.pausedRemainingMs) && value.pausedRemainingMs > 0 ? Math.min(durationMs, value.pausedRemainingMs) : null,
      alarmedAtMs: Number.isFinite(value.alarmedAtMs) && value.alarmedAtMs > 0 ? value.alarmedAtMs : now,
      silenced: value.silenced === true || (status === 'alarming' && !Number.isFinite(value.alarmedAtMs)),
      recentDurations: Array.isArray(value.recentDurations) ? [...new Set<number>(value.recentDurations.map(clampDuration).filter(Boolean))].slice(0, 6) : [],
    };
    if (!durationMs || (status === 'running' && (!state.endAtMs || state.endAtMs - now > MAX_TIMER_MS)) || (status === 'paused' && !state.pausedRemainingMs)) {
      return { ...EMPTY_TIMER, label: state.label, recentDurations: state.recentDurations };
    }
    if (status === 'running' && state.endAtMs! <= now) return reduceTimer(state, { type: 'finish', now });
    if (status === 'alarming' && now - state.alarmedAtMs! >= TIMER_SOUND_MS) state.silenced = true;
    return state;
  } catch { return EMPTY_TIMER; }
}
export function matchesTimerNotification(state: TimerState, data?: Record<string, unknown>): boolean {
  if (!data?.timerId) return state.id.startsWith('legacy-') && state.revision === 0;
  return data.timerId === state.id && String(data.revision) === String(state.revision);
}
