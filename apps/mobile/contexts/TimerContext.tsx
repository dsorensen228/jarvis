import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import React, {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';

import {
  setAndroidTimerControlHandlers,
  syncAndroidTimerNotifications,
} from '@/lib/androidTimerNotifee';

export { formatTimerClock } from '@/lib/timerFormat';

type TimerStatus = 'idle' | 'running' | 'paused' | 'alarming';

type TimerContextValue = {
  status: TimerStatus;
  durationMs: number;
  remainingMs: number;
  modalDismissed: boolean;
  isTimerVisible: boolean;
  isAlarming: boolean;
  startTimer: (durationMs: number) => void;
  pauseTimer: () => void;
  resumeTimer: () => void;
  cancelTimer: () => void;
  dismissModal: () => void;
  dismissAlarm: () => void;
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

function getRemainingMs({
  status,
  endAtMs,
  pausedRemainingMs,
}: {
  status: TimerStatus;
  endAtMs: number | null;
  pausedRemainingMs: number | null;
}) {
  if (status === 'paused') {
    return pausedRemainingMs ?? 0;
  }
  if (status === 'running') {
    return Math.max(0, (endAtMs ?? 0) - Date.now());
  }
  return 0;
}

const ANDROID_TIMER_STORAGE_KEY = 'jarvis_timer_state_v1';

type PersistedTimerV1 = {
  v: 1;
  status: TimerStatus;
  endAtMs: number | null;
  pausedRemainingMs: number | null;
  durationMs: number;
};

export function TimerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<TimerStatus>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [endAtMs, setEndAtMs] = useState<number | null>(null);
  const [pausedRemainingMs, setPausedRemainingMs] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [modalDismissed, setModalDismissed] = useState(false);
  const [isTimerVisible, setIsTimerVisible] = useState(false);
  const alarmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const alarmUriRef = useRef<string | null>(null);
  const webAudioContextRef = useRef<AudioContext | null>(null);
  const webAlarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<TimerStatus>('idle');
  const endAtMsRef = useRef<number | null>(null);
  const [androidStorageReady, setAndroidStorageReady] = useState(Platform.OS !== 'android');

  statusRef.current = status;
  endAtMsRef.current = endAtMs;

  const ensureWebAudioContext = useCallback(async () => {
    if (Platform.OS !== 'web') {
      return null;
    }

    const AudioContextCtor =
      globalThis.AudioContext ||
      (globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

    if (!AudioContextCtor) {
      return null;
    }

    if (!webAudioContextRef.current) {
      webAudioContextRef.current = new AudioContextCtor();
    }

    if (webAudioContextRef.current.state === 'suspended') {
      await webAudioContextRef.current.resume().catch(() => {});
    }

    return webAudioContextRef.current;
  }, []);

  const stopWebAlarm = useCallback(() => {
    if (webAlarmIntervalRef.current) {
      clearInterval(webAlarmIntervalRef.current);
      webAlarmIntervalRef.current = null;
    }
  }, []);

  const startWebAlarm = useCallback(async () => {
    const audioContext = await ensureWebAudioContext();
    if (!audioContext || webAlarmIntervalRef.current) {
      return;
    }

    const pattern: Array<'low' | 'high' | 'rest'> = ['low', 'high', 'rest'];
    let step = 0;
    const tick = () => {
      const kind = pattern[step % pattern.length];
      step += 1;
      if (kind === 'rest') return;

      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const now = audioContext.currentTime;
      const frequency = kind === 'low' ? 880 : 1174.66;
      const toneSec = 0.11;

      osc.type = 'square';
      osc.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(1.0, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(1.0, now + toneSec - 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + toneSec);

      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(now);
      osc.stop(now + toneSec + 0.01);
    };

    tick();
    webAlarmIntervalRef.current = setInterval(tick, 160);
  }, [ensureWebAudioContext]);

  useEffect(() => {
    let cancelled = false;

    ensureAlarmUri().then((uri) => {
      if (!cancelled) {
        alarmUriRef.current = uri;
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ANDROID_TIMER_STORAGE_KEY);
        if (!raw || cancelled) {
          setAndroidStorageReady(true);
          return;
        }
        const parsed = JSON.parse(raw) as PersistedTimerV1;
        if (parsed.v !== 1 || cancelled) {
          setAndroidStorageReady(true);
          return;
        }

        if (parsed.status === 'running' && parsed.endAtMs != null) {
          if (Date.now() >= parsed.endAtMs) {
            setDurationMs(parsed.durationMs);
            setStatus('alarming');
            setRemainingMs(0);
            setEndAtMs(null);
            setPausedRemainingMs(null);
            setModalDismissed(false);
          } else {
            setDurationMs(parsed.durationMs);
            setEndAtMs(parsed.endAtMs);
            setPausedRemainingMs(null);
            setStatus('running');
            setRemainingMs(Math.max(0, parsed.endAtMs - Date.now()));
            setModalDismissed(false);
          }
        } else if (parsed.status === 'paused') {
          setDurationMs(parsed.durationMs);
          setPausedRemainingMs(parsed.pausedRemainingMs);
          setEndAtMs(null);
          setStatus('paused');
          setRemainingMs(parsed.pausedRemainingMs ?? 0);
          setModalDismissed(false);
        } else if (parsed.status === 'alarming') {
          setDurationMs(parsed.durationMs);
          setStatus('alarming');
          setRemainingMs(0);
          setEndAtMs(null);
          setPausedRemainingMs(null);
          setModalDismissed(false);
        }
      } catch {
        // ignore corrupt storage
      } finally {
        if (!cancelled) {
          setAndroidStorageReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !androidStorageReady) {
      return;
    }
    if (status === 'idle') {
      void AsyncStorage.removeItem(ANDROID_TIMER_STORAGE_KEY);
      return;
    }
    const payload: PersistedTimerV1 = {
      v: 1,
      status,
      endAtMs,
      pausedRemainingMs,
      durationMs,
    };
    void AsyncStorage.setItem(ANDROID_TIMER_STORAGE_KEY, JSON.stringify(payload));
  }, [androidStorageReady, status, endAtMs, pausedRemainingMs, durationMs]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        return;
      }
      if (statusRef.current !== 'running') {
        return;
      }
      const end = endAtMsRef.current;
      if (end == null) {
        return;
      }
      if (Date.now() >= end) {
        setStatus('alarming');
        setRemainingMs(0);
        setEndAtMs(null);
        setPausedRemainingMs(null);
        setModalDismissed(false);
      } else {
        setRemainingMs(Math.max(0, end - Date.now()));
      }
    });
    return () => sub.remove();
  }, []);

  const enterAlarmFromBackground = useCallback(() => {
    setStatus((s) => (s === 'running' ? 'alarming' : s));
    setEndAtMs(null);
    setPausedRemainingMs(null);
    setRemainingMs(0);
    setModalDismissed(false);
  }, []);

  useEffect(() => {
    if (status !== 'running') {
      if (status === 'paused') {
        setRemainingMs(pausedRemainingMs ?? 0);
      } else if (status === 'idle') {
        setRemainingMs(0);
      }
      return;
    }

    setRemainingMs(getRemainingMs({ status, endAtMs, pausedRemainingMs }));
    const intervalId = setInterval(() => {
      const nextRemaining = getRemainingMs({ status, endAtMs, pausedRemainingMs });
      setRemainingMs(nextRemaining);
      if (nextRemaining <= 0) {
        setStatus('alarming');
        setRemainingMs(0);
        setEndAtMs(null);
        setPausedRemainingMs(null);
        setModalDismissed(false);
      }
    }, 1000);

    return () => clearInterval(intervalId);
  }, [status, endAtMs, pausedRemainingMs]);

  useEffect(() => {
    async function startAlarmSound() {
      if (status !== 'alarming' || soundRef.current) {
        if (Platform.OS === 'web') {
          await startWebAlarm();
        }
        return;
      }

      if (Platform.OS === 'web') {
        await startWebAlarm();
        return;
      }

      const uri = alarmUriRef.current ?? (await ensureAlarmUri());
      if (!uri) {
        return;
      }

      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
        });
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true, isLooping: true, volume: 1.0 }
        );
        soundRef.current = sound;
      } catch {
        soundRef.current = null;
      }
    }

    async function stopAlarmSound() {
      stopWebAlarm();
      const sound = soundRef.current;
      soundRef.current = null;
      if (!sound) {
        return;
      }
      await sound.stopAsync().catch(() => {});
      await sound.unloadAsync().catch(() => {});
    }

    if (status === 'alarming') {
      startAlarmSound();
      if (alarmTimeoutRef.current) {
        clearTimeout(alarmTimeoutRef.current);
      }
      alarmTimeoutRef.current = setTimeout(() => {
        void stopAlarmSound();
        setStatus('idle');
        setDurationMs(0);
        setRemainingMs(0);
        setPausedRemainingMs(null);
        setEndAtMs(null);
      }, 30000);
      return () => {
        if (alarmTimeoutRef.current) {
          clearTimeout(alarmTimeoutRef.current);
          alarmTimeoutRef.current = null;
        }
      };
    }

    void stopAlarmSound();
    if (alarmTimeoutRef.current) {
      clearTimeout(alarmTimeoutRef.current);
      alarmTimeoutRef.current = null;
    }
  }, [status, startWebAlarm, stopWebAlarm]);

  useEffect(() => {
    return () => {
      if (alarmTimeoutRef.current) {
        clearTimeout(alarmTimeoutRef.current);
      }
      stopWebAlarm();
      const sound = soundRef.current;
      soundRef.current = null;
      if (sound) {
        sound.stopAsync().catch(() => {});
        sound.unloadAsync().catch(() => {});
      }
      const webAudioContext = webAudioContextRef.current;
      webAudioContextRef.current = null;
      if (webAudioContext) {
        webAudioContext.close().catch(() => {});
      }
    };
  }, [stopWebAlarm]);

  const startTimer = useCallback((nextDurationMs: number) => {
    const now = Date.now();
    void ensureWebAudioContext();
    setDurationMs(nextDurationMs);
    setEndAtMs(now + nextDurationMs);
    setPausedRemainingMs(null);
    setRemainingMs(nextDurationMs);
    setStatus('running');
    setModalDismissed(false);
  }, [ensureWebAudioContext]);

  const pauseTimer = useCallback(() => {
    if (status !== 'running') {
      return;
    }
    const nextRemaining = getRemainingMs({ status, endAtMs, pausedRemainingMs });
    setPausedRemainingMs(nextRemaining);
    setRemainingMs(nextRemaining);
    setEndAtMs(null);
    setStatus('paused');
  }, [status, endAtMs, pausedRemainingMs]);

  const resumeTimer = useCallback(() => {
    if (status !== 'paused' || !pausedRemainingMs) {
      return;
    }
    const now = Date.now();
    void ensureWebAudioContext();
    setEndAtMs(now + pausedRemainingMs);
    setRemainingMs(pausedRemainingMs);
    setPausedRemainingMs(null);
    setStatus('running');
    setModalDismissed(false);
  }, [status, pausedRemainingMs, ensureWebAudioContext]);

  const cancelTimer = useCallback(() => {
    setStatus('idle');
    setDurationMs(0);
    setRemainingMs(0);
    setEndAtMs(null);
    setPausedRemainingMs(null);
    setModalDismissed(false);
  }, []);

  const dismissModal = useCallback(() => {
    setModalDismissed(true);
  }, []);

  const dismissAlarm = useCallback(() => {
    cancelTimer();
    setModalDismissed(true);
  }, [cancelTimer]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    setAndroidTimerControlHandlers({
      pauseTimer,
      resumeTimer,
      cancelTimer,
      dismissAlarm,
      enterAlarmFromBackground,
    });
    return () => setAndroidTimerControlHandlers(null);
  }, [
    pauseTimer,
    resumeTimer,
    cancelTimer,
    dismissAlarm,
    enterAlarmFromBackground,
  ]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !androidStorageReady) {
      return;
    }
    void syncAndroidTimerNotifications({ status, endAtMs, pausedRemainingMs });
  }, [androidStorageReady, status, endAtMs, pausedRemainingMs]);

  const handleTimerPageVisibility = useCallback((isVisible: boolean) => {
    setIsTimerVisible(isVisible);
    if (isVisible && status !== 'idle') {
      setModalDismissed(false);
    }
  }, [status]);

  const value: TimerContextValue = {
    status,
    durationMs,
    remainingMs,
    modalDismissed,
    isTimerVisible,
    isAlarming: status === 'alarming',
    startTimer,
    pauseTimer,
    resumeTimer,
    cancelTimer,
    dismissModal,
    dismissAlarm,
    handleTimerPageVisibility,
  };

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

export function useTimer() {
  const ctx = useContext(TimerContext);
  if (!ctx) {
    throw new Error('useTimer must be used within TimerProvider');
  }
  return ctx;
}
