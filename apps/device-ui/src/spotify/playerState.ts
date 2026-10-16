/** The SDK can send null while a device is idle or playback moves elsewhere. */
export interface NowPlayingTrack {
  uri: string;
  title: string;
  artist: string;
  album: string;
  image: string | null;
}

export interface PlaybackSnapshot {
  track: NowPlayingTrack | null;
  paused: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: 'off' | 'context' | 'track';
  disallows: Record<string, boolean>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function milliseconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function readPlaybackState(state: unknown): PlaybackSnapshot {
  const raw = record(state);
  const current = record(record(raw.track_window).current_track);
  const album = record(current.album);
  const artists = Array.isArray(current.artists)
    ? current.artists.map((artist) => text(record(artist).name)).filter(Boolean).join(', ')
    : '';
  const images = Array.isArray(album.images) ? album.images : [];
  const image = images.map((item) => text(record(item).url)).find(Boolean) || null;
  const duration = milliseconds(raw.duration);
  const disallows: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record(raw.disallows))) {
    if (value === true) disallows[key] = true;
  }
  return {
    track: Object.keys(current).length ? {
      uri: text(current.uri),
      title: text(current.name) || 'Unknown track',
      artist: artists || 'Unknown artist',
      album: text(album.name),
      image,
    } : null,
    paused: raw.paused !== false,
    position: Math.min(milliseconds(raw.position), duration),
    duration,
    shuffle: raw.shuffle === true,
    repeat: raw.repeat_mode === 2 ? 'track' : raw.repeat_mode === 1 ? 'context' : 'off',
    disallows,
  };
}

export function playbackPosition(snapshot: PlaybackSnapshot, updatedAt: number, now: number): number {
  const elapsed = !snapshot.paused && updatedAt > 0 ? Math.max(0, now - updatedAt) : 0;
  return Math.min(snapshot.duration, Math.max(0, snapshot.position + elapsed));
}

export function formatPlaybackTime(ms: number): string {
  const seconds = Math.floor(milliseconds(ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
