import type { RemoteKey, SmartDevice, SmartHomeCapability } from './api-client/types';

export function tvMedia(device: SmartDevice | null | undefined) {
  return device?.components.find((component) => component.domain === 'media_player');
}

export function tvSupports(
  device: SmartDevice | null | undefined,
  capability: SmartHomeCapability
) {
  return Boolean(device?.capabilities.includes(capability));
}

export function tvSupportsKey(device: SmartDevice | null | undefined, key: RemoteKey) {
  return Boolean(device?.supported_keys?.includes(key));
}

export function tvStatus(device: SmartDevice) {
  if (!device.available) return 'Unavailable';
  const media = tvMedia(device);
  if (media?.power === false || device.power === false) return 'Off';
  const playback = media?.playback_state;
  const state = playback === 'playing' ? 'Playing' : playback === 'paused' ? 'Paused' : '';
  return (
    [media?.app, state].filter(Boolean).join(' · ') ||
    (media?.power === true ? 'On' : 'State unknown')
  );
}

export function tvSources(device: SmartDevice | null | undefined, query = '') {
  const sources = tvMedia(device)?.apps ?? [];
  const match = query.trim().toLocaleLowerCase();
  return [...new Set(sources)].filter((source) => source.toLocaleLowerCase().includes(match));
}

/** Serialize remote taps, retaining their original target and dropping unsent taps on a switch. */
export function createTvCommandQueue({
  onPending,
  onError,
  onSettled,
}: {
  onPending: (count: number) => void;
  onError: (error: unknown, target: string) => void;
  onSettled: (target: string) => void;
}) {
  let target: string | null = null;
  let generation = 0;
  let running = false;
  let disposed = false;
  const jobs: {
    target: string;
    generation: number;
    work: () => Promise<unknown>;
    onSuccess?: () => void;
  }[] = [];
  const notify = () => {
    if (!disposed) onPending(jobs.length + Number(running));
  };
  const drain = async () => {
    if (running || disposed) return;
    running = true;
    notify();
    while (jobs.length && !disposed) {
      const job = jobs.shift()!;
      notify();
      try {
        await job.work();
        if (!disposed && job.generation === generation) job.onSuccess?.();
      } catch (error) {
        if (!disposed && job.generation === generation) {
          // A timeout may have reached the TV. Drop repeats instead of replaying uncertain intent.
          jobs.length = 0;
          onError(error, job.target);
        }
      }
      if (!disposed && job.generation === generation) onSettled(job.target);
    }
    running = false;
    notify();
  };
  return {
    select(nextTarget: string | null) {
      if (target === nextTarget) return;
      target = nextTarget;
      generation++;
      jobs.length = 0;
      notify();
    },
    enqueue(id: string, work: () => Promise<unknown>, onSuccess?: () => void) {
      if (disposed || id !== target || jobs.length + Number(running) >= 8) return false;
      jobs.push({ target: id, generation, work, onSuccess });
      void drain();
      notify();
      return true;
    },
    dispose() {
      disposed = true;
      jobs.length = 0;
    },
  };
}
