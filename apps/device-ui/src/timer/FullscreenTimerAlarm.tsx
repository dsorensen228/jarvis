import { useEffect, useRef } from 'react';
import { useTimerAlarm } from './TimerAlarmContext';
import { clockTime, durationLabel } from './clockPresentation';
import './clock.css';

export function FullscreenTimerAlarm() {
  const { ringing, ringingQueue, dismissRinging, snoozeAlarm, restartTimer } = useTimerAlarm();
  const dialog = useRef<HTMLDivElement>(null);
  const dismiss = useRef(dismissRinging); dismiss.current = dismissRinging;
  const active = ringing.kind !== 'none';
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('.clock-primary')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss.current(); }
      if (event.key !== 'Tab') return;
      const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); previous?.focus(); };
  }, [active]);
  if (ringing.kind === 'none') return null;
  const isTimer = ringing.kind === 'timer';
  const waiting = ringingQueue.filter(item => item.id !== ringing.id);
  return <div ref={dialog} className="clock-ringing" role="alertdialog" aria-modal="true" aria-labelledby="clock-ringing-title" aria-describedby="clock-ringing-detail">
    <div className="clock-ringing-card">
      <div className="clock-ringing-content">
      <div className="clock-ringing-symbol" aria-hidden>{isTimer ? '✓' : '◷'}</div>
      <span className="clock-eyebrow">{isTimer ? 'TIMER FINISHED' : 'ALARM'}</span>
      <h1 id="clock-ringing-title">{ringing.label}</h1>
      <p id="clock-ringing-detail" className="clock-ringing-detail">{isTimer ? `${durationLabel(ringing.durationMs)} timer` : clockTime(ringing.fireAt)}{ringing.silent ? ' · Overdue, sound is off' : ''}</p>
      {waiting.length > 0 && <ul className="clock-ringing-queue" aria-label="More alerts waiting"><li>{waiting.length} more waiting</li>{waiting.slice(0, 2).map(item => <li key={item.id}>{item.label}</li>)}{waiting.length > 2 && <li>+{waiting.length - 2}</li>}</ul>}
      {ringing.occurrences > 1 && <p className="clock-ringing-hint">{ringing.occurrences} missed occurrences of this alarm.</p>}
      </div>
      <div className="clock-ringing-actions">
        {ringing.kind === 'timer' ? <button type="button" className="clock-secondary" onClick={() => restartTimer(ringing.timerId)}>Restart · {durationLabel(ringing.durationMs)}</button> : <button type="button" className="clock-secondary" onClick={() => snoozeAlarm()}>Snooze · {ringing.snoozeMinutes} min</button>}
        <button type="button" className="clock-primary" onClick={() => dismissRinging()}>{waiting.length ? 'Dismiss & next' : 'Dismiss'}</button>
      </div>
    </div>
  </div>;
}
