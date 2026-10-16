import { EMPTY_TIMER, reduceTimer, restoreTimer, type TimerAction, type TimerState } from './timerState';
export const TIMER_STORAGE_KEY = 'jarvis_timer_state_v2';
export const LEGACY_TIMER_STORAGE_KEY = 'jarvis_timer_state_v1';
type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void>; removeItem: (key: string) => Promise<void> };
/** Shared by the mounted UI and Notifee's headless handler. Writes retain action order. */
export function createTimerStore(storage: Storage) {
  let snapshot = { state: EMPTY_TIMER, ready: false, storageError: false };
  let loading: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  const write = (state: TimerState) => {
    writes = writes.catch(() => {}).then(async () => {
      try {
        await storage.setItem(TIMER_STORAGE_KEY, JSON.stringify(state));
        if (snapshot.storageError) { snapshot = { ...snapshot, storageError: false }; publish(); }
      } catch { snapshot = { ...snapshot, storageError: true }; publish(); }
    });
    return writes;
  };
  const ready = () => loading ??= (async () => {
    try {
      const current = await storage.getItem(TIMER_STORAGE_KEY);
      const legacy = current === null ? await storage.getItem(LEGACY_TIMER_STORAGE_KEY) : null;
      snapshot = { state: restoreTimer(current ?? legacy, Date.now()), ready: true, storageError: false };
      publish();
      // Save v2 before retiring v1. A failed write leaves the old timer recoverable.
      if (legacy !== null) {
        await write(snapshot.state);
        if (!snapshot.storageError) await storage.removeItem(LEGACY_TIMER_STORAGE_KEY);
      }
    } catch { snapshot = { ...snapshot, ready: true, storageError: true }; publish(); }
  })();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ready,
    async dispatch(action: TimerAction, guard?: (state: TimerState) => boolean) {
      await ready();
      if (guard && !guard(snapshot.state)) return snapshot.state;
      const state = reduceTimer(snapshot.state, action);
      if (state !== snapshot.state) { snapshot = { ...snapshot, state }; publish(); await write(state); }
      return state;
    },
  };
}
