import { nextFireAfter } from './nextAlarm';
import type { Alarm, AlarmInput, DeletedAlarmSnapshot, PendingSnooze, RecentTimer, RepeatRule, RingEvent, Timer, TimerRuntime } from './types';

export const MAX_TIMER_MS = 7 * 24 * 60 * 60_000;
export const CATCH_UP_MS = 15 * 60_000;
export const MAX_RING_MS = 10 * 60_000;
export const MAX_TIMERS = 32;
export const MAX_ALARMS = 64;
const MAX_DATE = 8_640_000_000_000_000;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const date = (v: unknown): v is number => finite(v) && v >= 0 && v < MAX_DATE;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(v);
const integer = (v: unknown, min: number, max: number): v is number => finite(v) && Number.isInteger(v) && v >= min && v <= max;
export const timerLabel = (v: unknown, fallback = 'Timer'): string => typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : fallback;
export const validDuration = (v: unknown): v is number => finite(v) && v >= 1000 && v <= MAX_TIMER_MS;
export const validSnooze = (v: unknown): v is number => integer(v, 1, 60);
/** Voice JSON may contain numeric strings; null/booleans/blanks are not midnight. */
export const clockNumber = (v: unknown): number => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;

export function normalizeRepeat(value: unknown): RepeatRule | null {
  if (!record(value)) return null;
  if (value.kind === 'once' || value.kind === 'daily') return { kind: value.kind };
  if (value.kind === 'weekly' && integer(value.weekday, 0, 6)) return { kind: 'weekly', weekday: value.weekday };
  if (value.kind === 'custom' && Array.isArray(value.weekdays) && value.weekdays.length && value.weekdays.every((day) => integer(day, 0, 6))) {
    return { kind: 'custom', weekdays: [...new Set(value.weekdays)].sort() as number[] };
  }
  return null;
}

export function normalizeAlarm(value: unknown): Alarm | null {
  if (!record(value) || !id(value.id) || !integer(value.hour, 0, 23) || !integer(value.minute, 0, 59) || typeof value.enabled !== 'boolean') return null;
  const repeat = normalizeRepeat(value.repeat);
  if (!repeat || (value.snoozeMinutes !== undefined && !validSnooze(value.snoozeMinutes))) return null;
  return { id: value.id, hour: value.hour, minute: value.minute, enabled: value.enabled, repeat,
    label: timerLabel(value.label, 'Alarm'), snoozeMinutes: value.snoozeMinutes === undefined ? 10 : value.snoozeMinutes as number };
}

function normalizeTimer(value: unknown): Timer | null {
  if (!record(value) || !id(value.id) || !validDuration(value.durationMs) || !date(value.createdAt)) return null;
  const common = { id: value.id, label: timerLabel(value.label), durationMs: value.durationMs, createdAt: value.createdAt };
  if (value.status === 'running' && date(value.endTime)) return { ...common, status: 'running', endTime: value.endTime, remainingMs: value.durationMs };
  if (value.status === 'paused' && finite(value.remainingMs) && value.remainingMs > 0 && value.remainingMs <= MAX_TIMER_MS) {
    return { ...common, status: 'paused', endTime: null, remainingMs: value.remainingMs };
  }
  if (value.status === 'finished') return { ...common, status: 'finished', endTime: null, remainingMs: 0 };
  return null;
}

function normalizeSnooze(value: unknown): PendingSnooze | null {
  if (!record(value) || !id(value.id) || !id(value.alarmId) || !date(value.fireAt) || !validSnooze(value.snoozeMinutes)) return null;
  return { id: value.id, alarmId: value.alarmId, fireAt: value.fireAt, label: timerLabel(value.label, 'Alarm'), snoozeMinutes: value.snoozeMinutes };
}

function normalizeRing(value: unknown): RingEvent | null {
  if (!record(value) || !id(value.id) || !date(value.fireAt) || (value.startedAt !== null && !date(value.startedAt)) || typeof value.silent !== 'boolean') return null;
  const common = { id: value.id, fireAt: value.fireAt, startedAt: value.startedAt as number | null, silent: value.silent, occurrences: integer(value.occurrences, 1, Number.MAX_SAFE_INTEGER) ? value.occurrences : 1, label: timerLabel(value.label, value.kind === 'alarm' ? 'Alarm' : 'Timer') };
  if (value.kind === 'timer' && id(value.timerId) && validDuration(value.durationMs)) return { ...common, kind: 'timer', timerId: value.timerId, durationMs: value.durationMs };
  if (value.kind === 'alarm' && id(value.alarmId) && validSnooze(value.snoozeMinutes)) return { ...common, kind: 'alarm', alarmId: value.alarmId, snoozeMinutes: value.snoozeMinutes };
  return null;
}

function records<T extends { id: string }>(value: unknown, parse: (v: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, limit).flatMap((entry) => {
    const item = parse(entry);
    if (!item || seen.has(item.id)) return [];
    seen.add(item.id);
    return [item];
  });
}

export function emptyRuntime(): TimerRuntime {
  return { version: 2, timers: [], alarms: [], alarmNextFireAt: {}, pendingSnoozes: [], ringingQueue: [], recentTimers: [] };
}

export function parseRuntime(raw: string | null, now: number): TimerRuntime | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 2 || !Array.isArray(value.alarms) || !Array.isArray(value.timers)) return null;
    const alarms = records(value.alarms, normalizeAlarm, MAX_ALARMS);
    const timers = records(value.timers, normalizeTimer, MAX_TIMERS);
    const alarmIds = new Set(alarms.map((a) => a.id));
    const timerIds = new Set(timers.map((t) => t.id));
    const alarmNextFireAt = Object.fromEntries(alarms.filter((a) => a.enabled).flatMap((a) => {
      const at = record(value.alarmNextFireAt) && Object.hasOwn(value.alarmNextFireAt, a.id) ? value.alarmNextFireAt[a.id] : null;
      return date(at) ? [[a.id, at]] : [];
    }));
    const pendingSnoozes = records(value.pendingSnoozes, normalizeSnooze, MAX_ALARMS).filter((s) => alarmIds.has(s.alarmId));
    const ringingQueue = records(value.ringingQueue, normalizeRing, MAX_TIMERS + MAX_ALARMS * 2).filter((r) => r.kind === 'timer' ? timerIds.has(r.timerId) : alarmIds.has(r.alarmId));
    const recentTimers: RecentTimer[] = Array.isArray(value.recentTimers) ? value.recentTimers.slice(0, 6).flatMap((r) => record(r) && validDuration(r.durationMs) ? [{ durationMs: r.durationMs, label: timerLabel(r.label) }] : []) : [];
    return tickRuntime({ version: 2, alarms, timers, alarmNextFireAt, pendingSnoozes, ringingQueue, recentTimers }, now);
  } catch { return null; }
}

/** One-time conversion keeps the legacy absolute deadline, even when already overdue. */
export function migrateRuntime(alarms: Alarm[], legacyTimer: { endTime: number } | null, now: number): TimerRuntime {
  const state = emptyRuntime();
  state.alarms = alarms;
  if (legacyTimer && date(legacyTimer.endTime)) {
    const remaining = Math.max(1000, Math.min(MAX_TIMER_MS, legacyTimer.endTime - now));
    state.timers = [{ id: 'legacy-timer', label: 'Timer', durationMs: remaining, remainingMs: remaining, status: 'running', endTime: legacyTimer.endTime, createdAt: now }];
  }
  return tickRuntime(state, now);
}

export function timerRemaining(timer: Timer, now: number): number {
  return timer.status === 'running' ? Math.max(0, (timer.endTime ?? now) - now) : timer.remainingMs;
}

/** Unqualified voice Stop targets the alert the user hears before another countdown. */
export function timerToCancel(state: TimerRuntime, idOrLabel?: string): string | null {
  const timers = [...state.timers].reverse();
  if (idOrLabel) return timers.find((timer) => timer.id === idOrLabel || timer.label.toLocaleLowerCase() === idOrLabel.trim().toLocaleLowerCase())?.id ?? null;
  const ringing = state.ringingQueue.find((event) => event.kind === 'timer');
  return ringing?.kind === 'timer' ? ringing.timerId : timers.find((timer) => timer.status !== 'finished')?.id ?? null;
}

export function snapshotAlarm(state: TimerRuntime, alarmId: string, now: number): DeletedAlarmSnapshot | null {
  const current = tickRuntime(state, now);
  const alarm = current.alarms.find((a) => a.id === alarmId);
  if (!alarm) return null;
  return { alarm, nextFireAt: current.alarmNextFireAt[alarmId] ?? null,
    pendingSnoozes: current.pendingSnoozes.filter((s) => s.alarmId === alarmId),
    ringingQueue: current.ringingQueue.filter((r) => r.kind === 'alarm' && r.alarmId === alarmId) };
}

/**
 * Every due source is collected even while another alert rings. Repeating alarms
 * catch up once, then advance from now; unattended repeats cannot grow the queue.
 * Alerts over 15 minutes late stay visible but silent. Audible alerts stop after
 * ten minutes, without dismissing the alert or losing the waiting queue.
 */
export function tickRuntime(state: TimerRuntime, now: number): TimerRuntime {
  let changed = false;
  // Age before collecting due events, so a reload tomorrow cannot let yesterday's
  // undismissed alert suppress the same repeating alarm's fresh occurrence.
  const existing = state.ringingQueue.map((event) => {
    const expired = event.startedAt === null ? now - event.fireAt > CATCH_UP_MS : now - event.startedAt >= MAX_RING_MS;
    if (event.silent || !expired) return event;
    changed = true;
    return { ...event, silent: true };
  });
  const due: RingEvent[] = [];
  const base = (eventId: string, label: string, fireAt: number) => ({ id: eventId, label, fireAt, startedAt: null, silent: now - fireAt > CATCH_UP_MS, occurrences: 1 });
  const timers = state.timers.map((timer) => {
    if (timer.status !== 'running' || timer.endTime === null || timer.endTime > now) return timer;
    changed = true;
    due.push({ ...base(`timer:${timer.id}:${timer.endTime}`, timer.label, timer.endTime), kind: 'timer', timerId: timer.id, durationMs: timer.durationMs });
    return { ...timer, status: 'finished' as const, endTime: null, remainingMs: 0 };
  });
  const alarmNextFireAt = { ...state.alarmNextFireAt };
  const alarms = state.alarms.map((alarm) => {
    if (!alarm.enabled) {
      if (Object.hasOwn(alarmNextFireAt, alarm.id)) { delete alarmNextFireAt[alarm.id]; changed = true; }
      return alarm;
    }
    const fireAt = Object.hasOwn(alarmNextFireAt, alarm.id) ? alarmNextFireAt[alarm.id] : undefined;
    if (fireAt === undefined) {
      alarmNextFireAt[alarm.id] = nextFireAfter(new Date(now), alarm.hour, alarm.minute, alarm.repeat).getTime();
      changed = true;
      return alarm;
    }
    if (fireAt > now) return alarm;
    changed = true;
    if (!existing.some((r) => r.kind === 'alarm' && r.alarmId === alarm.id && !r.silent)) {
      due.push({ ...base(`alarm:${alarm.id}:${fireAt}`, alarm.label, fireAt), kind: 'alarm', alarmId: alarm.id, snoozeMinutes: alarm.snoozeMinutes });
    }
    if (alarm.repeat.kind === 'once') { delete alarmNextFireAt[alarm.id]; return { ...alarm, enabled: false }; }
    alarmNextFireAt[alarm.id] = nextFireAfter(new Date(now), alarm.hour, alarm.minute, alarm.repeat).getTime();
    return alarm;
  });
  const pendingSnoozes = state.pendingSnoozes.filter((snooze) => {
    if (snooze.fireAt > now) return true;
    changed = true;
    due.push({ ...base(`snooze:${snooze.id}`, snooze.label, snooze.fireAt), kind: 'alarm', alarmId: snooze.alarmId, snoozeMinutes: snooze.snoozeMinutes });
    return false;
  });
  due.sort((a, b) => a.fireAt - b.fireAt || a.id.localeCompare(b.id));
  const known = new Set(existing.map((r) => r.id));
  const collected = [...existing, ...due.filter((r) => !known.has(r.id))];
  const audible = collected.filter((r) => !r.silent);
  const missed = new Map<string, RingEvent>();
  for (const event of collected.filter((r) => r.silent)) {
    const source = event.kind === 'alarm' ? `alarm:${event.alarmId}` : `timer:${event.timerId}`;
    const previous = missed.get(source);
    missed.set(source, previous ? { ...previous, occurrences: Math.min(Number.MAX_SAFE_INTEGER, previous.occurrences + event.occurrences) } : event);
    if (previous) changed = true;
  }
  // Silent catch-up cards cannot obstruct a fresh alarm. Keep them after audible
  // alerts, with one historical card per source and its occurrence count.
  let ringingQueue = [...audible, ...missed.values()];
  if (ringingQueue.some((r, index) => r.id !== state.ringingQueue[index]?.id)) changed = true;
  const current = ringingQueue[0];
  if (current && current.startedAt === null) {
    ringingQueue = [{ ...current, startedAt: now }, ...ringingQueue.slice(1)];
    changed = true;
  }
  return changed ? { ...state, timers, alarms, alarmNextFireAt, pendingSnoozes, ringingQueue } : state;
}

export type RuntimeAction =
  | { type: 'start'; id: string; durationMs: number; label?: string }
  | { type: 'pause' | 'resume' | 'restart' | 'remove-timer'; id: string }
  | { type: 'add-time'; id: string; durationMs: number }
  | { type: 'add-alarm'; alarm: Alarm }
  | { type: 'restore-alarm'; snapshot: DeletedAlarmSnapshot }
  | { type: 'update-alarm'; id: string; patch: Partial<Omit<Alarm, 'id'>> }
  | { type: 'remove-alarm'; id: string }
  | { type: 'cancel-snooze'; id: string }
  | { type: 'dismiss'; id?: string }
  | { type: 'snooze'; id: string; minutes?: number; eventId?: string };

export function applyRuntimeAction(previous: TimerRuntime, action: RuntimeAction, now: number): TimerRuntime {
  const targetAlertId = action.type === 'dismiss' ? action.id ?? previous.ringingQueue.at(0)?.id
    : action.type === 'snooze' ? action.eventId ?? previous.ringingQueue.at(0)?.id : undefined;
  let state = tickRuntime(previous, now);
  const withoutTimerAlert = (timerId: string) => state.ringingQueue.filter((r) => r.kind !== 'timer' || r.timerId !== timerId);
  if (action.type === 'start') {
    if (!id(action.id) || !validDuration(action.durationMs) || state.timers.some((t) => t.id === action.id)) return state;
    const required = Math.max(0, state.timers.length - MAX_TIMERS + 1);
    const unacknowledged = new Set(state.ringingQueue.flatMap((event) => event.kind === 'timer' ? [event.timerId] : []));
    const removable = state.timers.filter((timer) => timer.status === 'finished' && !unacknowledged.has(timer.id))
      .sort((a, b) => a.createdAt - b.createdAt).slice(0, required);
    if (removable.length < required) return state;
    const removeIds = new Set(removable.map((timer) => timer.id));
    const timers = state.timers.filter((timer) => !removeIds.has(timer.id));
    const durationMs = Math.round(action.durationMs);
    const label = timerLabel(action.label);
    const timer: Timer = { id: action.id, label, durationMs, remainingMs: durationMs, status: 'running', endTime: now + durationMs, createdAt: now };
    state = { ...state, timers: [...timers, timer], recentTimers: [{ durationMs, label }, ...state.recentTimers.filter((r) => r.durationMs !== durationMs || r.label !== label)].slice(0, 6) };
  } else if (action.type === 'pause' || action.type === 'resume' || action.type === 'restart' || action.type === 'add-time' || action.type === 'remove-timer') {
    const timer = state.timers.find((t) => t.id === action.id);
    if (!timer) return state;
    let updated = timer;
    if (action.type === 'pause' && timer.status === 'running') updated = { ...timer, status: 'paused', remainingMs: timerRemaining(timer, now), endTime: null };
    if (action.type === 'resume' && timer.status === 'paused') updated = { ...timer, status: 'running', endTime: now + timer.remainingMs };
    if (action.type === 'restart') updated = { ...timer, status: 'running', endTime: now + timer.durationMs, remainingMs: timer.durationMs };
    if (action.type === 'add-time') {
      if (!validDuration(action.durationMs)) return state;
      const remaining = timerRemaining(timer, now) + Math.round(action.durationMs);
      const durationMs = timer.durationMs + Math.round(action.durationMs);
      if (remaining > MAX_TIMER_MS || durationMs > MAX_TIMER_MS) return state;
      updated = { ...timer, durationMs, remainingMs: remaining, status: timer.status === 'paused' ? 'paused' : 'running', endTime: timer.status === 'paused' ? null : now + remaining };
    }
    const clearAlert = action.type === 'remove-timer' || action.type === 'restart' || action.type === 'add-time';
    state = { ...state, timers: action.type === 'remove-timer' ? state.timers.filter((t) => t.id !== timer.id) : state.timers.map((t) => t.id === timer.id ? updated : t), ringingQueue: clearAlert ? withoutTimerAlert(timer.id) : state.ringingQueue };
  } else if (action.type === 'restore-alarm') {
    const saved = action.snapshot;
    const alarm = normalizeAlarm(saved.alarm);
    if (!alarm || state.alarms.length >= MAX_ALARMS || state.alarms.some((a) => a.id === alarm.id)) return state;
    const alarmNextFireAt = { ...state.alarmNextFireAt };
    if (alarm.enabled && date(saved.nextFireAt)) alarmNextFireAt[alarm.id] = saved.nextFireAt;
    const snoozeIds = new Set(state.pendingSnoozes.map((s) => s.id));
    const eventIds = new Set(state.ringingQueue.map((r) => r.id));
    const snoozes = records(saved.pendingSnoozes, normalizeSnooze, 1).filter((s) => s.alarmId === alarm.id && !snoozeIds.has(s.id));
    const alerts = records(saved.ringingQueue, normalizeRing, 3).filter((r) => r.kind === 'alarm' && r.alarmId === alarm.id && !eventIds.has(r.id));
    state = { ...state, alarms: [...state.alarms, alarm], alarmNextFireAt,
      pendingSnoozes: [...state.pendingSnoozes, ...snoozes], ringingQueue: [...state.ringingQueue, ...alerts] };
  } else if (action.type === 'add-alarm') {
    const alarm = normalizeAlarm(action.alarm);
    if (!alarm || state.alarms.length >= MAX_ALARMS || state.alarms.some((a) => a.id === alarm.id)) return state;
    state = { ...state, alarms: [...state.alarms, alarm] };
  } else if (action.type === 'update-alarm') {
    const old = state.alarms.find((a) => a.id === action.id);
    const alarm = old && normalizeAlarm({ ...old, ...action.patch, id: old.id });
    if (!old || !alarm) return state;
    const scheduleChanged = old.hour !== alarm.hour || old.minute !== alarm.minute || old.enabled !== alarm.enabled || JSON.stringify(old.repeat) !== JSON.stringify(alarm.repeat);
    const cancelPending = scheduleChanged || action.patch.enabled === false;
    const alarmNextFireAt = { ...state.alarmNextFireAt };
    if (scheduleChanged) delete alarmNextFireAt[alarm.id];
    state = { ...state, alarms: state.alarms.map((a) => a.id === alarm.id ? alarm : a), alarmNextFireAt,
      pendingSnoozes: cancelPending ? state.pendingSnoozes.filter((s) => s.alarmId !== alarm.id) : state.pendingSnoozes,
      ringingQueue: cancelPending ? state.ringingQueue.filter((r) => r.kind !== 'alarm' || r.alarmId !== alarm.id) : state.ringingQueue };
  } else if (action.type === 'cancel-snooze') {
    state = { ...state, pendingSnoozes: state.pendingSnoozes.filter((s) => s.alarmId !== action.id),
      ringingQueue: state.ringingQueue.filter((r) => r.kind !== 'alarm' || r.alarmId !== action.id || !r.id.startsWith('snooze:')) };
  } else if (action.type === 'remove-alarm') {
    const alarmNextFireAt = { ...state.alarmNextFireAt };
    delete alarmNextFireAt[action.id];
    state = { ...state, alarms: state.alarms.filter((a) => a.id !== action.id), alarmNextFireAt,
      pendingSnoozes: state.pendingSnoozes.filter((s) => s.alarmId !== action.id), ringingQueue: state.ringingQueue.filter((r) => r.kind !== 'alarm' || r.alarmId !== action.id) };
  } else if (action.type === 'dismiss') {
    state = { ...state, ringingQueue: state.ringingQueue.filter((r) => r.id !== targetAlertId) };
  } else if (action.type === 'snooze') {
    const current = state.ringingQueue.find((r) => r.id === targetAlertId);
    if (current?.kind !== 'alarm') return state;
    const minutes = action.minutes ?? current.snoozeMinutes;
    if (!id(action.id) || !validSnooze(minutes)) return state;
    const snooze = { id: action.id, alarmId: current.alarmId, label: current.label, snoozeMinutes: minutes, fireAt: now + minutes * 60_000 };
    state = { ...state, ringingQueue: state.ringingQueue.filter((r) => r.id !== targetAlertId), pendingSnoozes: [...state.pendingSnoozes.filter((s) => s.alarmId !== current.alarmId), snooze] };
  }
  return tickRuntime(state, now);
}

export function createAlarm(input: AlarmInput, alarmId: string): Alarm | null {
  return normalizeAlarm({ ...input, id: alarmId });
}
