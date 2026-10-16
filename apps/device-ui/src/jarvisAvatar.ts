/** Labels and CSS phase for the standby Jarvis avatar. */

export type JarvisAvatarPhase = 'idle' | 'connecting' | 'active' | 'error';

/** Same hold threshold as system volume mute on the device chrome. */
export const INTERACTIONS_MUTE_LONG_PRESS_MS = 500;

export function jarvisAvatarPhaseClass(input: {
  jarvisUnreachable: boolean;
  phase: JarvisAvatarPhase;
}): string {
  if (input.phase === 'active') return ' voice-active';
  if (input.phase === 'connecting') return ' voice-connecting';
  if (input.phase === 'error') return ' voice-error';
  if (input.jarvisUnreachable) return ' voice-unreachable';
  return '';
}

export function jarvisAvatarAriaLabel(input: {
  jarvisUnreachable: boolean;
  phase: JarvisAvatarPhase;
}): string {
  if (input.jarvisUnreachable) return "Can't reach Jarvis";
  if (input.phase === 'active' || input.phase === 'connecting') return 'Stop voice chat';
  return 'Start voice chat';
}
