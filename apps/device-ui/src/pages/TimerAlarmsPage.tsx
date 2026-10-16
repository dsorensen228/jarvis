import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Alarm, DeletedAlarmSnapshot, RepeatRule, Timer } from '../timer/types';
import { useTimerAlarm } from '../timer/TimerAlarmContext';
import { nextFireAfter } from '../timer/nextAlarm';
import { ClockDialog } from '../timer/ClockDialog';
import { ClockNameEditor, ClockRing, TimePad } from '../timer/ClockInputs';
import { alarmTime, clockTime, countdown, DAY_NAMES, DAY_SHORT, durationLabel, occurrenceLabel, repeatLabel } from '../timer/clockPresentation';
import '../timer/clock.css';

const PRESETS = [
  { minutes: 3, label: 'Tea' }, { minutes: 5, label: 'Short break' },
  { minutes: 10, label: 'Quick task' }, { minutes: 15, label: 'Cooking' },
  { minutes: 25, label: 'Focus' }, { minutes: 60, label: 'One hour' },
];
const REPEAT_CHOICES = ['Once', 'Daily', 'Weekdays', 'Weekends', 'Custom'] as const;
type RepeatChoice = typeof REPEAT_CHOICES[number];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

function repeatChoice(repeat: RepeatRule): RepeatChoice {
  if (repeat.kind === 'once') return 'Once';
  if (repeat.kind === 'daily') return 'Daily';
  const days = repeat.kind === 'weekly' ? [repeat.weekday] : [...repeat.weekdays].sort();
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  return 'Custom';
}

function TimerComposer({ onClose }: { onClose: () => void }) {
  const { startTimer, now } = useTimerAlarm();
  const [values, setValues] = useState([0, 5, 0]);
  const [label, setLabel] = useState('');
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState('');
  const duration = (values[0] * 3600 + values[1] * 60 + values[2]) * 1000;
  const add = (minutes: number) => {
    const seconds = Math.min(359999, Math.floor(duration / 1000) + minutes * 60);
    setValues([Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]);
  };
  const start = () => {
    if (!duration) return;
    if (startTimer(duration, label)) onClose();
    else setError('Remove an existing timer to make room, then try again.');
  };
  return <ClockDialog title={naming ? 'Timer name' : 'New timer'} onClose={() => naming ? setNaming(false) : onClose()} wide>
    {naming ? <ClockNameEditor value={label} onChange={setLabel} onDone={() => setNaming(false)} suggestions={['Tea', 'Dinner', 'Focus', 'Laundry']} /> : <div className="clock-compose-grid">
      <TimePad fields={['Hours', 'Minutes', 'Seconds'].map((name, index) => ({ label: name, value: values[index], max: index ? 59 : 99 }))} initialField={1} onChange={(index, value) => setValues(old => old.map((current, i) => i === index ? value : current))} />
      <div className="clock-compose-options">
        <button type="button" className="clock-name-button" onClick={() => setNaming(true)}><span>Timer name</span><strong>{label || 'Add a name'}</strong><span aria-hidden>↗</span></button>
        <div className="clock-add-time" aria-label="Add time">{[1, 5, 15].map(minutes => <button type="button" key={minutes} onClick={() => add(minutes)}>+{minutes} min</button>)}</div>
        <div className="clock-compose-summary"><span>DURATION</span><strong>{durationLabel(duration)}</strong><p>{duration ? `Finishes at ${clockTime(now + duration)}` : 'Enter a duration.'}</p></div>
        {error && <p className="clock-error" role="alert">{error}</p>}
        <button type="button" className="clock-primary clock-start" disabled={!duration} onClick={start}>Start timer <span aria-hidden>→</span></button>
      </div>
    </div>}
  </ClockDialog>;
}

function AlarmEditor({ alarm, onClose }: { alarm: Alarm | null; onClose: () => void }) {
  const { addAlarm, updateAlarm, now } = useTimerAlarm();
  const [hour, setHour] = useState(alarm ? alarm.hour % 12 || 12 : 7);
  const [minute, setMinute] = useState(alarm?.minute ?? 0);
  const [pm, setPm] = useState(alarm ? alarm.hour >= 12 : false);
  const [label, setLabel] = useState(alarm?.label ?? '');
  const [naming, setNaming] = useState(false);
  const [choice, setChoice] = useState<RepeatChoice>(alarm ? repeatChoice(alarm.repeat) : 'Once');
  const [days, setDays] = useState<number[]>(alarm?.repeat.kind === 'custom' ? alarm.repeat.weekdays : alarm?.repeat.kind === 'weekly' ? [alarm.repeat.weekday] : [1, 2, 3, 4, 5]);
  const [snooze, setSnooze] = useState(alarm?.snoozeMinutes ?? 10);
  const snoozeChoices = [...new Set([5, 10, 15, 30, alarm?.snoozeMinutes ?? 10])].sort((a, b) => a - b);
  const [error, setError] = useState('');
  const repeat: RepeatRule = choice === 'Once' ? { kind: 'once' } : choice === 'Daily' ? { kind: 'daily' } : { kind: 'custom', weekdays: choice === 'Weekdays' ? [1, 2, 3, 4, 5] : choice === 'Weekends' ? [0, 6] : days };
  const valid = hour >= 1 && hour <= 12 && (choice !== 'Custom' || days.length > 0);
  const hour24 = hour % 12 + (pm ? 12 : 0);
  const save = () => {
    if (!valid) return;
    const payload = { hour: hour24, minute, repeat, label, snoozeMinutes: snooze, enabled: alarm?.enabled ?? true };
    if (alarm) updateAlarm(alarm.id, payload);
    else if (!addAlarm(payload)) { setError('Remove an existing alarm to make room, then try again.'); return; }
    onClose();
  };
  return <ClockDialog title={naming ? 'Alarm name' : alarm ? 'Edit alarm' : 'New alarm'} onClose={() => naming ? setNaming(false) : onClose()} wide>
    {naming ? <ClockNameEditor value={label} onChange={setLabel} onDone={() => setNaming(false)} suggestions={['Wake up', 'School run', 'Medication', 'Bedtime']} /> : <div className="clock-compose-grid clock-compose-grid--alarm">
      <div><TimePad fields={[{ label: 'Hour', value: hour, max: 12 }, { label: 'Minute', value: minute, max: 59 }]} onChange={(index, value) => index ? setMinute(value) : setHour(value)} /><div className="clock-period" role="group" aria-label="Time of day"><button type="button" aria-pressed={!pm} onClick={() => setPm(false)}>AM</button><button type="button" aria-pressed={pm} onClick={() => setPm(true)}>PM</button></div></div>
      <div className="clock-compose-options clock-alarm-options">
        <button type="button" className="clock-name-button" onClick={() => setNaming(true)}><span>Alarm name</span><strong>{label || 'Add a name'}</strong><span aria-hidden>↗</span></button>
        <fieldset className="clock-choice-field"><legend>Repeat</legend><div className="clock-repeat-options">{REPEAT_CHOICES.map(option => <button type="button" key={option} aria-pressed={choice === option} onClick={() => setChoice(option)}>{option}</button>)}</div></fieldset>
        {choice === 'Custom' && <div className="clock-weekdays" role="group" aria-label="Repeat days">{MONDAY_FIRST.map(day => <button type="button" key={day} aria-label={DAY_NAMES[day]} aria-pressed={days.includes(day)} onClick={() => setDays(old => old.includes(day) ? old.filter(value => value !== day) : [...old, day])}>{DAY_SHORT[day].slice(0, 1)}</button>)}</div>}
        {choice === 'Custom' && !days.length && <p className="clock-error" role="status">Choose at least one day.</p>}
        <fieldset className="clock-choice-field"><legend>Snooze</legend><div className="clock-snooze-options">{snoozeChoices.map(minutes => <button type="button" key={minutes} aria-pressed={snooze === minutes} onClick={() => setSnooze(minutes)}>{minutes} min</button>)}</div></fieldset>
        <p className="clock-next-preview">{valid ? `${alarm?.enabled === false ? 'When enabled: ' : 'Next: '}${occurrenceLabel(nextFireAfter(new Date(now), hour24, minute, repeat).getTime(), now)}` : hour < 1 ? 'Choose an hour from 1 to 12.' : 'Choose the days for this alarm.'}</p>
        {error && <p className="clock-error" role="alert">{error}</p>}
        <button type="button" className="clock-primary" disabled={!valid} onClick={save}>{alarm ? 'Save alarm' : 'Add alarm'}</button>
      </div>
    </div>}
  </ClockDialog>;
}

function TimerCard({ timer }: { timer: Timer }) {
  const { pauseTimer, resumeTimer, addTimerTime, restartTimer, removeTimer } = useTimerAlarm();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const paused = timer.status === 'paused';
  const finished = timer.status === 'finished';
  return <article className={`clock-timer-card${paused ? ' is-paused' : ''}${finished ? ' is-finished' : ''}`} aria-label={`${timer.label} timer`}>
    <div className="clock-timer-card-top"><div className="clock-timer-label"><span className="clock-eyebrow">{paused ? 'PAUSED' : finished ? 'FINISHED' : 'RUNNING'}</span><h2>{timer.label}</h2></div><button type="button" className="clock-icon-button" aria-label={`Remove ${timer.label} timer`} onClick={() => setConfirmRemove(true)}>×</button></div>
    <div className="clock-timer-face"><div className="clock-card-ring"><ClockRing progress={finished ? 1 : timer.remainingMs / timer.durationMs} /><span aria-hidden>{paused ? 'Ⅱ' : finished ? '✓' : '◷'}</span></div><div><p className="clock-countdown" aria-label={`${durationLabel(timer.remainingMs)} remaining`}>{countdown(timer.remainingMs)}</p><p className="clock-finish">{paused ? `${durationLabel(timer.durationMs)} timer · Paused` : finished ? 'Finished' : `Finishes ${clockTime(timer.endTime ?? Date.now())}`}</p></div></div>
    {confirmRemove ? <div className="clock-card-confirm" role="group" aria-label="Confirm timer removal"><span>Remove this timer?</span><button type="button" onClick={() => setConfirmRemove(false)}>Keep</button><button type="button" className="clock-danger" onClick={() => removeTimer(timer.id)}>Remove</button></div> : <div className="clock-timer-actions">
      <button type="button" className="clock-card-primary" onClick={() => finished ? restartTimer(timer.id) : paused ? resumeTimer(timer.id) : pauseTimer(timer.id)}>{finished ? 'Start again' : paused ? 'Resume' : 'Pause'}</button>
      <button type="button" onClick={() => addTimerTime(timer.id, 60000)}>+1 min</button><button type="button" onClick={() => restartTimer(timer.id)}>Restart</button>
    </div>}
  </article>;
}

export function TimerAlarmsPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const alarmsTab = pathname.includes('/timer/alarms');
  const { timers, recentTimers, startTimer, alarms, nextAlarm, alarmNextFireAt, pendingSnoozes, updateAlarm, removeAlarm, restoreAlarm, cancelSnooze, persistenceAvailable, now } = useTimerAlarm();
  const [timerComposer, setTimerComposer] = useState(false);
  const [alarmEditor, setAlarmEditor] = useState<Alarm | 'new' | null>(null);
  const [deleted, setDeleted] = useState<DeletedAlarmSnapshot | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { setTimerComposer(false); setAlarmEditor(null); }, [alarmsTab]);
  useEffect(() => { if (!deleted) return; const timer = setTimeout(() => setDeleted(null), 10000); return () => clearTimeout(timer); }, [deleted]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  const quickStart = (durationMs: number, label: string) => { if (!startTimer(durationMs, label)) setNotice('Remove an existing timer to make room for a new one.'); };
  const sortedAlarms = [...alarms].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (alarmNextFireAt[a.id] ?? Infinity) - (alarmNextFireAt[b.id] ?? Infinity) || a.hour * 60 + a.minute - b.hour * 60 - b.minute);
  const nextTime = nextAlarm ? alarmTime(new Date(nextAlarm.fireAt).getHours(), new Date(nextAlarm.fireAt).getMinutes()) : null;
  return <div className="page clock-workspace">
    <header className="clock-page-header"><div className="clock-tabs" role="tablist" aria-label="Timers and alarms"><button type="button" role="tab" aria-selected={!alarmsTab} onClick={() => navigate('/timer')}>Timers{timers.length > 0 && <span>{timers.length}</span>}</button><button type="button" role="tab" aria-selected={alarmsTab} onClick={() => navigate('/timer/alarms')}>Alarms{alarms.some(alarm => alarm.enabled) && <span>{alarms.filter(alarm => alarm.enabled).length}</span>}</button></div><button type="button" className="clock-primary clock-new" onClick={() => alarmsTab ? setAlarmEditor('new') : setTimerComposer(true)}>+ {alarmsTab ? 'New alarm' : 'Custom timer'}</button></header>
    {notice && <p className="clock-notice" role="status">{notice}</p>}
    {!persistenceAvailable && <p className="clock-notice" role="status">Changes work now, but this device cannot save them for a restart.</p>}
    {alarmsTab ? <div className="clock-alarm-workspace">
      <section className="clock-next-alarm" aria-label="Next alarm"><div><span className="clock-eyebrow">NEXT ALARM</span><h1>{nextAlarm ? nextAlarm.alarm.label : 'No alarms scheduled'}</h1>{nextAlarm && <p>{occurrenceLabel(nextAlarm.fireAt, now)}</p>}</div>{nextTime ? <div className="clock-next-time">{nextTime.time}<span>{nextTime.period}</span></div> : null}</section>
      <div className="clock-section-heading"><h2>Alarms</h2><span>{alarms.length ? `${alarms.filter(alarm => alarm.enabled).length} on · ${alarms.length} saved` : 'Saved on this device'}</span></div>
      {!alarms.length ? <div className="clock-empty-alarm"><h3>No alarms</h3><button type="button" className="clock-secondary" onClick={() => setAlarmEditor('new')}>Create an alarm</button></div> : <div className="clock-alarm-grid">{sortedAlarms.map(alarm => {
        const time = alarmTime(alarm.hour, alarm.minute);
        const snoozed = pendingSnoozes.find(item => item.alarmId === alarm.id);
        return <article className={`clock-alarm-card${alarm.enabled ? '' : ' is-off'}`} key={alarm.id} aria-label={`${alarm.label} alarm`}>
          <div className="clock-alarm-card-top"><button type="button" className="clock-alarm-edit" aria-label={`Edit ${alarm.label} alarm`} onClick={() => setAlarmEditor(alarm)}><span className="clock-alarm-time">{time.time}<small>{time.period}</small></span><strong>{alarm.label}</strong></button><button type="button" role="switch" aria-checked={alarm.enabled} aria-label={`${alarm.label} alarm enabled`} className="clock-switch" onClick={() => updateAlarm(alarm.id, { enabled: !alarm.enabled })}><span /></button></div>
          <p className="clock-alarm-repeat">{repeatLabel(alarm.repeat)} <span>· Snooze {alarm.snoozeMinutes} min</span></p>
          <div className="clock-alarm-card-bottom"><span>{snoozed ? `Snoozed until ${clockTime(snoozed.fireAt)}` : alarm.enabled && alarmNextFireAt[alarm.id] ? occurrenceLabel(alarmNextFireAt[alarm.id], now) : 'Off'}</span>{snoozed && <button type="button" className="clock-cancel-snooze" onClick={() => cancelSnooze(alarm.id)}>Cancel snooze</button>}<button type="button" className="clock-delete" aria-label={`Delete ${alarm.label} alarm`} onClick={() => setDeleted(removeAlarm(alarm.id))}>Delete</button></div>
        </article>;
      })}</div>}
    </div> : <div className="clock-timer-workspace">
      <aside className="clock-quick-start"><div className="clock-section-heading"><h1>Presets</h1></div><div className="clock-presets">{PRESETS.map(preset => <button type="button" key={preset.minutes} aria-label={`Start ${preset.minutes} minute ${preset.label} timer`} onClick={() => quickStart(preset.minutes * 60000, preset.label)}><strong>{preset.minutes === 60 ? '1' : preset.minutes}<small>{preset.minutes === 60 ? 'hr' : 'min'}</small></strong><span>{preset.label}</span></button>)}</div>{recentTimers.length > 0 && <section className="clock-recents"><div className="clock-section-heading"><h2>Recent timers</h2></div>{recentTimers.slice(0, 3).map((recent, i) => <button type="button" key={`${recent.label}-${recent.durationMs}-${i}`} onClick={() => quickStart(recent.durationMs, recent.label)}><span><strong>{recent.label}</strong><small>{durationLabel(recent.durationMs)}</small></span><span aria-hidden>↻</span></button>)}</section>}</aside>
      <section className="clock-active-timers" aria-label="Timers"><div className="clock-section-heading"><h2>Timers</h2>{timers.length > 0 && <span>{timers.filter(timer => timer.status === 'running').length} running · {timers.filter(timer => timer.status === 'paused').length} paused</span>}</div>{timers.length ? <div className="clock-timer-grid">{timers.map(timer => <TimerCard key={timer.id} timer={timer} />)}</div> : <div className="clock-timer-empty"><h2>No timers</h2><button type="button" className="clock-secondary" onClick={() => setTimerComposer(true)}>Set a custom timer</button></div>}</section>
    </div>}
    {deleted && <div className="clock-undo" role="status"><span>Deleted “{deleted.alarm.label}”</span><button type="button" onClick={() => { restoreAlarm(deleted); setDeleted(null); }}>Undo</button><button type="button" aria-label="Dismiss deletion notice" onClick={() => setDeleted(null)}>×</button></div>}
    {timerComposer && <TimerComposer onClose={() => setTimerComposer(false)} />}
    {alarmEditor && <AlarmEditor alarm={alarmEditor === 'new' ? null : alarmEditor} onClose={() => setAlarmEditor(null)} />}
  </div>;
}
