import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadAlarms, saveAlarms } from './alarmStorage';
import { nextFireAfter } from './nextAlarm';
import { FullscreenTimerAlarm } from './FullscreenTimerAlarm';
import { TimerMiniBar } from './TimerMiniBar';
import { loadSessionTimer, saveSessionTimer } from './timerSession';
import type { Alarm, PendingSnooze, RepeatRule, SessionTimerState } from './types';
import {
  primeAlarmAudio,
  startAlarmToneLoop,
  stopAlarmToneLoop,
} from './alarmTone';

export type TimerPhase = { status: 'idle' } | { status: 'running'; endTime: number };

export type Ringing =
  | { kind: 'none' }
  | { kind: 'timer' }
  | { kind: 'alarm'; alarmId: string; label: string };

type WallEvent =
  | { kind: 'alarm'; alarm: Alarm; fireAt: number }
  | { kind: 'snooze'; snooze: PendingSnooze; fireAt: number };

type TimerAlarmContextValue = {
  alarms: Alarm[];
  timer: TimerPhase;
  ringing: Ringing;
  timerRemainingMs: number;
  miniBarDismissed: boolean;
  setMiniBarDismissed: (v: boolean) => void;
  startTimer: (durationMs: number) => void;
  resetTimer: () => void;
  cancelTimer: () => void;
  dismissRinging: () => void;
  snoozeAlarm: () => void;
  addAlarm: (a: Omit<Alarm, 'id'>) => void;
  updateAlarm: (id: string, patch: Partial<Omit<Alarm, 'id'>>) => void;
  removeAlarm: (id: string) => void;
};

const TimerAlarmContext = createContext<TimerAlarmContextValue | null>(null);

const SNOOZE_MS = 10 * 60_000;

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function sessionFromPhase(phase: TimerPhase): SessionTimerState | null {
  if (phase.status === 'idle') return null;
  return { mode: 'running', endTime: phase.endTime };
}

function hydrateTimerFromSession(): TimerPhase {
  const s = loadSessionTimer();
  if (!s) return { status: 'idle' };
  if (s.endTime <= Date.now()) return { status: 'idle' };
  return { status: 'running', endTime: s.endTime };
}

function nextWallEvents(
  alarms: Alarm[],
  snoozes: PendingSnooze[],
  from: Date
): WallEvent[] {
  const out: WallEvent[] = [];
  for (const a of alarms) {
    if (!a.enabled) continue;
    const fireAt = nextFireAfter(from, a.hour, a.minute, a.repeat).getTime();
    out.push({ kind: 'alarm', alarm: a, fireAt });
  }
  for (const s of snoozes) {
    out.push({ kind: 'snooze', snooze: s, fireAt: s.fireAt });
  }
  return out;
}

function parseRepeatArg(v: unknown): RepeatRule | null {
  if (v === 'once' || v === 'one_time') return { kind: 'once' };
  if (v === 'daily') return { kind: 'daily' };
  if (typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'weekly') {
    const wd = Number((v as { weekday?: unknown }).weekday);
    if (Number.isFinite(wd) && wd >= 0 && wd <= 6) return { kind: 'weekly', weekday: wd };
  }
  if (typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'custom') {
    const w = (v as { weekdays?: unknown }).weekdays;
    if (Array.isArray(w)) {
      const days = w.map(Number).filter((d) => d >= 0 && d <= 6);
      if (days.length) return { kind: 'custom', weekdays: days };
    }
  }
  return null;
}

export function TimerAlarmProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [alarms, setAlarms] = useState<Alarm[]>(() => loadAlarms());
  const [timer, setTimer] = useState<TimerPhase>(() => hydrateTimerFromSession());
  const [ringing, setRinging] = useState<Ringing>({ kind: 'none' });
  const [timerDisplayRev, setTimerDisplayRev] = useState(0);
  const [pendingSnoozes, setPendingSnoozes] = useState<PendingSnooze[]>([]);
  const [miniBarDismissed, setMiniBarDismissed] = useState(false);

  const wallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alarmToneStopRef = useRef<(() => void) | null>(null);

  const startTimer = useCallback((durationMs: number) => {
    if (durationMs <= 0) return;
    primeAlarmAudio();
    setTimer({ status: 'running', endTime: Date.now() + durationMs });
    setMiniBarDismissed(false);
  }, []);

  const cancelTimer = useCallback(() => {
    setTimer({ status: 'idle' });
    saveSessionTimer(null);
    setMiniBarDismissed(false);
  }, []);

  const resetTimer = useCallback(() => {
    setTimer({ status: 'idle' });
    saveSessionTimer(null);
  }, []);

  const addAlarm = useCallback((a: Omit<Alarm, 'id'>) => {
    setAlarms((prev) => [...prev, { ...a, id: newId() }]);
  }, []);

  const updateAlarm = useCallback((id: string, patch: Partial<Omit<Alarm, 'id'>>) => {
    setAlarms((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const removeAlarm = useCallback((id: string) => {
    setAlarms((prev) => prev.filter((x) => x.id !== id));
  }, []);

  useEffect(() => {
    saveAlarms(alarms);
  }, [alarms]);

  useEffect(() => {
    saveSessionTimer(sessionFromPhase(timer));
  }, [timer]);

  useEffect(() => {
    if (pathname.startsWith('/timer')) setMiniBarDismissed(false);
  }, [pathname]);

  const timerRemainingMs = useMemo(() => {
    if (timer.status === 'idle') return 0;
    return Math.max(0, timer.endTime - Date.now());
  }, [timer, timerDisplayRev]);

  const runningEndTime = timer.status === 'running' ? timer.endTime : null;
  useEffect(() => {
    if (runningEndTime === null) return;
    const id = window.setInterval(() => setTimerDisplayRev((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [runningEndTime]);

  useEffect(() => {
    if (timer.status !== 'running') return;
    if (timer.endTime - Date.now() > 0) return;
    setRinging({ kind: 'timer' });
    setTimer({ status: 'idle' });
    saveSessionTimer(null);
  }, [timer, timerDisplayRev]);

  useEffect(() => {
    if (ringing.kind === 'none') {
      stopAlarmToneLoop();
      alarmToneStopRef.current = null;
      return;
    }
    let cancelled = false;
    void startAlarmToneLoop().then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      alarmToneStopRef.current = stop;
    });
    return () => {
      cancelled = true;
      if (alarmToneStopRef.current) {
        alarmToneStopRef.current();
        alarmToneStopRef.current = null;
      }
      stopAlarmToneLoop();
    };
  }, [ringing.kind]);

  const clearWallTimeout = useCallback(() => {
    if (wallTimeoutRef.current !== null) {
      window.clearTimeout(wallTimeoutRef.current);
      wallTimeoutRef.current = null;
    }
  }, []);

  const armWallClock = useCallback(() => {
    clearWallTimeout();
    if (ringing.kind !== 'none') return;

    const from = new Date();
    const events = nextWallEvents(alarms, pendingSnoozes, from);
    if (events.length === 0) return;

    let next: WallEvent | null = null;
    for (const e of events) {
      if (!next || e.fireAt < next.fireAt) next = e;
    }
    if (!next) return;

    const delay = Math.max(0, next.fireAt - Date.now());

    wallTimeoutRef.current = window.setTimeout(() => {
      wallTimeoutRef.current = null;

      if (next!.kind === 'snooze') {
        const s = next!.snooze;
        setPendingSnoozes((prev) => prev.filter((p) => p.id !== s.id));
        setRinging({ kind: 'alarm', alarmId: s.alarmId, label: s.label });
        return;
      }

      const a = next!.alarm;
      setRinging({ kind: 'alarm', alarmId: a.id, label: 'Alarm' });
    }, delay);
  }, [alarms, pendingSnoozes, ringing.kind, clearWallTimeout]);

  useEffect(() => {
    armWallClock();
    return () => clearWallTimeout();
  }, [armWallClock]);

  const dismissRinging = useCallback(() => {
    setRinging((r) => {
      if (r.kind === 'alarm') {
        const id = r.alarmId;
        setAlarms((prev) => {
          const al = prev.find((x) => x.id === id);
          if (al?.repeat.kind === 'once') return prev.filter((x) => x.id !== id);
          return prev;
        });
      }
      return { kind: 'none' };
    });
    navigate('/standby');
  }, [navigate]);

  const snoozeAlarm = useCallback(() => {
    setRinging((r) => {
      if (r.kind !== 'alarm') return r;
      const label = r.label;
      const alarmId = r.alarmId;
      setAlarms((prev) => {
        const al = prev.find((x) => x.id === alarmId);
        if (al?.repeat.kind === 'once') return prev.filter((x) => x.id !== alarmId);
        return prev;
      });
      setPendingSnoozes((prev) => [
        ...prev,
        {
          id: newId(),
          fireAt: Date.now() + SNOOZE_MS,
          alarmId,
          label,
        },
      ]);
      return { kind: 'none' };
    });
    navigate('/standby');
  }, [navigate]);

  useEffect(() => {
    const onJarvis = (ev: Event) => {
      const e = ev as CustomEvent<Record<string, unknown>>;
      const p = e.detail;
      if (!p || p.type !== 'client_action') return;
      const action = String(p.action || '');
      const args = (p.args as Record<string, unknown>) || {};

      if (action === 'start_timer') {
        const s = Number(args.seconds);
        if (Number.isFinite(s) && s > 0) startTimer(Math.round(s * 1000));
        return;
      }
      if (action === 'stop_timer') {
        cancelTimer();
        return;
      }
      if (action === 'navigate_timer' || action === 'open_timer') {
        navigate('/timer');
        return;
      }
      if (action === 'navigate_alarms' || action === 'open_alarms') {
        navigate('/timer/alarms');
        return;
      }
      if (action === 'alarm_add') {
        const hour = Math.min(23, Math.max(0, Number(args.hour)));
        const minute = Math.min(59, Math.max(0, Number(args.minute)));
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
        let repeat = parseRepeatArg(args.repeat ?? args.repeat_kind);
        if (
          repeat === null &&
          (args.repeat === 'weekly' || args.repeat_kind === 'weekly')
        ) {
          const wd = Number(args.weekday);
          if (Number.isFinite(wd) && wd >= 0 && wd <= 6) {
            repeat = { kind: 'weekly', weekday: wd };
          }
        }
        if (!repeat) return;
        addAlarm({ hour, minute, enabled: true, repeat });
        return;
      }
      if (action === 'alarm_remove_at') {
        const hour = Number(args.hour);
        const minute = Number(args.minute);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
        setAlarms((prev) => {
          const hit = prev.find((a) => a.hour === hour && a.minute === minute);
          if (!hit) return prev;
          return prev.filter((x) => x.id !== hit.id);
        });
        return;
      }
      if (action === 'alarm_set_enabled') {
        const hour = Number(args.hour);
        const minute = Number(args.minute);
        const enabled = Boolean(args.enabled);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
        setAlarms((prev) =>
          prev.map((a) =>
            a.hour === hour && a.minute === minute ? { ...a, enabled } : a
          )
        );
      }
    };
    window.addEventListener('jarvis-device-action', onJarvis);
    return () => window.removeEventListener('jarvis-device-action', onJarvis);
  }, [addAlarm, cancelTimer, navigate, startTimer]);

  const value: TimerAlarmContextValue = {
    alarms,
    timer,
    ringing,
    timerRemainingMs,
    miniBarDismissed,
    setMiniBarDismissed,
    startTimer,
    resetTimer,
    cancelTimer,
    dismissRinging,
    snoozeAlarm,
    addAlarm,
    updateAlarm,
    removeAlarm,
  };

  return (
    <TimerAlarmContext.Provider value={value}>
      {children}
      <TimerMiniBar />
      <FullscreenTimerAlarm />
    </TimerAlarmContext.Provider>
  );
}

export function useTimerAlarm(): TimerAlarmContextValue {
  const v = useContext(TimerAlarmContext);
  if (!v) throw new Error('useTimerAlarm must be used within TimerAlarmProvider');
  return v;
}
