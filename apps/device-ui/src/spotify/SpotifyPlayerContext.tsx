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
import {
  fetchConfig,
  fetchSpotifyPlayerAccessToken,
  postSpotifyDisconnect,
  postSpotifyOAuthExchange,
  postSpotifyOptions,
  postSpotifyPlay,
  postSpotifyQueue,
  type SpotifyRepeatMode,
  type SpotifySearchItem,
  type UiConfig,
} from '../api';
import { generatePkcePairAsync, getRedirectUri, spotifyAuthorizeUrl } from '../spotifyPkce';

export interface SpotifyPlayerFull {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (s: unknown) => void): void;
  removeListener(event: string, cb: (s: unknown) => void): void;
  getCurrentState(): Promise<unknown>;
  setVolume(v: number): Promise<void>;
  activateElement(): Promise<void>;
  togglePlay(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(positionMs: number): Promise<void>;
}

interface SpotifyPlayerCtor {
  new (opts: {
    name: string;
    getOAuthToken: (cb: (t: string) => void) => void;
    volume?: number;
  }): SpotifyPlayerFull;
}

declare global {
  interface Window {
    Spotify?: { Player: SpotifyPlayerCtor };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export function trackLabel(state: unknown): { title: string; artist: string } | null {
  if (!state || typeof state !== 'object') return null;
  const st = state as {
    track_window?: { current_track?: { name?: string; artists?: { name?: string }[] } | null };
  };
  const track = st.track_window?.current_track;
  if (!track) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => (artist?.name || '').trim()).filter(Boolean)
    : [];
  return { title: track.name?.trim() || 'Unknown', artist: artists.join(', ') || '—' };
}

export function isPaused(state: unknown): boolean {
  return !state || typeof state !== 'object' || (state as { paused?: boolean }).paused !== false;
}

export function volumeFromState(state: unknown): number {
  if (!state || typeof state !== 'object') return KIOSK_DEFAULT_SPOTIFY_VOLUME;
  const volume = (state as { volume?: number }).volume;
  return typeof volume === 'number' && volume >= 0 && volume <= 1
    ? volume : KIOSK_DEFAULT_SPOTIFY_VOLUME;
}

export const SPOTIFY_MISSING_LABEL: Record<string, string> = {
  spotify_client_id: 'Client ID in device config',
  spotify_refresh_token: 'Connect Spotify on this device',
};

const SDK_READY_TIMEOUT_MS = 60_000;
const SPOTIFY_MAINTENANCE_MS = 15 * 60 * 1000;
const KIOSK_DEFAULT_SPOTIFY_VOLUME = 0.65;
const OPTION_CONFIRMATION_MS = 5000;

function lockedPlaybackVolume(cfg: UiConfig | null): number {
  const volume = cfg?.spotify_web_playback_volume;
  return typeof volume === 'number' && volume >= 0 && volume <= 1
    ? volume : KIOSK_DEFAULT_SPOTIFY_VOLUME;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function eventMessage(event: unknown, fallback: string): string {
  if (event && typeof event === 'object' && 'message' in event && event.message) {
    return String(event.message);
  }
  return fallback;
}

interface ActionState {
  paused?: boolean;
  position?: number;
  duration?: number;
  disallows?: Record<string, boolean>;
  [key: string]: unknown;
}

type PlaybackOption = 'shuffle' | 'repeat_mode';
interface ExpectedOption {
  value: boolean | number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SpotifyPlayerContextValue {
  cfg: UiConfig | null;
  err: string | null;
  sdkReady: boolean;
  sdkOffline: boolean;
  playerState: unknown;
  stateUpdatedAt: number;
  playerDeviceId: string | null;
  isReady: boolean;
  canControl: boolean;
  pendingAction: string | null;
  connectSpotify: () => void;
  disconnect: (sessionError?: string | null) => void;
  retryConnection: () => void;
  onTransport: (action: 'toggle' | 'next' | 'prev') => Promise<void>;
  playItem: (item: SpotifySearchItem) => Promise<boolean>;
  addToQueue: (item: SpotifySearchItem) => Promise<boolean>;
  seek: (positionMs: number) => Promise<void>;
  setShuffle: (enabled: boolean) => Promise<void>;
  setRepeat: (mode: SpotifyRepeatMode) => Promise<void>;
  refreshConfig: () => Promise<void>;
}

const SpotifyPlayerContext = createContext<SpotifyPlayerContextValue | null>(null);

export function SpotifyPlayerProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<UiConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<unknown>(null);
  const [stateUpdatedAt, setStateUpdatedAt] = useState(0);
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkOffline, setSdkOffline] = useState(false);
  const [playerDeviceId, setPlayerDeviceId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const mountedRef = useRef(true);
  const configRequestRef = useRef(0);
  const playerRef = useRef<SpotifyPlayerFull | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const actionRef = useRef(false);
  const signingOutRef = useRef(false);
  const stateRef = useRef<unknown>(null);
  const rawStateRef = useRef<unknown>(null);
  const expectedOptionsRef = useRef<Partial<Record<PlaybackOption, ExpectedOption>>>({});
  const stateTimeRef = useRef(0);
  const stateVersionRef = useRef(0);
  const reconnectRef = useRef<(() => void) | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const oauthExchangeRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const option of Object.values(expectedOptionsRef.current)) {
        if (option?.timer) clearTimeout(option.timer);
      }
      expectedOptionsRef.current = {};
    };
  }, []);

  const publishState = useCallback((state: unknown) => {
    if (!mountedRef.current) return;
    stateRef.current = state;
    stateTimeRef.current = Date.now();
    stateVersionRef.current += 1;
    setPlayerState(state);
    setStateUpdatedAt(stateTimeRef.current);
  }, []);

  const receiveState = useCallback((state: unknown) => {
    rawStateRef.current = state;
    let reconciled = state;
    for (const key of ['shuffle', 'repeat_mode'] as const) {
      const expected = expectedOptionsRef.current[key];
      if (!expected) continue;
      if (!state || typeof state !== 'object') {
        if (expected.timer) clearTimeout(expected.timer);
        delete expectedOptionsRef.current[key];
      } else {
        // Prioritize this device's recent choice for a bounded window, even
        // when a snapshot matches it: a rapid repeat cycle can match an ancient
        // "off" snapshot before a delayed "track" snapshot arrives. Track and
        // progress keep updating; external option changes appear after 5s.
        reconciled = { ...(reconciled as ActionState), [key]: expected.value };
      }
    }
    publishState(reconciled);
  }, [publishState]);

  const refreshConfig = useCallback(async () => {
    const request = ++configRequestRef.current;
    const config = await fetchConfig();
    if (mountedRef.current && request === configRequestRef.current) {
      cfgRef.current = config;
      setCfg(config);
    }
  }, []);

  useEffect(() => {
    void refreshConfig().catch((error: unknown) => {
      if (mountedRef.current) setErr(messageOf(error, 'Could not load Spotify settings.'));
    });
  }, [refreshConfig]);

  // The one-time code exchange is guarded independently of config renders and
  // StrictMode effect replays, so a code cannot be exchanged twice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthError = params.get('error');
    if (oauthError) {
      setErr(`Spotify: ${oauthError}`);
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
      return;
    }
    if (!code || !cfg?.spotify_client_id || oauthExchangeRef.current === code) return;
    const verifier = sessionStorage.getItem('spotify_pkce_verifier');
    if (!verifier) {
      setErr('Spotify sign-in expired. Connect again.');
      return;
    }
    oauthExchangeRef.current = code;
    void (async () => {
      try {
        await postSpotifyOAuthExchange({ code, redirect_uri: getRedirectUri(), code_verifier: verifier });
        sessionStorage.removeItem('spotify_pkce_verifier');
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
        await refreshConfig();
        if (mountedRef.current) setErr(null);
      } catch (error) {
        if (mountedRef.current) setErr(messageOf(error, 'Spotify sign-in failed. Connect again.'));
      }
    })();
  }, [cfg?.spotify_client_id, refreshConfig]);

  const isReady = Boolean(cfg?.spotify_client_id && cfg.spotify_ready);

  // One SDK instance owns a generation. Every asynchronous continuation and
  // listener checks that generation before it can change the current player.
  // Network failures only affect this connection; saved credentials survive.
  useEffect(() => {
    if (!isReady) return;
    let disposed = false;
    let player: SpotifyPlayerFull | null = null;
    let connecting = false;
    let permanentFailure = false;
    // A manual Retry also refreshes a possibly rejected cached access token.
    let forceTokenRefresh = connectionAttempt > 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const listeners: [string, (event: unknown) => void][] = [];
    const isCurrent = () => !disposed && mountedRef.current && !signingOutRef.current;
    const clearReadyTimer = () => {
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = null;
    };
    const markOffline = (message: string) => {
      if (!isCurrent()) return;
      clearReadyTimer();
      readyRef.current = false;
      setSdkOffline(true);
      setErr(message);
    };
    const armReadyTimer = () => {
      clearReadyTimer();
      readyTimer = setTimeout(() => {
        markOffline('Spotify is taking longer to connect. Check the network and retry.');
      }, SDK_READY_TIMEOUT_MS);
    };
    const refreshState = async () => {
      if (!player || !isCurrent()) return;
      const version = stateVersionRef.current;
      try {
        const state = await player.getCurrentState();
        if (isCurrent() && version === stateVersionRef.current) receiveState(state);
      } catch { /* A state refresh must not sign the device out. */ }
    };
    const connect = async () => {
      if (!player || connecting || !isCurrent()) return;
      connecting = true;
      armReadyTimer();
      try {
        const connected = await player.connect();
        if (isCurrent() && !connected) {
          markOffline('Spotify could not connect. Retry when the network is available.');
          scheduleReconnect();
        }
      } catch (error) {
        markOffline(messageOf(error, 'Spotify could not connect. Please retry.'));
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };
    const scheduleReconnect = () => {
      if (!isCurrent() || permanentFailure || retryTimer || retryCount >= 3) return;
      const delay = [3000, 10_000, 30_000][retryCount++];
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (connecting) scheduleReconnect();
        else void connect();
      }, delay);
    };
    const createPlayer = () => {
      if (!isCurrent() || player || !window.Spotify?.Player) return;
      try {
        player = new window.Spotify.Player({
          name: cfgRef.current?.spotify_player_name || cfgRef.current?.device_id || 'Jarvis',
          volume: lockedPlaybackVolume(cfgRef.current),
          getOAuthToken: (callback) => {
            const refresh = forceTokenRefresh;
            forceTokenRefresh = false;
            void fetchSpotifyPlayerAccessToken(refresh).then((row) => {
              if (isCurrent()) callback(row.access_token);
            }).catch(() => {
              if (!isCurrent()) return;
              markOffline('Could not refresh Spotify. Retry the connection, or connect your account again.');
              callback('');
              scheduleReconnect();
            });
          },
        });
        playerRef.current = player;
        const listen = (event: string, handler: (event: unknown) => void) => {
          const guarded = (data: unknown) => { if (isCurrent()) handler(data); };
          listeners.push([event, guarded]);
          player!.addListener(event, guarded);
        };
        listen('ready', (event) => {
          const id = event && typeof event === 'object' && 'device_id' in event
            ? String(event.device_id || '') : '';
          if (!id) {
            markOffline('Spotify did not provide a playback device. Please retry.');
            return;
          }
          clearReadyTimer();
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          retryCount = 0;
          deviceIdRef.current = id;
          readyRef.current = true;
          setPlayerDeviceId(id);
          setSdkReady(true);
          setSdkOffline(false);
          setErr(null);
          void player!.setVolume(lockedPlaybackVolume(cfgRef.current)).catch(() => {});
          void refreshState();
        });
        listen('not_ready', () => {
          markOffline('Spotify connection was interrupted. Reconnecting…');
          scheduleReconnect();
        });
        listen('player_state_changed', receiveState);
        listen('authentication_error', () => {
          forceTokenRefresh = true;
          markOffline('Spotify needs to refresh its connection. Retrying…');
          scheduleReconnect();
        });
        listen('account_error', (event) => {
          permanentFailure = true;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          markOffline(eventMessage(event, 'Spotify Premium is required for playback on this device.'));
        });
        listen('initialization_error', (event) => {
          permanentFailure = true;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          markOffline(eventMessage(event, 'Spotify could not start. Please retry.'));
        });
        listen('playback_error', (event) => {
          setErr(eventMessage(event, 'Spotify could not play this item. Try another selection.'));
        });
        listen('autoplay_failed', () => {
          setErr('Tap Play to allow Spotify audio on this device.');
        });
        void connect();
      } catch (error) {
        markOffline(messageOf(error, 'Spotify could not start. Please retry.'));
      }
    };

    setSdkOffline(false);
    setSdkReady(false);
    setPlayerDeviceId(null);
    readyRef.current = false;
    deviceIdRef.current = null;
    receiveState(null);
    armReadyTimer();
    const scriptId = 'spotify-player-sdk';
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    const previousReadyCallback = window.onSpotifyWebPlaybackSDKReady;
    const onSdkReady = () => { createPlayer(); };
    const onScriptError = () => {
      if (script) script.dataset.failed = 'true';
      clearReadyTimer();
      markOffline('Spotify player could not load. Check the network and retry.');
    };
    window.onSpotifyWebPlaybackSDKReady = onSdkReady;
    if (window.Spotify?.Player) {
      createPlayer();
    } else {
      // A failed or timed-out script must be replaceable by the Retry button.
      if (script && (script.dataset.failed === 'true' || connectionAttempt > 0)) {
        script.remove();
        script = null;
      }
      if (!script) {
        script = document.createElement('script');
        script.id = scriptId;
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        script.addEventListener('error', onScriptError);
        document.body.appendChild(script);
      } else {
        script.addEventListener('error', onScriptError);
      }
    }
    const reconnect = () => {
      if (isCurrent() && !readyRef.current) {
        retryCount = 0;
        if (player) void connect();
        else createPlayer();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnect();
        void refreshState();
      }
    };
    reconnectRef.current = reconnect;
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', onVisible);
    const maintenance = window.setInterval(reconnect, SPOTIFY_MAINTENANCE_MS);
    const teardown = () => {
      if (disposed) return;
      disposed = true;
      clearReadyTimer();
      if (retryTimer) clearTimeout(retryTimer);
      window.clearInterval(maintenance);
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', onVisible);
      script?.removeEventListener('error', onScriptError);
      if (window.onSpotifyWebPlaybackSDKReady === onSdkReady) {
        window.onSpotifyWebPlaybackSDKReady = previousReadyCallback;
      }
      if (playerRef.current === player) {
        playerRef.current = null;
        readyRef.current = false;
        deviceIdRef.current = null;
      }
      if (player) {
        for (const [event, handler] of listeners) {
          try { player.removeListener(event, handler); } catch { /* Already torn down by SDK. */ }
        }
        try { player.disconnect(); } catch { /* The generation is already invalidated. */ }
      }
      if (reconnectRef.current === reconnect) reconnectRef.current = null;
    };
    teardownRef.current = teardown;
    return teardown;
  }, [isReady, cfg?.spotify_client_id, connectionAttempt, receiveState]);

  const retryConnection = useCallback(() => {
    if (signingOutRef.current) return;
    setErr(null);
    if (cfgRef.current?.spotify_ready) {
      setConnectionAttempt((attempt) => attempt + 1);
    } else {
      void refreshConfig().catch((error: unknown) => {
        if (mountedRef.current) setErr(messageOf(error, 'Could not load Spotify settings.'));
      });
    }
  }, [refreshConfig]);

  const disconnect = useCallback((sessionError?: string | null) => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    teardownRef.current?.();
    setSdkReady(false);
    setSdkOffline(false);
    setPlayerDeviceId(null);
    receiveState(null);
    setErr(null);
    void (async () => {
      try {
        await postSpotifyDisconnect();
        configRequestRef.current += 1;
        if (!mountedRef.current) return;
        const previous = cfgRef.current;
        if (previous) {
          const disconnected = { ...previous, spotify_ready: false, spotify_connected: false };
          cfgRef.current = disconnected;
          setCfg(disconnected);
        }
        window.dispatchEvent(new Event('jarvis-spotify-disconnected'));
        setErr(sessionError || null);
      } catch (error) {
        if (mountedRef.current) {
          setSdkOffline(true);
          setErr(messageOf(error, 'Could not sign out. Please try again.'));
        }
      } finally {
        signingOutRef.current = false;
      }
    })();
  }, [receiveState]);

  const connectSpotify = useCallback(() => {
    void (async () => {
      try {
        const clientId = cfgRef.current?.spotify_client_id;
        if (!clientId) throw new Error('Spotify is not configured on this device.');
        setErr(null);
        const { verifier, challenge } = await generatePkcePairAsync();
        sessionStorage.setItem('spotify_pkce_verifier', verifier);
        window.location.href = spotifyAuthorizeUrl(clientId, getRedirectUri(), challenge);
      } catch (error) {
        if (mountedRef.current) setErr(messageOf(error, 'Could not start Spotify sign-in.'));
      }
    })();
  }, []);

  const runAction = useCallback(async (
    action: string,
    perform: (player: SpotifyPlayerFull, deviceId: string) => Promise<void>,
    requiresPlayback = false
  ): Promise<boolean> => {
    if (actionRef.current || signingOutRef.current) return false;
    const player = playerRef.current;
    const deviceId = deviceIdRef.current;
    if (!player || !deviceId || !readyRef.current) {
      setErr('Spotify is still connecting. Retry the connection if it takes too long.');
      return false;
    }
    if (requiresPlayback && !stateRef.current) {
      setErr('Choose something to play on this device first.');
      return false;
    }
    actionRef.current = true;
    setPendingAction(action);
    setErr(null);
    try {
      // Activation starts inside the user gesture, before any network round trip.
      await player.activateElement();
      if (playerRef.current !== player || !readyRef.current) return false;
      await perform(player, deviceId);
      return playerRef.current === player;
    } catch (error) {
      if (mountedRef.current && playerRef.current === player) {
        setErr(messageOf(error, 'Spotify could not complete that action. Please try again.'));
      }
      return false;
    } finally {
      actionRef.current = false;
      if (mountedRef.current) setPendingAction(null);
    }
  }, []);

  const restricted = useCallback((...restrictions: string[]) => {
    const state = stateRef.current as ActionState | null;
    if (restrictions.some((restriction) => state?.disallows?.[restriction])) {
      setErr('Spotify does not allow that control for the current item.');
      return true;
    }
    return false;
  }, []);

  const refreshAfterAction = useCallback(async (player: SpotifyPlayerFull) => {
    const version = stateVersionRef.current;
    try {
      const state = await player.getCurrentState();
      if (playerRef.current === player && stateVersionRef.current === version) receiveState(state);
    } catch { /* The SDK state event can still complete the update. */ }
  }, [receiveState]);

  const onTransport = useCallback(async (action: 'toggle' | 'next' | 'prev') => {
    const restriction = action === 'next' ? 'skipping_next' : action === 'prev' ? 'skipping_prev'
      : isPaused(stateRef.current) ? 'resuming' : 'pausing';
    if (restricted(restriction)) return;
    await runAction(action, async (player) => {
      if (action === 'toggle') await player.togglePlay();
      else if (action === 'next') await player.nextTrack();
      else await player.previousTrack();
      await refreshAfterAction(player);
    }, true);
  }, [restricted, runAction, refreshAfterAction]);

  const playItem = useCallback((item: SpotifySearchItem) => runAction('play', async (player, deviceId) => {
    await postSpotifyPlay({ spotify_uri: item.uri, device_id: deviceId });
    await refreshAfterAction(player);
  }), [runAction, refreshAfterAction]);

  const addToQueue = useCallback(async (item: SpotifySearchItem) => {
    if (item.kind !== 'track' || !item.uri.startsWith('spotify:track:')) {
      setErr('Only tracks can be added to the queue.');
      return false;
    }
    return runAction('queue', async (_player, deviceId) => {
      await postSpotifyQueue(item.uri, deviceId);
    }, true);
  }, [runAction]);

  const patchState = useCallback((patch: Record<string, unknown>) => {
    const state = stateRef.current as ActionState | null;
    if (!state) return;
    const elapsed = state.paused === false ? Math.max(0, Date.now() - stateTimeRef.current) : 0;
    const position = Math.min(state.duration || Infinity, (state.position || 0) + elapsed);
    // A local optimistic update is not an SDK acknowledgement.
    publishState({ ...state, position, ...patch });
  }, [publishState]);

  const patchOption = useCallback((key: PlaybackOption, value: boolean | number) => {
    if (!stateRef.current) return;
    const previous = expectedOptionsRef.current[key];
    if (previous?.timer) clearTimeout(previous.timer);
    const expected: ExpectedOption = {
      value, timer: null,
    };
    expectedOptionsRef.current[key] = expected;
    expected.timer = setTimeout(() => {
      if (expectedOptionsRef.current[key] !== expected) return;
      delete expectedOptionsRef.current[key];
      const raw = rawStateRef.current as ActionState | null;
      // Release local priority at the deadline, then ask for a fresh SDK view.
      // The latest received value is the fallback if that read fails or stalls.
      if (mountedRef.current && raw) patchState({ [key]: raw[key] });
      const player = playerRef.current;
      const version = stateVersionRef.current;
      if (player) {
        void player.getCurrentState().then((state) => {
          if (mountedRef.current && playerRef.current === player
            && stateVersionRef.current === version) receiveState(state);
        }).catch(() => { /* The latest raw SDK value was already restored. */ });
      }
    }, OPTION_CONFIRMATION_MS);
    patchState({ [key]: value });
  }, [patchState, receiveState]);

  const seek = useCallback(async (positionMs: number) => {
    if (!Number.isFinite(positionMs) || restricted('seeking')) return;
    const state = stateRef.current as ActionState | null;
    const position = Math.round(Math.max(0, Math.min(positionMs, state?.duration || 0)));
    await runAction('seek', async (player) => {
      const version = stateVersionRef.current;
      await player.seek(position);
      if (playerRef.current === player && stateVersionRef.current === version) patchState({ position });
    }, true);
  }, [runAction, restricted, patchState]);

  const setShuffle = useCallback(async (enabled: boolean) => {
    if (restricted('toggling_shuffle')) return;
    await runAction('shuffle', async (player, deviceId) => {
      await postSpotifyOptions({ device_id: deviceId, shuffle: enabled });
      if (playerRef.current === player) patchOption('shuffle', enabled);
    }, true);
  }, [runAction, restricted, patchOption]);

  const setRepeat = useCallback(async (mode: SpotifyRepeatMode) => {
    const restriction = mode === 'track' ? 'toggling_repeat_track' : 'toggling_repeat_context';
    if (restricted(restriction)) return;
    await runAction('repeat', async (player, deviceId) => {
      await postSpotifyOptions({ device_id: deviceId, repeat: mode });
      if (playerRef.current === player) patchOption('repeat_mode', { off: 0, context: 1, track: 2 }[mode]);
    }, true);
  }, [runAction, restricted, patchOption]);

  const value = useMemo<SpotifyPlayerContextValue>(() => ({
    cfg, err, sdkReady, sdkOffline, playerState, stateUpdatedAt, playerDeviceId, isReady,
    canControl: isReady && sdkReady && !sdkOffline && Boolean(playerDeviceId),
    pendingAction, connectSpotify, disconnect, retryConnection, onTransport, playItem, addToQueue,
    seek, setShuffle, setRepeat, refreshConfig,
  }), [cfg, err, sdkReady, sdkOffline, playerState, stateUpdatedAt, playerDeviceId, isReady,
    pendingAction, connectSpotify, disconnect, retryConnection, onTransport, playItem, addToQueue,
    seek, setShuffle, setRepeat, refreshConfig]);

  return <SpotifyPlayerContext.Provider value={value}>{children}</SpotifyPlayerContext.Provider>;
}

export function useSpotifyPlayer(): SpotifyPlayerContextValue {
  const context = useContext(SpotifyPlayerContext);
  if (!context) throw new Error('useSpotifyPlayer must be used under SpotifyPlayerProvider');
  return context;
}
