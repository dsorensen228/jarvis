import { GoogleOAuthProvider } from '@react-oauth/google';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import {
  registerPushToken,
  setOnAuthFailure,
  setTokenProvider,
  setTokenRefresher,
  unregisterPushToken,
} from '@/lib/api-client';
import { registerAndroidTimerNotificationEvents } from '@/lib/androidTimerNotifee';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { useTheme } from '../contexts/ThemeContext';

import { GmailNotificationBridge } from '../components/GmailNotificationBridge';
import { CameraPersonNotificationBridge } from '../components/CameraPersonNotificationBridge';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ConversationProvider } from '../contexts/ConversationContext';
import { TimerProvider } from '../contexts/TimerContext';
import { ThemeProvider } from '../contexts/ThemeContext';
import { getGoogleWebClientId } from '@/lib/runtimePublicEnv';

registerAndroidTimerNotificationEvents();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const GOOGLE_CLIENT_ID = getGoogleWebClientId();

function TokenProvider() {
  const { accessToken } = useAuth();
  useEffect(() => {
    setTokenProvider(() => accessToken);
    return () => setTokenProvider(null);
  }, [accessToken]);
  return null;
}

function TokenRefresherBridge() {
  const { refreshSession } = useAuth();
  useEffect(() => {
    setTokenRefresher(() => refreshSession());
    return () => setTokenRefresher(null);
  }, [refreshSession]);
  return null;
}

function PushTokenBridge() {
  const { accessToken } = useAuth();
  const tokenRef = useRef<string | null>(null);
  const prevAccessTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (accessToken) {
      prevAccessTokenRef.current = accessToken;
    }
  }, [accessToken]);

  useEffect(() => {
    let cancelled = false;

    async function syncPushToken() {
      if (Platform.OS === 'web') return;

      if (!accessToken) {
        const priorToken = tokenRef.current;
        const priorAccess = prevAccessTokenRef.current;
        tokenRef.current = null;
        if (priorToken && priorAccess) {
          unregisterPushToken({ token: priorToken, provider: 'expo' }, priorAccess).catch(
            () => {}
          );
        }
        return;
      }

      try {
        const perm = await Notifications.getPermissionsAsync();
        let status = perm.status;
        if (status !== 'granted') {
          const requested = await Notifications.requestPermissionsAsync();
          status = requested.status;
        }
        if (status !== 'granted' || cancelled) return;

        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
        const pushToken = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined
        );
        if (cancelled) return;
        const token = pushToken.data;
        if (!token) return;

        await registerPushToken({
          token,
          provider: 'expo',
          platform: Platform.OS,
          device_id: Constants.deviceName || undefined,
        });
        tokenRef.current = token;
      } catch {
        // Best effort only.
      }
    }

    syncPushToken();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return null;
}

function AuthFailureBridge() {
  const { signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    setOnAuthFailure((message) => {
      signOut(message);
      router.replace('/login');
    });
    return () => setOnAuthFailure(null);
  }, [signOut, router]);

  return null;
}

function ThemeStatusBar() {
  const { colorScheme } = useTheme();
  return <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  const content = (
    <ThemeProvider>
      <AuthProvider>
        <TokenProvider />
        <TokenRefresherBridge />
        <PushTokenBridge />
        <AuthFailureBridge />
        <ThemeStatusBar />
        <TimerProvider>
          <ConversationProvider>
            <GmailNotificationBridge />
            <CameraPersonNotificationBridge />
            <Stack screenOptions={{ headerShown: false }} />
          </ConversationProvider>
        </TimerProvider>
      </AuthProvider>
    </ThemeProvider>
  );

  if (GOOGLE_CLIENT_ID && Platform.OS === 'web') {
    return <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>{content}</GoogleOAuthProvider>;
  }

  return content;
}
