/**
 * Morning / timer alarm: assertive square two-tone (not the old quiet sine).
 * Peak gain is unity so the clip is as loud as Web Audio allows without
 * changing system/OS volume (max relative / unity gain).
 *
 * Pattern: low beep → high beep → rest, repeating. Short pulses keep it
 * insistent without a continuous siren.
 */

export const LOW_HZ = 880;
export const HIGH_HZ = 1174.66;
export const PEAK_GAIN = 1.0;
export const OSC_TYPE: OscillatorType = 'square';
/** ms per pattern step (tone or rest). */
export const STEP_MS = 160;
/** Tone length within an active step (rest of the step is silence). */
export const TONE_MS = 110;
/** Pattern: low, high, rest. */
export const PATTERN_STEPS: ReadonlyArray<'low' | 'high' | 'rest'> = ['low', 'high', 'rest'];

let sharedContext: AudioContext | null = null;

export async function ensureAlarmAudioContext(): Promise<AudioContext | null> {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext) {
    sharedContext = new Ctor();
  }
  if (sharedContext.state === 'suspended') {
    await sharedContext.resume().catch(() => {});
  }
  return sharedContext;
}

/** Prime audio (call from user/timer actions so autoplay policies allow ringing later). */
export function primeAlarmAudio(): void {
  void ensureAlarmAudioContext();
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let loopGeneration = 0;

function stopIntervalOnly(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

function playAlarmPulse(audioContext: AudioContext, frequency: number): void {
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  const toneSec = TONE_MS / 1000;
  const attack = 0.008;
  const release = 0.03;

  osc.type = OSC_TYPE;
  osc.frequency.setValueAtTime(frequency, now);
  // Exponential ramps cannot use 0; keep a tiny floor.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, now + attack);
  gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, now + Math.max(attack, toneSec - release));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + toneSec);

  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + toneSec + 0.01);
}

/**
 * Start the repeating paired-beep alarm. Safe to call multiple times; only one loop runs.
 * Returns a stop function.
 */
export async function startAlarmToneLoop(): Promise<() => void> {
  const generation = ++loopGeneration;
  stopIntervalOnly();
  const audioContext = await ensureAlarmAudioContext();
  // Resume can finish after this alert was dismissed or another alert took over.
  if (!audioContext || generation !== loopGeneration) {
    return () => {};
  }

  let step = 0;
  const tick = () => {
    if (generation !== loopGeneration) return;
    const kind = PATTERN_STEPS[step % PATTERN_STEPS.length];
    step += 1;
    if (kind === 'rest') return;
    playAlarmPulse(audioContext, kind === 'low' ? LOW_HZ : HIGH_HZ);
  };

  tick();
  intervalId = window.setInterval(tick, STEP_MS);

  return () => {
    // A previous alert’s asynchronous cleanup must not stop the current alert.
    if (generation !== loopGeneration) return;
    loopGeneration += 1;
    stopIntervalOnly();
  };
}

export function stopAlarmToneLoop(): void {
  loopGeneration += 1;
  stopIntervalOnly();
}
