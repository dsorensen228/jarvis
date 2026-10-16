import type { Page } from '@playwright/test';
import { setupSpotify } from './spotify-fixture';
import type { TimerRuntime } from '../src/timer/types';

export const emptyClock = (): TimerRuntime => ({ version: 2, timers: [], alarms: [], alarmNextFireAt: {}, pendingSnoozes: [], ringingQueue: [], recentTimers: [] });

export async function setupClock(page: Page, runtime = emptyClock()) {
  await setupSpotify(page);
  await page.addInitScript((initial) => {
    // Never produce audio in tests, including seeded ringing/catch-up scenarios.
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
    if (!sessionStorage.getItem('clock-e2e-seeded')) {
      localStorage.setItem('jarvis_timer_runtime_v2', JSON.stringify(initial));
      sessionStorage.setItem('clock-e2e-seeded', 'true');
    }
  }, runtime);
}

export const readClock = (page: Page): Promise<TimerRuntime> => page.evaluate(() => JSON.parse(localStorage.getItem('jarvis_timer_runtime_v2') || '{}'));
