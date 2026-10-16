import type { RepeatRule } from './types';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}

export function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const parts = [Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)} hr` : '', Math.floor(seconds % 3600 / 60) ? `${Math.floor(seconds % 3600 / 60)} min` : '', seconds % 60 ? `${seconds % 60} sec` : ''];
  return parts.filter(Boolean).join(' ') || '0 sec';
}

export function clockTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);
}

export function alarmTime(hour: number, minute: number): { time: string; period: string } {
  return { time: `${hour % 12 || 12}:${String(minute).padStart(2, '0')}`, period: hour < 12 ? 'AM' : 'PM' };
}

export function occurrenceLabel(fireAt: number, now: number): string {
  const date = new Date(fireAt);
  const today = new Date(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === today.toDateString() ? 'Today' : date.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  return `${day}, ${clockTime(fireAt)}`;
}

export function repeatLabel(repeat: RepeatRule): string {
  if (repeat.kind === 'once') return 'Once';
  if (repeat.kind === 'daily') return 'Every day';
  const days = repeat.kind === 'weekly' ? [repeat.weekday] : [...new Set(repeat.weekdays)].sort();
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  if (days.length === 7) return 'Every day';
  return days.map(day => DAY_SHORT[day]).join(' · ');
}
