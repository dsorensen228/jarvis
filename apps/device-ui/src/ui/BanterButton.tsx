import { useCallback, useEffect, useRef } from 'react';
import type { BanterState } from '../api';
import { INTERACTIONS_MUTE_LONG_PRESS_MS } from '../jarvisAvatar';
import { IconRobot } from './deviceChromeIcons';

export function BanterButton({
  standby,
  state,
  pending,
  voiceActive,
  interactionsMuted = false,
  onClick,
  onMuteToggle,
}: {
  standby: boolean;
  state: BanterState | null;
  pending: boolean;
  voiceActive: boolean;
  interactionsMuted?: boolean;
  onClick: () => void;
  onMuteToggle: () => void;
}) {
  const longPressTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const longPressConsumed = useRef(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  if (!standby || !state?.paired) return null;

  const busy = pending || state.busy;
  const tapBlocked = busy || !state.available || voiceActive || interactionsMuted;
  const label = interactionsMuted
    ? 'Interactions muted — long-press to unmute'
    : busy
      ? 'Sherman and Jarvis are chatting — long-press to mute interactions'
      : voiceActive || state.status === 'not_idle'
        ? 'Sherman and Jarvis can chat when idle — long-press to mute interactions'
        : !state.available
          ? 'Sherman is unavailable — long-press to mute interactions'
          : 'Start a Sherman and Jarvis interaction — long-press to mute interactions';

  const onPointerDown = () => {
    longPressConsumed.current = false;
    clearLongPressTimer();
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressConsumed.current = true;
      onMuteToggle();
    }, INTERACTIONS_MUTE_LONG_PRESS_MS);
  };

  const onPointerEnd = () => {
    clearLongPressTimer();
  };

  const onButtonClick = () => {
    if (longPressConsumed.current) {
      longPressConsumed.current = false;
      return;
    }
    if (tapBlocked) return;
    onClick();
  };

  return (
    <button
      type="button"
      className={`device-top-chrome-icon-btn tap-target${tapBlocked && !interactionsMuted ? ' is-aria-disabled' : ''}`}
      style={{ color: '#BF5AF2' }}
      aria-label={label}
      title={label}
      aria-busy={busy || undefined}
      aria-disabled={tapBlocked && !interactionsMuted ? true : undefined}
      aria-pressed={interactionsMuted || undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={onPointerEnd}
      onClick={onButtonClick}
    >
      <IconRobot muted={interactionsMuted} />
    </button>
  );
}
