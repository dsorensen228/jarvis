import type { Alarm } from './types';

const KEY = 'jarvis_alarms_v1';

function parseAlarms(raw: string | null): Alarm[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(isAlarm);
  } catch {
    return [];
  }
}

function isAlarm(x: unknown): x is Alarm {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (typeof o.hour !== 'number' || o.hour < 0 || o.hour > 23) return false;
  if (typeof o.minute !== 'number' || o.minute < 0 || o.minute > 59) return false;
  if (typeof o.enabled !== 'boolean') return false;
  if (typeof o.repeat !== 'object' || o.repeat === null) return false;
  const r = o.repeat as { kind?: string };
  if (r.kind === 'once') return true;
  if (r.kind === 'daily') return true;
  if (r.kind === 'weekly' && typeof (r as { weekday?: number }).weekday === 'number') {
    const w = (r as { weekday: number }).weekday;
    return w >= 0 && w <= 6;
  }
  if (r.kind === 'custom' && Array.isArray((r as { weekdays?: unknown }).weekdays)) {
    const wd = (r as { weekdays: unknown[] }).weekdays;
    return wd.every((d) => typeof d === 'number' && d >= 0 && d <= 6);
  }
  return false;
}

export function loadAlarms(): Alarm[] {
  if (typeof localStorage === 'undefined') return [];
  return parseAlarms(localStorage.getItem(KEY));
}

export function saveAlarms(alarms: Alarm[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(alarms));
}
