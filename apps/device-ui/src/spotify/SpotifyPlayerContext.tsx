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
  type UiConfig,
} from '../api';
import {
  generatePkcePairAsync,
  getRedirectUri,
  spotifyAuthorizeUrl,
} from '../spotifyPkce';

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
  const t = st.track_window?.current_track;
  if (!t) return null;
  const title = (t.name || 'Unknown').trim() || 'Unknown';
  const arts = Array.isArray(t.artists) ? t.artists.map((a) => (a?.name || '').trim()).filter(Boolean) : [];
  return { title, artist: arts.join(', ') || '—' };
}

export function isPaused(state: unknown): boolean {
  if (!state || typeof state !== 'object') return true;
  return Boolean((state as { paused?: boolean }).paused);
}

export function volumeFromState(state: unknown): number {
  if (!state || typeof state !== 'object') return KIOSK_DEFAULT_SPOTIFY_VOLUME;
  const v = (state as { volume?: number }).volume;
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : KIOSK_DEFAULT_SPOTIFY_VOLUME;
}

export const SPOTIFY_MISSING_LABEL: Record<string, string> = {
  spotify_client_id: 'Client ID in device config',
  spotify_refresh_token: 'Connect Spotify on this device',
};

/** Max wait for Web Playback SDK `ready` before clearing session (kiosk / flaky networks). */
const SDK_READY_TIMEOUT_MS = 60_000;

/** Proactive access-token refresh + Web Playback `connect()` without visiting the Music route. */
const SPOTIFY_MAINTENANCE_MS = 15 * 60 * 1000;

/** Locked Web Playback gain from device config (kiosk uses system volume for loudness). */
const KIOSK_DEFAULT_SPOTIFY_VOLUME = 0.65;

function lockedPlaybackVolume(cfg: UiConfig | null): number {
  const v = cfg?.spotify_web_playback_volume;
  if (typeof v === 'number' && v >= 0 && v <= 1) return v;
  return KIOSK_DEFAULT_SPOTIFY_VOLUME;
}

export interface SpotifyPlayerContextValue {
  cfg: UiConfig | null;
  err: string | null;
  /** True after Web Playback SDK `ready` at least once (stays true through transient offline). */
  sdkReady: boolean;
  sdkOffline: boolean;
  playerState: unknown;
  /** True when the device has a client id and its own refresh token. */
  isReady: boolean;
  connectSpotify: () => void;
  /** Omit `sessionError` (manual sign out) to clear errors; pass a string to show on the sign-in screen. */
  disconnect: (sessionError?: string | null) => void;
  onTransport: (action: 'toggle' | 'next' | 'prev') => Promise<void>;
  refreshConfig: () => Promise<void>;
}

const SpotifyPlayerContext = createContext<SpotifyPlayerContextValue | null>(null);

export function SpotifyPlayerProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<UiConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<unknown>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkOffline, setSdkOffline] = useState(false);
  const playerRef = useRef<SpotifyPlayerFull | null>(null);
  const creatingRef = useRef(false);
  const stateListenerRef = useRef<((s: unknown) => void) | null>(null);
  const sdkReadyRef = useRef(false);
  const sdkReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cfgRef = useRef(cfg);
  const sdkOfflineRef = useRef(false);
  /** Prevents overlapping `authentication_error` / `account_error` recoveries from wiping the session. */
  const spotifyAuthRecoveryInFlightRef = useRef(false);

  useEffect(() => {
    sdkReadyRef.current = sdkReady;
  }, [sdkReady]);

  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);

  useEffect(() => {
    sdkOfflineRef.current = sdkOffline;
  }, [sdkOffline]);

  const refreshConfig = useCallback(async () => {
    const c = await fetchConfig();
    setCfg(c);
  }, []);

  const clearSdkReadyTimer = useCallback(() => {
    if (sdkReadyTimeoutRef.current) {
      clearTimeout(sdkReadyTimeoutRef.current);
      sdkReadyTimeoutRef.current = null;
    }
  }, []);

  /** Tear down player and revoke file-based refresh on the server. Pass a message for the sign-in screen. */
  const disconnect = useCallback(
    (sessionError?: string | null) => {
      clearSdkReadyTimer();
      const p = playerRef.current;
      if (p && stateListenerRef.current) {
        try {
          p.removeListener('player_state_changed', stateListenerRef.current);
        } catch {
          /* ignore */
        }
      }
      p?.disconnect();
      playerRef.current = null;
      stateListenerRef.current = null;
      setPlayerState(null);
      setSdkReady(false);
      sdkReadyRef.current = false;
      setSdkOffline(false);
      spotifyAuthRecoveryInFlightRef.current = false;
      setErr(typeof sessionError === 'string' && sessionError.length > 0 ? sessionError : null);
      void (async () => {
        try {
          await postSpotifyDisconnect();
        } catch {
          /* e.g. inline refresh only in config */
        }
        try {
          await refreshConfig();
        } catch {
          /* ignore */
        }
      })();
    },
    [clearSdkReadyTimer, refreshConfig]
  );

  useEffect(() => {
    void (async () => {
      try {
        await refreshConfig();
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'config');
      }
    })();
  }, [refreshConfig]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthErr = params.get('error');
    if (oauthErr) {
      setErr(`Spotify: ${oauthErr}`);
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
      return;
    }
    if (!code || !cfg?.spotify_client_id) return;

    const redirect = getRedirectUri();
    const verifier = sessionStorage.getItem('spotify_pkce_verifier');
    if (!verifier) {
      setErr('PKCE verifier missing; try Connect again');
      return;
    }

    void (async () => {
      try {
        await postSpotifyOAuthExchange({
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        });
        sessionStorage.removeItem('spotify_pkce_verifier');
        window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
        await refreshConfig();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'token exchange failed');
      }
    })();
  }, [cfg, refreshConfig]);

  const getOAuthToken = useCallback(
    async (cb: (t: string) => void) => {
      if (!cfg?.spotify_client_id) {
        cb('');
        return;
      }
      try {
        const row = await fetchSpotifyPlayerAccessToken();
        cb(row.access_token);
      } catch {
        disconnect('Could not refresh Spotify login. Sign in again.');
        cb('');
      }
    },
    [cfg, disconnect]
  );

  const createPlayer = useCallback(() => {
    if (!cfg?.spotify_client_id || creatingRef.current) return;
    if (!cfg.spotify_ready) return;
    const Player = window.Spotify?.Player;
    if (!Player) return;
    creatingRef.current = true;
    const name = cfg.spotify_player_name || cfg.device_id;
    try {
      const player = new Player({
        name,
        getOAuthToken,
        volume: lockedPlaybackVolume(cfg),
      }) as SpotifyPlayerFull;

      const onState = (s: unknown) => {
        setPlayerState(s);
      };
      stateListenerRef.current = onState;

      const recoverFromAuthError = (detail: string) => {
        void (async () => {
          if (spotifyAuthRecoveryInFlightRef.current) return;
          const c = cfgRef.current;
          if (!c?.spotify_client_id || !c.spotify_ready) {
            disconnect(detail);
            return;
          }
          spotifyAuthRecoveryInFlightRef.current = true;
          const attempts = 3;
          const delaysMs = [0, 500, 1500];
          try {
            for (let i = 0; i < attempts; i++) {
              if (delaysMs[i] > 0) {
                await new Promise((r) => setTimeout(r, delaysMs[i]));
              }
              try {
                await fetchSpotifyPlayerAccessToken();
                const ok2 = await player.connect();
                if (!ok2) setSdkOffline(true);
                return;
              } catch {
                if (i === attempts - 1) {
                  disconnect(
                    'Spotify could not refresh your login after several tries. Use Connect again.'
                  );
                }
              }
            }
          } finally {
            spotifyAuthRecoveryInFlightRef.current = false;
          }
        })();
      };

      player.addListener('ready', () => {
        clearSdkReadyTimer();
        setSdkReady(true);
        setSdkOffline(false);
        void player.setVolume(lockedPlaybackVolume(cfgRef.current)).catch(() => {});
        void player.getCurrentState().then((s) => {
          if (s) onState(s);
        });
      });
      player.addListener('not_ready', () => {
        setSdkOffline(true);
      });
      player.addListener('authentication_error', (ev: unknown) => {
        const msg =
          ev && typeof ev === 'object' && 'message' in ev
            ? String((ev as { message?: string }).message || '')
            : '';
        recoverFromAuthError(msg ? `Spotify: ${msg}` : 'Spotify authentication failed. Sign in again.');
      });
      player.addListener('account_error', (ev: unknown) => {
        const msg =
          ev && typeof ev === 'object' && 'message' in ev
            ? String((ev as { message?: string }).message || '')
            : '';
        recoverFromAuthError(msg ? `Spotify account: ${msg}` : 'Spotify account error. Sign in again.');
      });
      player.addListener('initialization_error', (ev: unknown) => {
        const msg =
          ev && typeof ev === 'object' && 'message' in ev
            ? String((ev as { message?: string }).message || '')
            : '';
        creatingRef.current = false;
        disconnect(msg ? `Spotify player: ${msg}` : 'Spotify player failed to start.');
      });
      player.addListener('player_state_changed', onState);

      void player.connect().then((ok) => {
        creatingRef.current = false;
        if (ok) {
          playerRef.current = player;
        } else {
          disconnect('Could not start Spotify player. Sign in again.');
        }
      });
    } catch {
      creatingRef.current = false;
      disconnect('Failed to create Spotify player. Sign in again.');
    }
  }, [cfg, getOAuthToken, clearSdkReadyTimer, disconnect]);

  useEffect(() => {
    if (!cfg?.spotify_client_id || !cfg.spotify_ready) return;

    const scriptId = 'spotify-player-sdk';
    if (document.getElementById(scriptId)) {
      if (window.Spotify?.Player) createPlayer();
      return () => {
        clearSdkReadyTimer();
        const p = playerRef.current;
        if (p && stateListenerRef.current) {
          try {
            p.removeListener('player_state_changed', stateListenerRef.current);
          } catch {
            /* ignore */
          }
        }
        p?.disconnect();
        playerRef.current = null;
        setSdkReady(false);
        sdkReadyRef.current = false;
        setSdkOffline(false);
      };
    }

    window.onSpotifyWebPlaybackSDKReady = () => {
      createPlayer();
    };

    const script = document.createElement('script');
    script.id = scriptId;
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.onerror = () => {
      disconnect('Could not load Spotify player. Check network or sign in again.');
    };
    document.body.appendChild(script);

    return () => {
      clearSdkReadyTimer();
      window.onSpotifyWebPlaybackSDKReady = undefined;
      const p = playerRef.current;
      if (p && stateListenerRef.current) {
        try {
          p.removeListener('player_state_changed', stateListenerRef.current);
        } catch {
          /* ignore */
        }
      }
      p?.disconnect();
      playerRef.current = null;
      setSdkReady(false);
      sdkReadyRef.current = false;
      setSdkOffline(false);
    };
  }, [cfg?.spotify_client_id, cfg?.spotify_ready, createPlayer, clearSdkReadyTimer, disconnect]);

  useEffect(() => {
    const bumpConnect = () => {
      const p = playerRef.current;
      if (!p) return;
      if (sdkOfflineRef.current || !sdkReadyRef.current) {
        void p
          .connect()
          .then((ok) => {
            if (ok) setSdkOffline(false);
          })
          .catch(() => {});
      }
    };
    window.addEventListener('online', bumpConnect);
    document.addEventListener('visibilitychange', bumpConnect);
    return () => {
      window.removeEventListener('online', bumpConnect);
      document.removeEventListener('visibilitychange', bumpConnect);
    };
  }, []);

  useEffect(() => {
    if (!cfg?.spotify_client_id) return;
    const id = window.setInterval(() => {
      void (async () => {
        const c = cfgRef.current;
        if (!c?.spotify_client_id) return;
        if (!c.spotify_ready) return;
        try {
          await fetchSpotifyPlayerAccessToken();
        } catch {
          /* transient network; avoid clearing session here */
        }
        const p = playerRef.current;
        if (p) {
          try {
            const ok = await p.connect();
            if (ok) setSdkOffline(false);
          } catch {
            /* ignore */
          }
        }
      })();
    }, SPOTIFY_MAINTENANCE_MS);
    return () => window.clearInterval(id);
  }, [cfg?.spotify_client_id, cfg?.spotify_ready]);

  useEffect(() => {
    if (sdkReady) {
      clearSdkReadyTimer();
    }
  }, [sdkReady, clearSdkReadyTimer]);

  useEffect(() => {
    if (!cfg?.spotify_client_id) {
      clearSdkReadyTimer();
      return;
    }
    if (!cfg.spotify_ready) {
      clearSdkReadyTimer();
      return;
    }
    clearSdkReadyTimer();
    sdkReadyTimeoutRef.current = setTimeout(() => {
      if (!sdkReadyRef.current) {
        disconnect('Playback didn’t start in time. Sign in again.');
      }
    }, SDK_READY_TIMEOUT_MS);
    return () => clearSdkReadyTimer();
  }, [cfg?.spotify_client_id, cfg?.spotify_ready, disconnect, clearSdkReadyTimer]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || !sdkReady) return;
    const v = lockedPlaybackVolume(cfg);
    void p.setVolume(v).catch(() => {});
  }, [cfg, sdkReady]);

  const connectSpotify = useCallback(() => {
    void (async () => {
      if (!cfg?.spotify_client_id) {
        setErr('spotify_client_id not in device config');
        return;
      }
      setErr(null);
      const { verifier, challenge } = await generatePkcePairAsync();
      sessionStorage.setItem('spotify_pkce_verifier', verifier);
      const redirect = getRedirectUri();
      const url = spotifyAuthorizeUrl(cfg.spotify_client_id, redirect, challenge);
      window.location.href = url;
    })();
  }, [cfg]);

  const onTransport = useCallback(async (action: 'toggle' | 'next' | 'prev') => {
    const p = playerRef.current;
    if (!p) return;
    try {
      await p.activateElement();
    } catch {
      /* non-fatal on some builds */
    }
    try {
      if (action === 'toggle') await p.togglePlay();
      else if (action === 'next') await p.nextTrack();
      else await p.previousTrack();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'playback control failed');
    }
  }, []);

  const isReady = Boolean(cfg?.spotify_client_id && cfg.spotify_ready === true);

  const value = useMemo<SpotifyPlayerContextValue>(
    () => ({
      cfg,
      err,
      sdkReady,
      sdkOffline,
      playerState,
      isReady,
      connectSpotify,
      disconnect,
      onTransport,
      refreshConfig,
    }),
    [
      cfg,
      err,
      sdkReady,
      sdkOffline,
      playerState,
      isReady,
      connectSpotify,
      disconnect,
      onTransport,
      refreshConfig,
    ]
  );

  return <SpotifyPlayerContext.Provider value={value}>{children}</SpotifyPlayerContext.Provider>;
}

export function useSpotifyPlayer(): SpotifyPlayerContextValue {
  const ctx = useContext(SpotifyPlayerContext);
  if (!ctx) throw new Error('useSpotifyPlayer must be used under SpotifyPlayerProvider');
  return ctx;
}
