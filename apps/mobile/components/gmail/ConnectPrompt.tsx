import { getGmailConnect, getMe } from '@/lib/api-client';
import { isJarvisGmailOAuthMessage } from '@/lib/gmailOAuthMessage';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';

function gmailErrorMessage(code: string): string {
  switch (code) {
    case 'no_refresh_token':
      return 'Google did not return a refresh token. Revoke Jarvis access in your Google account and try again.';
    case 'token_exchange_failed':
      return 'Could not exchange the authorization code. Check API OAuth configuration.';
    case 'invalid_state':
      return 'This sign-in link expired or was already used. Try Connect again.';
    case 'missing_params':
      return 'OAuth callback was missing parameters.';
    default:
      return `Gmail connect failed (${code}). Try again.`;
  }
}

function openGmailOAuthPopup(authUrl: string): Window | null {
  if (typeof window === 'undefined') return null;
  const w = 520;
  const h = 720;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const features = `scrollbars=yes,resizable=yes,width=${w},height=${h},top=${top},left=${left}`;
  return window.open(authUrl, 'jarvis_gmail_oauth', features);
}

export function ConnectPrompt() {
  const { colors } = useTheme();
  const { accessToken, refreshUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyOAuthResult = useCallback(
    (connected: boolean, errCode?: string) => {
      if (errCode) {
        setError(gmailErrorMessage(errCode));
        return;
      }
      if (!connected || !accessToken) return;
      void getMe(accessToken)
        .then(refreshUser)
        .catch(() => setError('Connected, but could not refresh your profile. Reload the app.'));
    },
    [accessToken, refreshUser]
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if (!isJarvisGmailOAuthMessage(ev.data)) return;
      applyOAuthResult(Boolean(ev.data.connected), ev.data.error);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [applyOAuthResult]);

  const handleConnect = async () => {
    try {
      setLoading(true);
      setError(null);
      const { auth_url } = await getGmailConnect();

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        const popup = openGmailOAuthPopup(auth_url);
        if (!popup) {
          setError('Popup was blocked. Allow popups for this site, or try again.');
          return;
        }
        popup.focus();
        return;
      }

      const opened = await Linking.openURL(auth_url);
      if (!opened) {
        setError('Could not open Gmail sign-in. Try again.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start connect flow');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.message, { color: colors.text }]}>
        Gmail integration is not enabled for this account yet
      </Text>
      <Text style={[styles.subtext, { color: colors.textMuted }]}>
        Connect your Gmail to get email digests and actionable alerts.
      </Text>
      {error && (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      )}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.accent }]}
        onPress={handleConnect}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Ionicons name="mail-outline" size={22} color="#fff" />
            <Text style={styles.buttonText}>Connect to Gmail</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  message: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtext: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  error: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
