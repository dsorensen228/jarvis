import type { RepeatRule } from './types';

/**
 * Calendar scheduling in the device's local timezone, strictly after `from`.
 * Spring-forward gaps shift forward by the DST gap (02:30 → 03:30).
 * Fall-back overlaps ring once, at the first occurrence of the wall-clock time.
 * Reconstruct each calendar day so a DST adjustment never drifts tomorrow's time.
 */
export function nextFireAfter(from: Date, hour: number, minute: number, repeat: RepeatRule): Date {
  if (!Number.isFinite(from.getTime()) || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('Invalid alarm time');
  const days = repeat.kind === 'weekly' ? [repeat.weekday] : repeat.kind === 'custom' ? repeat.weekdays : null;
  if (days && (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new RangeError('Choose at least one valid weekday');
  }
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, 12);
    if (days && !days.includes(day.getDay())) continue;
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new RangeError('No next alarm occurrence');
}
