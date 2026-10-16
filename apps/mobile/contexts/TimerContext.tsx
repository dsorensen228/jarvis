import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Buffer } from 'buffer';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { openAndroidTimerNotificationSettings, syncAndroidTimerNotifications } from '@/lib/androidTimerNotifee';
import { timerStore } from '@/lib/timerStore';
import { timerRemaining, TIMER_SOUND_MS, type TimerAction, type TimerStatus } from '@/lib/timerState';
export { formatTimerClock } from '@/lib/timerFormat';

type TimerContextValue = {
  status: TimerStatus; label: string; durationMs: number; remainingMs: number; endAtMs: number | null;
  recentDurations: number[]; ready: boolean; warning: string | null; silenced: boolean;
  canConfigureNotifications: boolean; openNotificationSettings: () => void;
  modalDismissed: boolean; isTimerVisible: boolean; isAlarming: boolean;
  startTimer: (durationMs: number, label?: string) => void;
  pauseTimer: () => void; resumeTimer: () => void; cancelTimer: () => void;
  addMinute: () => void; restartTimer: () => void; silenceAlarm: () => void;
  dismissModal: () => void; dismissAlarm: () => void;
  handleTimerPageVisibility: (isVisible: boolean) => void;
};
const TimerContext = createContext<TimerContextValue | null>(null);

/** Match device-ui alarmTone: square A5/D6 paired beeps at max relative volume. */
function buildAlarmWavBase64(): string {
  const sampleRate = 22050;
  const durationSeconds = 1;
  const totalSamples = sampleRate * durationSeconds;
  const pcm = new Int16Array(totalSamples);
  const stepSec = 0.16;
  const toneSec = 0.11;
  const lowHz = 880;
  const highHz = 1174.66;
  const peak = 0.95;

  for (let i = 0; i < totalSamples; i += 1) {
    const time = i / sampleRate;
    const step = Math.floor(time / stepSec) % 3;
    if (step === 2) {
      pcm[i] = 0;
      continue;
    }
    const frequency = step === 0 ? lowHz : highHz;
    const local = time - Math.floor(time / stepSec) * stepSec;
    if (local > toneSec) {
      pcm[i] = 0;
      continue;
    }
    const attack = Math.min(1, local / 0.008);
    const release = Math.min(1, (toneSec - local) / 0.03);
    const envelope = Math.min(attack, release);
    // Square wave (sign of sine) at near-unity amplitude — max relative volume.
    const sample = Math.sign(Math.sin(2 * Math.PI * frequency * time)) * envelope * peak;
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 32767;
  }

  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(offset, pcm[i], true);
    offset += 2;
  }

  return Buffer.from(buffer).toString('base64');
}

async function ensureAlarmUri(): Promise<string | null> {
  if (!FileSystem.cacheDirectory) {
    return null;
  }

  const uri = `${FileSystem.cacheDirectory}jarvis-timer-alarm-v2.wav`;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      await FileSystem.writeAsStringAsync(uri, buildAlarmWavBase64(), {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    return uri;
  } catch {
    return null;
  }
}


export function TimerProvider({ children }: { children: ReactNode }) {
  const { state, ready, storageError } = useSyncExternalStore(timerStore.subscribe, timerStore.getSnapshot, timerStore.getSnapshot);
  const [now, setNow] = useState(Date.now());
  const [modalDismissed, setModalDismissed] = useState(false);
  const [isTimerVisible, setIsTimerVisible] = useState(false);
  const [notificationWarning, setNotificationWarning] = useState<string | null>(null);
  const webAudioRef = useRef<AudioContext | null>(null);
  const dispatch = useCallback((action: TimerAction) => { void timerStore.dispatch(action); }, []);
  const primeAudio = useCallback(() => {
    if (Platform.OS !== 'web') return;
    const Constructor = globalThis.AudioContext || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Constructor && !webAudioRef.current) webAudioRef.current = new Constructor();
    void webAudioRef.current?.resume().catch(() => {});
  }, []);
  useEffect(() => { void timerStore.ready(); }, []);
  useEffect(() => {
    const tick = () => {
      const time = Date.now(); setNow(time);
      if (timerStore.getSnapshot().state.status === 'running') dispatch({ type: 'finish', now: time });
    };
    tick();
    const interval = state.status === 'running' ? setInterval(tick, 250) : null;
    const sub = AppState.addEventListener('change', value => { if (value === 'active') tick(); });
    return () => { if (interval) clearInterval(interval); sub.remove(); };
  }, [state.status, state.endAtMs, dispatch]);
  useEffect(() => { setModalDismissed(false); }, [state.id, state.status]);
  useEffect(() => {
    if (!ready || Platform.OS !== 'android') return;
    let cancelled = false;
    const sync = () => {
      syncAndroidTimerNotifications().then(() => { if (!cancelled) setNotificationWarning(null); }).catch(() => {
        if (!cancelled) setNotificationWarning('Background alerts are unavailable. Keep Jarvis open and check Android notification and alarm permissions.');
      });
    };
    sync();
    // Returning from Settings must schedule the remaining deadline without another timer action.
    const sub = AppState.addEventListener('change', value => { if (value === 'active') sync(); });
    return () => { cancelled = true; sub.remove(); };
  }, [ready, state]);

  useEffect(() => {
    if (state.status !== 'alarming' || state.silenced) return;
    const soundRemaining = Math.max(0, (state.alarmedAtMs ?? Date.now()) + TIMER_SOUND_MS - Date.now());
    if (!soundRemaining) { dispatch({ type: 'silence', now: Date.now() }); return; }
    let disposed = false;
    let sound: Audio.Sound | null = null;
    let webInterval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (webInterval) clearInterval(webInterval);
      webInterval = null;
      if (sound) { const current = sound; sound = null; void current.stopAsync().catch(() => {}).then(() => current.unloadAsync().catch(() => {})); }
    };
    const play = async () => {
      if (Platform.OS === 'web') {
        primeAudio();
        const context = webAudioRef.current;
        if (!context) return;
        await context.resume().catch(() => {});
        if (disposed) return;
        let step = 0;
        const beep = () => {
          const part = step++ % 3;
          if (part === 2 || disposed) return;
          const oscillator = context.createOscillator(); const gain = context.createGain(); const at = context.currentTime;
          oscillator.type = 'square'; oscillator.frequency.value = part === 0 ? 880 : 1174.66;
          gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.8, at + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
          oscillator.connect(gain); gain.connect(context.destination); oscillator.start(at); oscillator.stop(at + 0.12);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        };
        beep(); webInterval = setInterval(beep, 160); return;
      }
      const uri = await ensureAlarmUri();
      if (!uri || disposed) return;
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: true });
      if (disposed) return;
      const created = await Audio.Sound.createAsync({ uri }, { shouldPlay: false, isLooping: true, volume: 1 });
      if (disposed) { await created.sound.unloadAsync(); return; }
      sound = created.sound;
      await created.sound.playAsync();
      if (disposed) { await created.sound.stopAsync().catch(() => {}); await created.sound.unloadAsync().catch(() => {}); }
    };
    void play().catch(() => {});
    const timeout = setTimeout(() => { stop(); dispatch({ type: 'silence', now: Date.now() }); }, soundRemaining);
    return () => { disposed = true; clearTimeout(timeout); stop(); };
  }, [state.status, state.id, state.silenced, state.alarmedAtMs, dispatch, primeAudio]);
  useEffect(() => () => { void webAudioRef.current?.close().catch(() => {}); }, []);
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const startTimer = useCallback((durationMs: number, label = '') => {
    primeAudio(); dispatch({ type: 'start', durationMs, label, id: newId(), now: Date.now() });
  }, [dispatch, primeAudio]);
  const pauseTimer = useCallback(() => dispatch({ type: 'pause', now: Date.now() }), [dispatch]);
  const resumeTimer = useCallback(() => { primeAudio(); dispatch({ type: 'resume', now: Date.now() }); }, [dispatch, primeAudio]);
  const cancelTimer = useCallback(() => dispatch({ type: 'stop', now: Date.now() }), [dispatch]);
  const addMinute = useCallback(() => dispatch({ type: 'add-minute', now: Date.now() }), [dispatch]);
  const restartTimer = useCallback(() => { primeAudio(); dispatch({ type: 'restart', id: newId(), now: Date.now() }); }, [dispatch, primeAudio]);
  const silenceAlarm = useCallback(() => dispatch({ type: 'silence', now: Date.now() }), [dispatch]);
  const handleTimerPageVisibility = useCallback((visible: boolean) => setIsTimerVisible(visible), []);
  const value: TimerContextValue = {
    status: state.status, label: state.label, durationMs: state.durationMs, endAtMs: state.endAtMs,
    remainingMs: timerRemaining(state, now), recentDurations: state.recentDurations, ready, silenced: state.silenced,
    warning: storageError ? 'This timer could not be saved. Keep Jarvis open until it finishes.' : notificationWarning,
    canConfigureNotifications: Platform.OS === 'android' && !!notificationWarning,
    openNotificationSettings: () => { void openAndroidTimerNotificationSettings().catch(() => {}); },
    modalDismissed, isTimerVisible, isAlarming: state.status === 'alarming', startTimer, pauseTimer, resumeTimer, cancelTimer,
    addMinute, restartTimer, silenceAlarm, dismissModal: () => setModalDismissed(true), dismissAlarm: cancelTimer, handleTimerPageVisibility,
  };
  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}
export function useTimer() {
  const value = useContext(TimerContext);
  if (!value) throw new Error('useTimer must be used within TimerProvider');
  return value;
}
