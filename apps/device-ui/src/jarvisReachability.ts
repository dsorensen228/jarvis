/** Grace period before showing offline UI for brief reconnect blips. */
export const JARVIS_OFFLINE_GRACE_MS = 3000;

export type JarvisReachabilityInput = {
  /** Local `/api/events` WebSocket is open. */
  eventsOpen: boolean;
  /**
   * Jarvis `/v1/voice` connection from the latest `voice.state`, or `null` when
   * no snapshot has been received yet.
   */
  backendConnected: boolean | null;
  /** Milliseconds the device has been in an unreachable condition. */
  unreachableForMs: number;
  /** Grace before showing persistent offline chrome. */
  graceMs?: number;
};

/**
 * Whether the kiosk should show that it cannot reach Jarvis.
 * Brief disconnects under the grace window stay silent to avoid flicker.
 */
export function shouldShowJarvisUnreachable(input: JarvisReachabilityInput): boolean {
  const graceMs = input.graceMs ?? JARVIS_OFFLINE_GRACE_MS;
  const unreachable = !input.eventsOpen || input.backendConnected !== true;
  if (!unreachable) return false;
  return input.unreachableForMs >= graceMs;
}
