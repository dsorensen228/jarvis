import { useEffect, useState } from 'react';
import {
  jarvisAvatarAriaLabel,
  jarvisAvatarPhaseClass,
} from '../jarvisAvatar';
import { useVoiceTurn } from '../VoiceTurnContext';

function formatStandbyClock(now: Date): { time: string; date: string } {
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(now);
  return { time, date };
}

export function StandbyPage() {
  const {
    phase,
    jarvisUnreachable,
    requestVoiceTap,
  } = useVoiceTurn();
  const [clock, setClock] = useState(() => formatStandbyClock(new Date()));

  useEffect(() => {
    const tick = () => setClock(formatStandbyClock(new Date()));
    tick();
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof window.setInterval> | undefined;
    const timeoutId = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, 60_000);
    }, msToNextMinute);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, []);

  const phaseClass = jarvisAvatarPhaseClass({
    jarvisUnreachable,
    phase,
  });

  return (
    <div className="page standby">
      <div className="standby-stack">
        <div
          className={`avatar-wrap tap-target${phaseClass}`}
          role="button"
          tabIndex={0}
          aria-label={jarvisAvatarAriaLabel({
            jarvisUnreachable,
            phase,
          })}
          aria-busy={phase === 'connecting'}
          onClick={() => requestVoiceTap()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              requestVoiceTap();
            }
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}jarvis.png`}
            alt=""
            className="avatar-img"
            draggable={false}
          />
        </div>
        <div className="standby-clock" aria-live="polite">
          <div className="standby-clock-time">{clock.time}</div>
          <div className="standby-clock-date">{clock.date}</div>
        </div>
      </div>
    </div>
  );
}
