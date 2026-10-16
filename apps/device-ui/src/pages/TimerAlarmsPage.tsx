import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Alarm, RepeatRule } from '../timer/types';
import { useTimerAlarm } from '../timer/TimerAlarmContext';

const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTime12(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function repeatSummary(r: RepeatRule): string {
  if (r.kind === 'once') return '1×';
  if (r.kind === 'daily') return 'Daily';
  if (r.kind === 'weekly') return `Weekly (${WEEKDAY_SHORT[r.weekday]})`;
  const days = r.weekdays.map((d: number) => WEEKDAY_SHORT[d]).join(', ');
  return `Custom (${days})`;
}

function repeatFromForm(
  repeatKind: 'once' | 'daily' | 'weekly' | 'custom',
  weeklyDay: number,
  customOn: boolean[]
): RepeatRule | null {
  if (repeatKind === 'once') return { kind: 'once' };
  if (repeatKind === 'daily') return { kind: 'daily' };
  if (repeatKind === 'weekly') return { kind: 'weekly', weekday: weeklyDay };
  const weekdays = customOn.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  if (weekdays.length === 0) return null;
  return { kind: 'custom', weekdays };
}

function formFromAlarm(a: Alarm): {
  hour: number;
  minute: number;
  repeatKind: 'once' | 'daily' | 'weekly' | 'custom';
  weeklyDay: number;
  customOn: boolean[];
} {
  let repeatKind: 'once' | 'daily' | 'weekly' | 'custom' = 'daily';
  let weeklyDay = 1;
  const customOn = [false, false, false, false, false, false, false];
  if (a.repeat.kind === 'once') repeatKind = 'once';
  else if (a.repeat.kind === 'daily') repeatKind = 'daily';
  else if (a.repeat.kind === 'weekly') {
    repeatKind = 'weekly';
    weeklyDay = a.repeat.weekday;
  } else {
    repeatKind = 'custom';
    for (const d of a.repeat.weekdays) {
      if (d >= 0 && d <= 6) customOn[d] = true;
    }
  }
  return {
    hour: a.hour,
    minute: a.minute,
    repeatKind,
    weeklyDay,
    customOn,
  };
}

function IconPencil() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20h4l10.5-10.5a2 2 0 000-2.83L17.33 5.5a2 2 0 00-2.83 0L4 15V20z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M13 7l4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 7h14M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2M9 7v12a1 1 0 001 1h4a1 1 0 001-1V7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TimerAlarmsPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const alarmsTab = pathname.includes('/timer/alarms');

  const {
    alarms,
    timer,
    timerRemainingMs,
    startTimer,
    cancelTimer,
    addAlarm,
    updateAlarm,
    removeAlarm,
  } = useTimerAlarm();

  const [addFormOpen, setAddFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formHour, setFormHour] = useState(7);
  const [formMinute, setFormMinute] = useState(0);
  const [repeatKind, setRepeatKind] = useState<'once' | 'daily' | 'weekly' | 'custom'>('once');
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [customOn, setCustomOn] = useState(() => [true, true, true, true, true, false, false]);

  const [durH, setDurH] = useState(0);
  const [durM, setDurM] = useState(5);
  const [durS, setDurS] = useState(0);

  const alarmModalOpen = addFormOpen || editingId !== null;

  const resetForm = useCallback(() => {
    setEditingId(null);
    setAddFormOpen(false);
    setFormHour(7);
    setFormMinute(0);
    setRepeatKind('once');
    setWeeklyDay(1);
    setCustomOn([true, true, true, true, true, false, false]);
  }, []);

  useEffect(() => {
    if (!alarmsTab) resetForm();
  }, [alarmsTab, resetForm]);

  const onEdit = useCallback(
    (a: Alarm) => {
      const f = formFromAlarm(a);
      setEditingId(a.id);
      setAddFormOpen(false);
      setFormHour(f.hour);
      setFormMinute(f.minute);
      setRepeatKind(f.repeatKind);
      setWeeklyDay(f.weeklyDay);
      setCustomOn(f.customOn);
      navigate('/timer/alarms');
    },
    [navigate]
  );

  const onSubmitAlarm = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const repeat = repeatFromForm(repeatKind, weeklyDay, customOn);
      if (repeat === null) return;
      const prev = editingId ? alarms.find((a) => a.id === editingId) : undefined;
      const payload = {
        hour: Math.min(23, Math.max(0, formHour)),
        minute: Math.min(59, Math.max(0, formMinute)),
        enabled: prev?.enabled ?? true,
        repeat,
      };
      if (editingId) {
        updateAlarm(editingId, payload);
      } else {
        addAlarm(payload);
      }
      resetForm();
    },
    [
      addAlarm,
      updateAlarm,
      customOn,
      alarms,
      editingId,
      formHour,
      formMinute,
      repeatKind,
      resetForm,
      weeklyDay,
    ]
  );

  const onRemoveAlarm = useCallback(
    (id: string) => {
      if (typeof window !== 'undefined' && window.confirm('Delete this alarm?')) {
        removeAlarm(id);
        if (editingId === id) resetForm();
      }
    },
    [editingId, removeAlarm, resetForm]
  );

  const bumpHour = useCallback((delta: number) => {
    setFormHour((h) => Math.min(23, Math.max(0, h + delta)));
  }, []);

  const bumpMinute = useCallback((delta: number) => {
    setFormMinute((m) => Math.min(59, Math.max(0, m + delta)));
  }, []);

  const bumpDurH = useCallback((d: number) => {
    setDurH((h) => Math.min(99, Math.max(0, h + d)));
  }, []);
  const bumpDurM = useCallback((d: number) => {
    setDurM((m) => Math.min(59, Math.max(0, m + d)));
  }, []);
  const bumpDurS = useCallback((d: number) => {
    setDurS((s) => Math.min(59, Math.max(0, s + d)));
  }, []);

  const onStartTimer = useCallback(() => {
    const sec = durH * 3600 + durM * 60 + durS;
    if (sec <= 0) return;
    startTimer(sec * 1000);
  }, [durH, durM, durS, startTimer]);

  const sortedAlarms = useMemo(
    () => [...alarms].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)),
    [alarms]
  );

  useEffect(() => {
    if (alarmsTab && editingId && !alarms.some((a) => a.id === editingId)) {
      resetForm();
    }
  }, [alarmsTab, editingId, alarms, resetForm]);

  const timerIdle = timer.status === 'idle';

  return (
    <div className="page timer-alarms">
      <div
        className="timer-alarms-segments"
        role="tablist"
        aria-label="Timer or alarms"
      >
        <button
          type="button"
          role="tab"
          id="tab-timer"
          aria-selected={!alarmsTab}
          className={`timer-alarms-segment${!alarmsTab ? ' active' : ''}`}
          onClick={() => navigate('/timer')}
        >
          Timer
        </button>
        <button
          type="button"
          role="tab"
          id="tab-alarms"
          aria-selected={alarmsTab}
          className={`timer-alarms-segment${alarmsTab ? ' active' : ''}`}
          onClick={() => navigate('/timer/alarms')}
        >
          Alarms
        </button>
      </div>

      {!alarmsTab && (
        <section
          className="timer-alarms-section"
          role="tabpanel"
          aria-labelledby="tab-timer"
        >
          {timerIdle ? (
            <div className="timer-idle-panel">
              <p className="timer-alarms-field-label">Set duration</p>
              <div className="timer-hms-row">
                <div className="timer-alarms-stepper-col">
                  <span className="timer-alarms-field-label">H</span>
                  <div className="timer-alarms-stepper timer-alarms-stepper-vertical">
                    <button type="button" className="timer-alarms-stepper-btn" aria-label="Increase hours" onClick={() => bumpDurH(1)}>
                      +
                    </button>
                    <span className="timer-alarms-stepper-readout timer-hms-readout" aria-live="polite">
                      {durH}
                    </span>
                    <button type="button" className="timer-alarms-stepper-btn" aria-label="Decrease hours" onClick={() => bumpDurH(-1)}>
                      −
                    </button>
                  </div>
                </div>
                <div className="timer-alarms-stepper-col">
                  <span className="timer-alarms-field-label">M</span>
                  <div className="timer-alarms-stepper timer-alarms-stepper-vertical">
                    <button type="button" className="timer-alarms-stepper-btn" aria-label="Increase minutes" onClick={() => bumpDurM(1)}>
                      +
                    </button>
                    <span className="timer-alarms-stepper-readout timer-hms-readout" aria-live="polite">
                      {durM.toString().padStart(2, '0')}
                    </span>
                    <button type="button" className="timer-alarms-stepper-btn" aria-label="Decrease minutes" onClick={() => bumpDurM(-1)}>
                      −
                    </button>
                  </div>
                </div>
                <div className="timer-alarms-stepper-col">
                  <span className="timer-alarms-field-label">S</span>
                  <div className="timer-alarms-stepper timer-alarms-stepper-vertical">
                    <button type="button" className="timer-alarms-stepper-btn" aria-label="Increase seconds" onClick={() => bumpDurS(1)}>
                      +
                    </button>
                    <span className="timer-alarms-stepper-readout timer-hms-readout" aria-live="polite">
                      {durS.toString().padStart(2, '0')}
                    </span>
                    <button type="button" className="timer-alarms-stepper-btn" aria-label="Decrease seconds" onClick={() => bumpDurS(-1)}>
                      −
                    </button>
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="timer-alarms-btn primary timer-idle-start"
                disabled={durH * 3600 + durM * 60 + durS <= 0}
                onClick={onStartTimer}
              >
                Start
              </button>
            </div>
          ) : (
            <div className="timer-running-panel">
              <div className="timer-running-display" aria-live="polite">
                {formatCountdown(timerRemainingMs)}
              </div>
              <button type="button" className="timer-alarms-btn danger timer-running-cancel" onClick={() => cancelTimer()}>
                Cancel
              </button>
            </div>
          )}
        </section>
      )}

      {alarmsTab && (
        <section
          className="timer-alarms-section timer-alarms-alarms-panel"
          role="tabpanel"
          aria-labelledby="tab-alarms"
        >
          <div className="timer-alarms-alarms-toolbar">
            {!editingId && (
              <button
                type="button"
                className="timer-alarms-btn primary timer-alarms-add-toggle"
                onClick={() => setAddFormOpen(true)}
              >
                Add alarm
              </button>
            )}
          </div>

          <ul className="timer-alarms-list">
            {sortedAlarms.map((a) => (
              <li key={a.id} className={`timer-alarms-item${a.enabled ? '' : ' is-disabled'}`}>
                <div className="timer-alarms-item-row">
                  <div className="timer-alarms-item-main">
                    <span className="timer-alarms-item-time">{formatTime12(a.hour, a.minute)}</span>
                    <span className="timer-alarms-item-meta">{repeatSummary(a.repeat)}</span>
                  </div>
                  <div className="timer-alarms-item-actions">
                    <button
                      type="button"
                      className={`timer-alarms-toggle${a.enabled ? ' on' : ''}`}
                      aria-pressed={a.enabled}
                      onClick={() => updateAlarm(a.id, { enabled: !a.enabled })}
                    >
                      {a.enabled ? 'On' : 'Off'}
                    </button>
                    <button
                      type="button"
                      className="timer-alarms-icon-btn"
                      aria-label="Edit alarm"
                      onClick={() => onEdit(a)}
                    >
                      <IconPencil />
                    </button>
                    <button
                      type="button"
                      className="timer-alarms-icon-btn danger"
                      aria-label="Delete alarm"
                      onClick={() => onRemoveAlarm(a.id)}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {alarmModalOpen && (
            <div
              className="timer-alarms-modal-backdrop"
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget) resetForm();
              }}
            >
              <div className="timer-alarms-modal" role="dialog" aria-modal="true" aria-labelledby="alarm-modal-title">
                <h2 id="alarm-modal-title" className="timer-alarms-modal-title">
                  {editingId ? 'Edit alarm' : 'Add alarm'}
                </h2>
                <form className="timer-alarms-form timer-alarms-form-modal" onSubmit={onSubmitAlarm}>
                  <div className="timer-alarms-time-steppers">
                    <div className="timer-alarms-stepper-col">
                      <span className="timer-alarms-field-label">Hour</span>
                      <div className="timer-alarms-stepper timer-alarms-stepper-vertical">
                        <button type="button" className="timer-alarms-stepper-btn" aria-label="Increase hour" onClick={() => bumpHour(1)}>
                          +
                        </button>
                        <span className="timer-alarms-stepper-readout" aria-live="polite">
                          {formHour}
                        </span>
                        <button type="button" className="timer-alarms-stepper-btn" aria-label="Decrease hour" onClick={() => bumpHour(-1)}>
                          −
                        </button>
                      </div>
                    </div>
                    <div className="timer-alarms-stepper-col">
                      <span className="timer-alarms-field-label">Minute</span>
                      <div className="timer-alarms-stepper timer-alarms-stepper-vertical">
                        <button type="button" className="timer-alarms-stepper-btn" aria-label="Increase minute" onClick={() => bumpMinute(1)}>
                          +
                        </button>
                        <span className="timer-alarms-stepper-readout" aria-live="polite">
                          {formMinute.toString().padStart(2, '0')}
                        </span>
                        <button type="button" className="timer-alarms-stepper-btn" aria-label="Decrease minute" onClick={() => bumpMinute(-1)}>
                          −
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="timer-alarms-repeat">
                    <span className="timer-alarms-field-label">Repeat</span>
                    <div className="timer-alarms-repeat-btns timer-alarms-repeat-btns-4">
                      {(['once', 'daily', 'weekly', 'custom'] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={`timer-alarms-chip timer-alarms-chip-compact${repeatKind === k ? ' active' : ''}`}
                          onClick={() => setRepeatKind(k)}
                        >
                          {k === 'once' ? '1×' : k === 'daily' ? 'Daily' : k === 'weekly' ? 'Weekly' : 'Custom'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {repeatKind === 'weekly' && (
                    <div className="timer-alarms-week-row timer-alarms-week-row-equal">
                      {WEEKDAY_SHORT.map((d, i) => (
                        <button
                          key={d}
                          type="button"
                          className={`timer-alarms-chip sm${weeklyDay === i ? ' active' : ''}`}
                          onClick={() => setWeeklyDay(i)}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  )}
                  {repeatKind === 'custom' && (
                    <div className="timer-alarms-week-row timer-alarms-week-row-equal">
                      {WEEKDAY_SHORT.map((d, i) => (
                        <button
                          key={d}
                          type="button"
                          className={`timer-alarms-chip sm${customOn[i] ? ' active' : ''}`}
                          onClick={() =>
                            setCustomOn((prev) => {
                              const next = [...prev];
                              next[i] = !next[i];
                              return next;
                            })
                          }
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="timer-alarms-form-actions">
                    <button type="submit" className="timer-alarms-btn primary flex-grow">
                      {editingId ? 'Save' : 'Add'}
                    </button>
                    <button type="button" className="timer-alarms-btn flex-grow" onClick={resetForm}>
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
