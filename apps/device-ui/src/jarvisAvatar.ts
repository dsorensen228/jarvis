/** Labels and CSS phase for the standby Jarvis avatar. */

import type { VoiceUiPhase } from './VoiceTurnContext';

export type JarvisAvatarPhase = VoiceUiPhase;

/** Same hold threshold as system volume mute on the device chrome. */
export const INTERACTIONS_MUTE_LONG_PRESS_MS = 500;

export function jarvisAvatarPhaseClass(input: {
  jarvisUnreachable: boolean;
  phase: JarvisAvatarPhase;
}): string {
  if (input.jarvisUnreachable) return ' voice-unreachable';
  return input.phase === 'idle' ? '' : ` voice-${input.phase}`;
}

export function jarvisAvatarStatusLabel(input: {
  jarvisUnreachable: boolean;
  phase: JarvisAvatarPhase;
}): string {
  if (input.jarvisUnreachable) return '';
  return {
    idle: '',
    connecting: 'Starting…',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    error: 'Voice error',
  }[input.phase];
}

export function jarvisAvatarAriaLabel(input: {
  jarvisUnreachable: boolean;
  phase: JarvisAvatarPhase;
  voiceTurn: boolean;
}): string {
  if (input.jarvisUnreachable) return "Can't reach Jarvis";
  if (input.voiceTurn || input.phase === 'connecting') return 'Stop voice chat';
  return 'Start voice chat';
}
