import type { JarvisDevice } from '@/lib/api-client/types';

export function deviceKind(device: JarvisDevice): JarvisDevice['raw_kind'] {
  // Older callers may still supply the legacy type without a raw kind.
  return device.raw_kind === undefined ? device.device_type === 'camera' ? 'camera' : 'voice' : device.raw_kind;
}

export function devicePurpose(device: JarvisDevice): string {
  switch (deviceKind(device)) {
    case 'voice': return 'Voice interface';
    case 'camera': return 'Camera';
    case 'display': return 'Display';
    case 'wearable': return 'Wearable';
    default: return 'Device';
  }
}

export function deviceStatus(device: JarvisDevice): string {
  if (device.reported_connected === false) return 'Reported disconnected';
  if (device.reported_connected === true) return 'Reported connected';
  if (deviceKind(device) === 'camera' && device.health?.ready === false) return 'Reported camera not ready';
  return 'No connection report';
}

export function deviceReportTime(device: JarvisDevice): string | null {
  const timestamps = [device.last_heartbeat_at, device.last_seen_at]
    .filter((value): value is string => Boolean(value))
    .map(value => Date.parse(value)).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toLocaleString() : null;
}

export function validateDeviceConnection(url: string, camera: boolean, secret: string): string | null {
  if (!url.trim()) return camera ? 'Enter the camera callback URL.' : null;
  try {
    const parsed = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      return 'Use an HTTP or HTTPS callback URL without a username or password.';
    }
  } catch {
    return 'Enter a complete callback URL, such as http://camera-one.local:8089.';
  }
  if (secret.trim() && secret.trim().length < 16) return 'The callback secret must contain at least 16 characters.';
  return null;
}
