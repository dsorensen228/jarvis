import { useTimerAlarm } from './TimerAlarmContext';

export function FullscreenTimerAlarm() {
  const { ringing, dismissRinging, snoozeAlarm } = useTimerAlarm();

  if (ringing.kind === 'none') return null;

  const isTimer = ringing.kind === 'timer';

  return (
    <div
      className="timer-fullscreen-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="timer-fs-title"
    >
      <div className="timer-fullscreen-card">
        <h1 id="timer-fs-title" className="timer-fullscreen-title">
          {isTimer ? 'Timer' : 'Alarm'}
        </h1>
        {ringing.kind === 'alarm' && <p className="timer-fullscreen-sub">{ringing.label}</p>}
        {isTimer && <p className="timer-fullscreen-sub">Time&apos;s up</p>}
        <div className="timer-fullscreen-actions">
          {isTimer ? (
            <button type="button" className="timer-fullscreen-primary" onClick={() => dismissRinging()}>
              Dismiss
            </button>
          ) : (
            <>
              <button type="button" className="timer-fullscreen-secondary" onClick={() => snoozeAlarm()}>
                Snooze 10 min
              </button>
              <button type="button" className="timer-fullscreen-primary" onClick={() => dismissRinging()}>
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
