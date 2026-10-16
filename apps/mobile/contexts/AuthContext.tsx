import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMe, type User } from '@/lib/api-client';
import { getApiBaseUrl, ngrokSkipBrowserWarningHeaders } from '@/lib/runtimePublicEnv';
import { jwtDecode } from 'jwt-decode';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const ACCESS_TOKEN_KEY = '@jarvis_app/accessToken';
const REFRESH_TOKEN_KEY = '@jarvis_app/refreshToken';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  isLoading: boolean;
  authError: string | null;
}

interface AuthContextValue extends AuthState {
  setAuthFromTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  signOut: (authErrorMessage?: string | null) => void;
  setAuthError: (message: string | null) => void;
  clearAuthError: () => void;
  refreshUser: (user: User) => void;
  refreshSession: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    accessToken: null,
    refreshToken: null,
    user: null,
    isLoading: true,
    authError: null,
  });

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSessionRef = useRef<() => Promise<string | null>>(async () => null);
  const refreshInFlightRef = useRef<Promise<string | null> | null>(null);
  const refreshTokenRef = useRef<string | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefreshForToken = useCallback(
    (token: string) => {
      clearRefreshTimer();
      try {
        const payload = jwtDecode<{ exp?: number }>(token);
        if (!payload.exp) return;
        const ms = Math.max(0, payload.exp * 1000 - Date.now() - REFRESH_SKEW_MS);
        refreshTimerRef.current = setTimeout(() => {
          refreshSessionRef.current().catch(() => {});
        }, ms);
      } catch {
        // ignore parse errors
      }
    },
    [clearRefreshTimer]
  );

  const applyRefreshedSessionTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      const { accessToken, refreshToken } = tokens;
      const user = await getMe(accessToken);
      await Promise.all([
        AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken),
        AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken),
      ]);
      refreshTokenRef.current = refreshToken;
      setState((s) => ({
        ...s,
        accessToken,
        refreshToken,
        user,
        isLoading: false,
        authError: null,
      }));
      scheduleRefreshForToken(accessToken);
    },
    [scheduleRefreshForToken]
  );

  const refreshSession = useCallback(async (): Promise<string | null> => {
    const rt = refreshTokenRef.current;
    if (!rt) return null;
    if (!refreshInFlightRef.current) {
      refreshInFlightRef.current = (async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(`${getApiBaseUrl()}/v1/auth/refresh`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...ngrokSkipBrowserWarningHeaders(),
            },
            body: JSON.stringify({ refresh_token: rt }),
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const data = (await res.json()) as {
            access_token?: string;
            refresh_token?: string;
          };
          if (!data.access_token || !data.refresh_token) return null;
          await applyRefreshedSessionTokens({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
          });
          return data.access_token;
        } catch {
          return null;
        } finally {
          clearTimeout(timeoutId);
        }
      })().finally(() => {
        refreshInFlightRef.current = null;
      });
    }
    return refreshInFlightRef.current;
  }, [applyRefreshedSessionTokens]);

  useEffect(() => {
    refreshSessionRef.current = refreshSession;
  }, [refreshSession]);

  const evictStoredAuth = useCallback(async () => {
    await Promise.all([
      AsyncStorage.removeItem(ACCESS_TOKEN_KEY),
      AsyncStorage.removeItem(REFRESH_TOKEN_KEY),
    ]).catch(() => {});
    refreshTokenRef.current = null;
    clearRefreshTimer();
    setState((s) => ({
      ...s,
      accessToken: null,
      refreshToken: null,
      user: null,
      isLoading: false,
    }));
  }, [clearRefreshTimer]);

  const loadStoredAuth = useCallback(async () => {
    try {
      const storedRefreshToken = await AsyncStorage.getItem(REFRESH_TOKEN_KEY);
      if (!storedRefreshToken) {
        setState((s) => ({ ...s, isLoading: false, accessToken: null, refreshToken: null }));
        return;
      }
      refreshTokenRef.current = storedRefreshToken;
      const newAccess = await refreshSession();
      if (!newAccess) {
        await evictStoredAuth();
      }
    } catch {
      await evictStoredAuth();
    }
  }, [refreshSession, evictStoredAuth]);

  useEffect(() => {
    loadStoredAuth();
  }, [loadStoredAuth]);

  const setAuthFromTokens = useCallback(
    async (accessToken: string, refreshToken: string) => {
      try {
        const user = await getMe(accessToken);
        await Promise.all([
          AsyncStorage.setItem(ACCESS_TOKEN_KEY, accessToken),
          AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken),
        ]);
        refreshTokenRef.current = refreshToken;
        setState((s) => ({
          ...s,
          accessToken,
          refreshToken,
          user,
          isLoading: false,
          authError: null,
        }));
        scheduleRefreshForToken(accessToken);
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Account not found. Contact an admin for an invite.';
        if (message.includes('401') || message.includes('Account not found')) {
          setState((s) => ({
            ...s,
            accessToken: null,
            refreshToken: null,
            user: null,
            isLoading: false,
            authError: 'Account not found. Contact an admin for an invite.',
          }));
        } else {
          setState((s) => ({
            ...s,
            accessToken: null,
            refreshToken: null,
            user: null,
            isLoading: false,
            authError: message,
          }));
        }
      }
    },
    [scheduleRefreshForToken]
  );

  const signOut = useCallback(
    (authErrorMessage?: string | null) => {
      clearRefreshTimer();
      refreshTokenRef.current = null;
      Promise.all([
        AsyncStorage.removeItem(ACCESS_TOKEN_KEY),
        AsyncStorage.removeItem(REFRESH_TOKEN_KEY),
      ]).catch(() => {});
      setState((s) => ({
        ...s,
        accessToken: null,
        refreshToken: null,
        user: null,
        isLoading: false,
        authError: authErrorMessage !== undefined ? authErrorMessage : null,
      }));
    },
    [clearRefreshTimer]
  );

  const setAuthError = useCallback((message: string | null) => {
    setState((s) => ({ ...s, authError: message }));
  }, []);

  const clearAuthError = useCallback(() => {
    setState((s) => (s.authError ? { ...s, authError: null } : s));
  }, []);

  const refreshUser = useCallback((user: User) => {
    setState((s) => ({ ...s, user }));
  }, []);

  const value: AuthContextValue = {
    ...state,
    setAuthFromTokens,
    signOut,
    setAuthError,
    clearAuthError,
    refreshUser,
    refreshSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
