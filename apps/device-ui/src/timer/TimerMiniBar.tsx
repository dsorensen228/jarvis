import { useLocation, useNavigate } from 'react-router-dom';
import { useTimerAlarm } from './TimerAlarmContext';
import { ClockRing } from './ClockInputs';
import { countdown } from './clockPresentation';
import './clock.css';

export function TimerMiniBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { timers, miniBarDismissed, setMiniBarDismissed, pauseTimer, resumeTimer } = useTimerAlarm();
  const active = timers.filter(timer => timer.status !== 'finished');
  const timer = [...active].sort((a, b) => Number(a.status === 'paused') - Number(b.status === 'paused') || a.remainingMs - b.remainingMs)[0];
  if (!timer || pathname === '/timer' || pathname.startsWith('/timer/') || miniBarDismissed) return null;
  const paused = timer.status === 'paused';
  return <aside className="clock-mini" aria-label="Active timers">
    <button type="button" className="clock-mini-open" aria-label={`Open timers, ${timer.label}${active.length > 1 ? ` and ${active.length - 1} more` : ''}`} onClick={() => navigate('/timer')}>
      <span className="clock-mini-ring"><ClockRing progress={timer.remainingMs / timer.durationMs} small /><span aria-hidden>{paused ? 'Ⅱ' : '◷'}</span></span>
      <span className="clock-mini-label"><strong>{timer.label}</strong><small>{active.length > 1 ? `${active.length} timers${paused ? ' · Paused' : ''}` : paused ? 'Paused' : 'Running'}</small></span>
      <span className="clock-mini-time">{countdown(timer.remainingMs)}</span>
    </button>
    <button type="button" className="clock-mini-control" aria-label={`${paused ? 'Resume' : 'Pause'} ${timer.label}`} onClick={() => paused ? resumeTimer(timer.id) : pauseTimer(timer.id)}>{paused ? 'Resume' : 'Pause'}</button>
    <button type="button" className="clock-mini-close" aria-label="Hide timer bar" onClick={() => setMiniBarDismissed(true)}>×</button>
  </aside>;
}
