import type { RepeatRule } from './types';

function atTime(d: Date, hour: number, minute: number): Date {
  const out = new Date(d);
  out.setHours(hour, minute, 0, 0);
  return out;
}

/**
 * Next fire strictly after `from` (if an event falls exactly on `from`, the next occurrence is returned).
 * Missed times while the device was off advance to the next valid slot (no catch-up ring).
 */
export function nextFireAfter(from: Date, hour: number, minute: number, repeat: RepeatRule): Date {
  const fromMs = from.getTime();

  if (repeat.kind === 'once') {
    let candidate = atTime(new Date(from), hour, minute);
    if (candidate.getTime() <= fromMs) {
      candidate = new Date(candidate);
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (repeat.kind === 'daily') {
    let candidate = atTime(new Date(from), hour, minute);
    if (candidate.getTime() <= fromMs) {
      candidate = new Date(candidate);
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (repeat.kind === 'weekly') {
    const wd = repeat.weekday;
    for (let add = 0; add <= 7; add++) {
      const d = new Date(from);
      d.setDate(d.getDate() + add);
      if (d.getDay() !== wd) continue;
      const cand = atTime(d, hour, minute);
      if (cand.getTime() > fromMs) return cand;
    }
    const d = new Date(from);
    d.setDate(d.getDate() + 7);
    return atTime(d, hour, minute);
  }

  const days = [...new Set(repeat.weekdays)].sort((a, b) => a - b);
  if (days.length === 0) {
    return new Date(fromMs + 365 * 86_400_000);
  }

  for (let add = 0; add < 14; add++) {
    const d = new Date(from);
    d.setDate(d.getDate() + add);
    if (!days.includes(d.getDay())) continue;
    const cand = atTime(d, hour, minute);
    if (cand.getTime() > fromMs) return cand;
  }

  for (let add = 0; add < 14; add++) {
    const d = new Date(from);
    d.setDate(d.getDate() + add + 7);
    if (!days.includes(d.getDay())) continue;
    return atTime(d, hour, minute);
  }

  return new Date(fromMs + 7 * 86_400_000);
}
