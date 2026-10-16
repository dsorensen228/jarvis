import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { postInteractionsMute, postVoiceTap } from './api';
import { useKioskToast } from './KioskToastContext';
import { shouldShowJarvisUnreachable } from './jarvisReachability';

/** Debounce only tap-to-start so a double-tap does not fire two wakes. */
const START_TAP_DEBOUNCE_MS = 450;
const CONNECTING_TIMEOUT_MS = 2500;
const EVENT_RECONNECT_MAX_MS = 10_000;

export type VoiceUiPhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

/** Speech may be an announcement, so its phase is independent of an active session. */
export function voiceUiStateFromEvent(data: Record<string, unknown>): {
  voiceTurn: boolean;
  phase: VoiceUiPhase;
} {
  const voiceTurn = data.active === true;
  switch (data.phase) {
    case 'idle':
    case 'connecting':
    case 'listening':
    case 'thinking':
    case 'speaking':
    case 'error':
      return { voiceTurn, phase: data.phase };
    default:
      return { voiceTurn, phase: voiceTurn ? 'listening' : 'idle' };
  }
}

const VoiceTurnContext = createContext<{
  voiceTurn: boolean;
  connecting: boolean;
  phase: VoiceUiPhase;
  /** Persistent chrome when Jarvis (or the local events bridge) stays unreachable. */
  jarvisUnreachable: boolean;
  /** When true, wake word and tap-to-start are suppressed until Sherman long-press unmute. */
  interactionsMuted: boolean;
  requestVoiceTap: () => void;
  setInteractionsMuted: (muted: boolean) => Promise<void>;
  setVoiceTurn: (v: boolean) => void;
} | null>(null);

export function VoiceTurnProvider({ children }: { children: ReactNode }) {
  const { showToast } = useKioskToast();
  const [voiceTurn, setVoiceTurnState] = useState(false);
  const [devicePhase, setDevicePhase] = useState<VoiceUiPhase>('idle');
  const [connecting, setConnecting] = useState(false);
  const [errorFlash, setErrorFlash] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);
  const [jarvisUnreachable, setJarvisUnreachable] = useState(false);
  const [interactionsMuted, setInteractionsMutedState] = useState(false);

  const startTapGate = useRef(true);
  const voiceTurnRef = useRef(false);
  const devicePhaseRef = useRef<VoiceUiPhase>('idle');
  const voiceStateRevision = useRef(0);
  const interactionsMutedRef = useRef(false);
  const connectingTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const errorTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  voiceTurnRef.current = voiceTurn;
  devicePhaseRef.current = devicePhase;
  interactionsMutedRef.current = interactionsMuted;

  const clearConnectingTimer = useCallback(() => {
    if (connectingTimer.current !== null) {
      window.clearTimeout(connectingTimer.current);
      connectingTimer.current = null;
    }
  }, []);

  const setVoiceTurn = useCallback(
    (v: boolean) => {
      setVoiceTurnState(v);
      setDevicePhase(v ? 'listening' : 'idle');
      clearConnectingTimer();
      setConnecting(false);
      setErrorFlash(false);
    },
    [clearConnectingTimer]
  );

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof window.setTimeout> | null = null;
    let retryMs = 500;

    const connect = () => {
      if (closed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${window.location.host}/api/events`);
      socket.onopen = () => {
        if (closed) return;
        retryMs = 500;
        setEventsOpen(true);
      };
      socket.onmessage = (message) => {
        if (closed) return;
        try {
          const payload = JSON.parse(String(message.data)) as {
            type?: string;
            data?: Record<string, unknown>;
          };
          const data = payload.data || {};
          if (payload.type === 'voice.state') {
            const state = voiceUiStateFromEvent(data);
            voiceStateRevision.current += 1;
            setVoiceTurnState(state.voiceTurn);
            setDevicePhase(state.phase);
            clearConnectingTimer();
            setConnecting(state.phase === 'connecting');
            setErrorFlash(state.phase === 'error');
            setBackendConnected(Boolean(data.connected));
            if (typeof data.interactions_muted === 'boolean') {
              setInteractionsMutedState(data.interactions_muted);
            }
          } else if (payload.type === 'client.action') {
            window.dispatchEvent(
              new CustomEvent('jarvis-device-action', {
                detail: {
                  type: 'client_action',
                  action: data.action,
                  args: data.arguments,
                },
              })
            );
          }
        } catch {
          /* Ignore additive or malformed local events; the socket remains usable. */
        }
      };
      socket.onclose = () => {
        socket = null;
        if (closed) return;
        setEventsOpen(false);
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(EVENT_RECONNECT_MAX_MS, retryMs * 2);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [clearConnectingTimer]);

  const unreachableNow = !eventsOpen || backendConnected !== true;

  useEffect(() => {
    if (!unreachableNow) {
      setJarvisUnreachable(false);
      return;
    }
    const startedAt = Date.now();
    const tick = () => {
      setJarvisUnreachable(
        shouldShowJarvisUnreachable({
          eventsOpen,
          backendConnected,
          unreachableForMs: Date.now() - startedAt,
        })
      );
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [unreachableNow, eventsOpen, backendConnected]);

  useEffect(() => {
    return () => {
      clearConnectingTimer();
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    };
  }, [clearConnectingTimer]);

  const flashError = useCallback(
    (message: string) => {
      clearConnectingTimer();
      setConnecting(false);
      setErrorFlash(true);
      showToast(message);
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
      errorTimer.current = window.setTimeout(() => {
        errorTimer.current = null;
        setErrorFlash(false);
      }, 900);
    },
    [clearConnectingTimer, showToast]
  );

  const setInteractionsMuted = useCallback(
    async (muted: boolean) => {
      const previous = interactionsMutedRef.current;
      setInteractionsMutedState(muted);
      try {
        const state = await postInteractionsMute(muted);
        setInteractionsMutedState(Boolean(state.interactions_muted));
        showToast(state.interactions_muted ? 'Interactions muted' : 'Interactions unmuted');
      } catch {
        setInteractionsMutedState(previous);
        showToast("Couldn't change interaction mute");
        throw new Error("Couldn't change interaction mute");
      }
    },
    [showToast]
  );

  const requestVoiceTap = useCallback(() => {
    const wasActive = voiceTurnRef.current;
    const previousPhase = devicePhaseRef.current;
    const requestRevision = voiceStateRevision.current;

    // Hang-up: clear purple immediately — do not enter connecting (still purple).
    if (wasActive) {
      clearConnectingTimer();
      setErrorFlash(false);
      setConnecting(false);
      setVoiceTurnState(false);
      setDevicePhase('idle');
      void postVoiceTap().catch(() => {
        // A newer device snapshot is authoritative even if the HTTP request failed.
        if (voiceStateRevision.current !== requestRevision) return;
        flashError("Couldn't stop voice");
        setVoiceTurnState(true);
        setDevicePhase(previousPhase);
      });
      return;
    }

    if (interactionsMutedRef.current) {
      showToast('Interactions muted — long-press the robot to unmute');
      return;
    }

    if (!startTapGate.current) return;
    startTapGate.current = false;
    window.setTimeout(() => {
      startTapGate.current = true;
    }, START_TAP_DEBOUNCE_MS);

    clearConnectingTimer();
    setErrorFlash(false);
    setDevicePhase('idle');
    setConnecting(true);
    connectingTimer.current = window.setTimeout(() => {
      connectingTimer.current = null;
      setConnecting(false);
    }, CONNECTING_TIMEOUT_MS);

    void postVoiceTap()
      .then(() => {
        /* The local event socket confirms the state transition. */
      })
      .catch(() => {
        if (voiceStateRevision.current !== requestRevision) return;
        flashError("Couldn't start voice");
        setDevicePhase(previousPhase);
      });
  }, [clearConnectingTimer, flashError, showToast]);

  const phase: VoiceUiPhase = errorFlash
    ? 'error'
    : connecting
      ? 'connecting'
      : devicePhase;

  const value = useMemo(
    () => ({
      voiceTurn,
      connecting,
      phase,
      jarvisUnreachable,
      interactionsMuted,
      requestVoiceTap,
      setInteractionsMuted,
      setVoiceTurn,
    }),
    [
      voiceTurn,
      connecting,
      phase,
      jarvisUnreachable,
      interactionsMuted,
      requestVoiceTap,
      setInteractionsMuted,
      setVoiceTurn,
    ]
  );

  return <VoiceTurnContext.Provider value={value}>{children}</VoiceTurnContext.Provider>;
}

export function useVoiceTurn() {
  const ctx = useContext(VoiceTurnContext);
  if (!ctx) throw new Error('useVoiceTurn outside provider');
  return ctx;
}
