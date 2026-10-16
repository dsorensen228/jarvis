/**
 * Weekday 0 = Sunday … 6 = Saturday (matches Date#getDay()).
 */

export type RepeatRule =
  | { kind: 'once' }
  | { kind: 'daily' }
  | { kind: 'weekly'; weekday: number }
  | { kind: 'custom'; weekdays: number[] };

export type Alarm = {
  id: string;
  hour: number;
  minute: number;
  enabled: boolean;
  repeat: RepeatRule;
};

export type PendingSnooze = {
  id: string;
  fireAt: number;
  alarmId: string;
  label: string;
};

/** Persisted session timer: running uses absolute end time. */
export type SessionTimerState = { mode: 'running'; endTime: number };
