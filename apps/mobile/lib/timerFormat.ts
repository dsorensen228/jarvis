/** Shared timer clock formatting for UI and Android notifications. */
export function formatTimerClock(totalMs: number) {
  const totalSeconds = Number.isFinite(totalMs) ? Math.max(0, Math.ceil(totalMs / 1000)) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatTimerDuration(ms: number) {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  const parts = [Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}h` : '',
    Math.floor(seconds / 60) % 60 ? `${Math.floor(seconds / 60) % 60}m` : '',
    seconds % 60 ? `${seconds % 60}s` : ''].filter(Boolean);
  return parts.join(' ') || '0s';
}
export function formatTimerFinish(endAtMs: number) {
  const end = new Date(endAtMs);
  const clock = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return end.toDateString() === new Date().toDateString() ? clock : `${end.toLocaleDateString([], { weekday: 'short' })}, ${clock}`;
}
