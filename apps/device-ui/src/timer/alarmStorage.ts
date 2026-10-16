import { normalizeAlarm } from './timerRuntime';
import type { Alarm } from './types';

export const ALARMS_KEY = 'jarvis_alarms_v1';

export function parseAlarms(raw: string | null): Alarm[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data.flatMap((item) => {
      const alarm = normalizeAlarm(item);
      if (!alarm || seen.has(alarm.id)) return [];
      seen.add(alarm.id);
      return [alarm];
    });
  } catch { return []; }
}

export function loadAlarms(): Alarm[] {
  try { return typeof localStorage === 'undefined' ? [] : parseAlarms(localStorage.getItem(ALARMS_KEY)); }
  catch { return []; }
}

/** Keep the legacy alarm key readable for rollback; runtime v2 is authoritative. */
export function saveAlarms(alarms: Alarm[]): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(ALARMS_KEY, JSON.stringify(alarms)); }
  catch { /* Runtime persistence reports failure independently. */ }
}
