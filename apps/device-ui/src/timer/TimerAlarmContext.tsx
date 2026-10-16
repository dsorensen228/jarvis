import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FullscreenTimerAlarm } from './FullscreenTimerAlarm';
import { TimerMiniBar } from './TimerMiniBar';
import { loadTimerRuntime, saveTimerRuntime } from './timerSession';
import { applyRuntimeAction, clockNumber, createAlarm, normalizeRepeat, snapshotAlarm, tickRuntime, timerRemaining, timerToCancel, type RuntimeAction } from './timerRuntime';
import type { Alarm, AlarmInput, DeletedAlarmSnapshot, PendingSnooze, RecentTimer, RepeatRule, RingEvent, Ringing, Timer, TimerRuntime } from './types';
import { primeAlarmAudio, startAlarmToneLoop, stopAlarmToneLoop } from './alarmTone';

export type { Ringing } from './types';
export type TimerAlarmContextValue = {
  alarms: Alarm[];
  timers: Timer[];
  recentTimers: RecentTimer[];
  now: number;
  alarmNextFireAt: Record<string, number>;
  nextAlarm: { alarm: Alarm; fireAt: number } | null;
  pendingSnoozes: PendingSnooze[];
  ringingQueue: RingEvent[];
  persistenceAvailable: boolean;
  ringing: Ringing;
  miniBarDismissed: boolean;
  setMiniBarDismissed: (v: boolean) => void;
  startTimer: (durationMs: number, label?: string) => string | null;
  pauseTimer: (id: string) => void;
  resumeTimer: (id: string) => void;
  addTimerTime: (id: string, durationMs: number) => void;
  restartTimer: (id: string) => void;
  removeTimer: (id: string) => void;
  dismissRinging: () => void;
  snoozeAlarm: (minutes?: number) => void;
  cancelSnooze: (alarmId: string) => void;
  addAlarm: (a: AlarmInput) => string | null;
  updateAlarm: (id: string, patch: Partial<Omit<Alarm, 'id'>>) => void;
  removeAlarm: (id: string) => DeletedAlarmSnapshot | null;
  restoreAlarm: (snapshot: DeletedAlarmSnapshot) => void;
};

const TimerAlarmContext = createContext<TimerAlarmContextValue | null>(null);
const newId = (): string => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `clock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
function parseRepeatArg(value: unknown, weekday: unknown): RepeatRule | null {
  if (value === 'once' || value === 'one_time' || value == null) return { kind: 'once' };
  if (value === 'daily') return { kind: 'daily' };
  if (value === 'weekly') return normalizeRepeat({ kind: 'weekly', weekday: clockNumber(weekday) });
  return normalizeRepeat(value);
}

export function TimerAlarmProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [runtime, setRuntime] = useState<TimerRuntime>(() => loadTimerRuntime());
  const runtimeRef = useRef(runtime);
  const [now, setNow] = useState(Date.now);
  const [persistenceAvailable, setPersistenceAvailable] = useState(true);
  const [miniBarDismissed, setMiniBarDismissed] = useState(false);

  // Persist complete transitions before returning: rapid voice/UI actions and an
  // immediate reload after Snooze must observe the same authoritative state.
  const replace = useCallback((next: TimerRuntime) => {
    if (next === runtimeRef.current) return;
    runtimeRef.current = next;
    setRuntime(next);
    setPersistenceAvailable(saveTimerRuntime(next));
  }, []);
  const act = useCallback((action: RuntimeAction) => {
    const at = Date.now();
    const next = applyRuntimeAction(runtimeRef.current, action, at);
    replace(next);
    setNow(at);
    return next;
  }, [replace]);
  useEffect(() => { setPersistenceAvailable(saveTimerRuntime(runtimeRef.current)); }, []);
  useEffect(() => {
    const advance = () => { const at = Date.now(); replace(tickRuntime(runtimeRef.current, at)); setNow(at); };
    const interval = window.setInterval(advance, 250);
    document.addEventListener('visibilitychange', advance);
    window.addEventListener('pageshow', advance);
    window.addEventListener('focus', advance);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', advance);
      window.removeEventListener('pageshow', advance);
      window.removeEventListener('focus', advance);
    };
  }, [replace]);
  useEffect(() => { if (pathname.startsWith('/timer')) setMiniBarDismissed(false); }, [pathname]);

  const startTimer = useCallback((durationMs: number, label?: string) => {
    const id = newId();
    const next = act({ type: 'start', id, durationMs, label });
    if (!next.timers.some((timer) => timer.id === id)) return null;
    primeAlarmAudio();
    setMiniBarDismissed(false);
    return id;
  }, [act]);
  const pauseTimer = useCallback((id: string) => { act({ type: 'pause', id }); }, [act]);
  const resumeTimer = useCallback((id: string) => { primeAlarmAudio(); act({ type: 'resume', id }); setMiniBarDismissed(false); }, [act]);
  const addTimerTime = useCallback((id: string, durationMs: number) => { primeAlarmAudio(); act({ type: 'add-time', id, durationMs }); }, [act]);
  const restartTimer = useCallback((id: string) => { primeAlarmAudio(); act({ type: 'restart', id }); setMiniBarDismissed(false); }, [act]);
  const removeTimer = useCallback((id: string) => { act({ type: 'remove-timer', id }); }, [act]);
  const cancelTimer = useCallback((idOrLabel?: string) => {
    const target = timerToCancel(runtimeRef.current, idOrLabel);
    if (target) removeTimer(target);
  }, [removeTimer]);
  const addAlarm = useCallback((input: AlarmInput) => {
    const id = newId();
    const alarm = createAlarm(input, id);
    if (!alarm) return null;
    const next = act({ type: 'add-alarm', alarm });
    if (!next.alarms.some((a) => a.id === id)) return null;
    primeAlarmAudio();
    return id;
  }, [act]);
  const updateAlarm = useCallback((id: string, patch: Partial<Omit<Alarm, 'id'>>) => { primeAlarmAudio(); act({ type: 'update-alarm', id, patch }); }, [act]);
  const removeAlarm = useCallback((id: string) => {
    const snapshot = snapshotAlarm(runtimeRef.current, id, Date.now());
    if (snapshot) act({ type: 'remove-alarm', id });
    return snapshot;
  }, [act]);
  const restoreAlarm = useCallback((snapshot: DeletedAlarmSnapshot) => { act({ type: 'restore-alarm', snapshot }); }, [act]);
  const displayedAlertId = runtime.ringingQueue.at(0)?.id;
  const dismissRinging = useCallback(() => { if (displayedAlertId) act({ type: 'dismiss', id: displayedAlertId }); }, [act, displayedAlertId]);
  const snoozeAlarm = useCallback((minutes?: number) => { if (displayedAlertId) act({ type: 'snooze', id: newId(), minutes, eventId: displayedAlertId }); }, [act, displayedAlertId]);
  const cancelSnooze = useCallback((alarmId: string) => { act({ type: 'cancel-snooze', id: alarmId }); }, [act]);

  const ringing: Ringing = runtime.ringingQueue.at(0) ?? { kind: 'none' };
  const ringingId = ringing.kind === 'none' ? null : ringing.id;
  const silent = ringing.kind === 'none' || ringing.silent;
  useEffect(() => {
    if (silent) { stopAlarmToneLoop(); return; }
    let cancelled = false;
    let stop: (() => void) | undefined;
    void startAlarmToneLoop().then((finish) => { if (cancelled) finish(); else stop = finish; }).catch(() => { /* Keep the visible alert if browser audio is unavailable. */ });
    return () => { cancelled = true; stop?.(); stopAlarmToneLoop(); };
  }, [ringingId, silent]);

  useEffect(() => {
    const onJarvis = (event: Event) => {
      const payload = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!payload || payload.type !== 'client_action') return;
      const action = String(payload.action || '');
      const args = typeof payload.args === 'object' && payload.args !== null ? payload.args as Record<string, unknown> : {};
      if (action === 'start_timer') {
        const seconds = clockNumber(args.seconds);
        if (Number.isFinite(seconds) && seconds > 0) startTimer(Math.round(seconds * 1000), typeof args.label === 'string' ? args.label : undefined);
      } else if (action === 'stop_timer') {
        const target = args.timer_id ?? args.label;
        cancelTimer(typeof target === 'string' ? target : undefined);
      } else if (action === 'navigate_timer' || action === 'open_timer') navigate('/timer');
      else if (action === 'navigate_alarms' || action === 'open_alarms') navigate('/timer/alarms');
      else if (action === 'alarm_add') {
        const repeat = parseRepeatArg(args.repeat ?? args.repeat_kind, args.weekday);
        if (repeat) addAlarm({ hour: clockNumber(args.hour), minute: clockNumber(args.minute), enabled: true, repeat,
          label: typeof args.label === 'string' ? args.label : undefined,
          snoozeMinutes: args.snooze_minutes == null ? undefined : clockNumber(args.snooze_minutes) });
      } else if (action === 'alarm_remove_at') {
        const alarm = runtimeRef.current.alarms.find((a) => a.hour === clockNumber(args.hour) && a.minute === clockNumber(args.minute));
        if (alarm) removeAlarm(alarm.id);
      } else if (action === 'alarm_set_enabled') {
        const enabled = args.enabled === true || args.enabled === 'true' || args.enabled === 1 ? true : args.enabled === false || args.enabled === 'false' || args.enabled === 0 ? false : null;
        if (enabled === null) return;
        for (const alarm of runtimeRef.current.alarms.filter((a) => a.hour === clockNumber(args.hour) && a.minute === clockNumber(args.minute))) updateAlarm(alarm.id, { enabled });
      }
    };
    window.addEventListener('jarvis-device-action', onJarvis);
    return () => window.removeEventListener('jarvis-device-action', onJarvis);
  }, [addAlarm, cancelTimer, navigate, removeAlarm, startTimer, updateAlarm]);

  const timers = useMemo(() => runtime.timers.map((timer) => ({ ...timer, remainingMs: timerRemaining(timer, now) })), [runtime.timers, now]);
  const nextAlarm = useMemo(() => {
    const scheduled = runtime.alarms.flatMap((alarm) => {
      const due = runtime.alarmNextFireAt[alarm.id];
      const snoozes = runtime.pendingSnoozes.filter((s) => s.alarmId === alarm.id).map((s) => s.fireAt);
      const times = [...(due === undefined ? [] : [due]), ...snoozes];
      return times.length ? [{ alarm, fireAt: Math.min(...times) }] : [];
    });
    return scheduled.sort((a, b) => a.fireAt - b.fireAt)[0] ?? null;
  }, [runtime.alarms, runtime.alarmNextFireAt, runtime.pendingSnoozes]);

  const value: TimerAlarmContextValue = {
    alarms: runtime.alarms, timers, recentTimers: runtime.recentTimers, now, nextAlarm,
    alarmNextFireAt: runtime.alarmNextFireAt, pendingSnoozes: runtime.pendingSnoozes, ringingQueue: runtime.ringingQueue,
    persistenceAvailable, ringing,
    miniBarDismissed, setMiniBarDismissed, startTimer, pauseTimer, resumeTimer, addTimerTime, restartTimer, removeTimer,
    dismissRinging, snoozeAlarm, cancelSnooze, addAlarm, updateAlarm, removeAlarm, restoreAlarm,
  };
  return <TimerAlarmContext.Provider value={value}>{children}<TimerMiniBar /><FullscreenTimerAlarm /></TimerAlarmContext.Provider>;
}

export function useTimerAlarm(): TimerAlarmContextValue {
  const value = useContext(TimerAlarmContext);
  if (!value) throw new Error('useTimerAlarm must be used within TimerAlarmProvider');
  return value;
}
