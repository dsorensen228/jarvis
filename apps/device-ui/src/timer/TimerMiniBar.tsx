import { useLocation } from 'react-router-dom';
import { useTimerAlarm } from './TimerAlarmContext';

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

export function TimerMiniBar() {
  const { pathname } = useLocation();
  const {
    timer,
    timerRemainingMs,
    miniBarDismissed,
    setMiniBarDismissed,
    cancelTimer,
  } = useTimerAlarm();

  const active = timer.status !== 'idle';
  const onTimerPage = pathname === '/timer' || pathname.startsWith('/timer/');
  const show = active && !onTimerPage && !miniBarDismissed;

  if (!show) return null;

  const label = formatCountdown(timerRemainingMs);

  return (
    <div className="timer-mini-bar" role="status" aria-live="polite">
      <span className="timer-mini-bar-label">Timer</span>
      <span className="timer-mini-bar-time">{label}</span>
      <button type="button" className="timer-mini-bar-btn" onClick={() => cancelTimer()}>
        Cancel
      </button>
      <button
        type="button"
        className="timer-mini-bar-close"
        aria-label="Hide timer bar"
        onClick={() => setMiniBarDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
