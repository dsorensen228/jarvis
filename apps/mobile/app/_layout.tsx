import { GoogleOAuthProvider } from '@react-oauth/google';
import * as Notifications from 'expo-notifications';
import {
  setOnAuthFailure,
  setTokenProvider,
  setTokenRefresher,
} from '@/lib/api-client';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useTheme } from '../contexts/ThemeContext';

import { GmailNotificationBridge } from '../components/GmailNotificationBridge';
import { CameraPersonNotificationBridge } from '../components/CameraPersonNotificationBridge';
import { TaskNotificationBridge } from '../components/TaskNotificationBridge';
import { PushTokenBridge } from '../components/PushTokenBridge';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ConversationProvider } from '../contexts/ConversationContext';
import { TimerProvider } from '../contexts/TimerContext';
import { ThemeProvider } from '../contexts/ThemeContext';
import { getGoogleWebClientId } from '@/lib/runtimePublicEnv';

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
            {Platform.OS !== 'web' && (
              <>
                <GmailNotificationBridge />
                <CameraPersonNotificationBridge />
                <TaskNotificationBridge />
              </>
            )}
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
