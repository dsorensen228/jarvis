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
  label: string;
  snoozeMinutes: number;
};

export type AlarmInput = Omit<Alarm, 'id' | 'label' | 'snoozeMinutes'> &
  Partial<Pick<Alarm, 'label' | 'snoozeMinutes'>>;

export type Timer = {
  id: string;
  label: string;
  durationMs: number;
  status: 'running' | 'paused' | 'finished';
  /** Absolute deadline is authoritative while running. */
  endTime: number | null;
  /** Stored remainder when paused; derived from endTime for the context's running timers. */
  remainingMs: number;
  createdAt: number;
};

export type RecentTimer = { durationMs: number; label: string };

type RingBase = {
  id: string;
  label: string;
  fireAt: number;
  /** null until this alert reaches the front of the queue. */
  startedAt: number | null;
  silent: boolean;
  /** Old silent repeats of the same source are coalesced rather than lost. */
  occurrences: number;
};

export type RingEvent = RingBase & (
  | { kind: 'timer'; timerId: string; durationMs: number }
  | { kind: 'alarm'; alarmId: string; snoozeMinutes: number }
);

export type Ringing = { kind: 'none' } | RingEvent;

export type DeletedAlarmSnapshot = {
  alarm: Alarm;
  nextFireAt: number | null;
  pendingSnoozes: PendingSnooze[];
  ringingQueue: RingEvent[];
};

export type TimerRuntime = {
  version: 2;
  timers: Timer[];
  alarms: Alarm[];
  alarmNextFireAt: Record<string, number>;
  pendingSnoozes: PendingSnooze[];
  ringingQueue: RingEvent[];
  recentTimers: RecentTimer[];
};

export type PendingSnooze = {
  id: string;
  fireAt: number;
  alarmId: string;
  label: string;
  snoozeMinutes: number;
};

/** Persisted session timer: running uses absolute end time. */
export type SessionTimerState = { mode: 'running'; endTime: number };
