import { GoogleLogin } from '@react-oauth/google';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { useAuth } from '@/contexts/AuthContext';
import { mission_tagline } from '@/lib/identity';
import {
  getApiBaseUrl,
  getGoogleWebClientId,
  ngrokSkipBrowserWarningHeaders,
} from '@/lib/runtimePublicEnv';
import { useTheme } from '@/contexts/ThemeContext';

const WEB_CLIENT_ID = getGoogleWebClientId();
const IS_WEB = Platform.OS === 'web';
const LOGO_SIZE = 360;

function BrandedLogo({ size }: { size: number }) {
  return (
    <View style={[styles.logoCircle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Image
        source={require('../assets/logo_transparent.png')}
        style={{ width: size * 0.74, height: size * 0.74 }}
        resizeMode="contain"
      />
    </View>
  );
}

export default function LoginScreen() {
  const { width } = useWindowDimensions();
  const { accessToken, authError, setAuthFromTokens, clearAuthError, setAuthError } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const logoSize = Math.round(Math.min(Math.max(width * 0.5, 120), LOGO_SIZE));

  useEffect(() => {
    if (accessToken) {
      clearAuthError();
      router.replace('/home');
    }
  }, [accessToken, clearAuthError, router]);

  useEffect(() => {
    if (!IS_WEB && WEB_CLIENT_ID) {
      try {
        const { GoogleSignin } = require('@react-native-google-signin/google-signin');
        GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });
      } catch (error) {
        console.warn('Google Sign-In configure failed:', error);
      }
    }
  }, []);

  const exchangeGoogleToken = async (googleIdToken: string) => {
    const response = await fetch(`${getApiBaseUrl()}/v1/auth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...ngrokSkipBrowserWarningHeaders(),
      },
      body: JSON.stringify({ google_id_token: googleIdToken }),
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body || `Sign-in failed (${response.status})`;
      try {
        const parsed = JSON.parse(body) as { detail?: unknown };
        if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
          message = parsed.detail;
        }
      } catch {
        // keep raw body
      }
      throw new Error(message);
    }
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };
    await setAuthFromTokens(tokens.access_token, tokens.refresh_token);
  };

  const handleNativeSignIn = async () => {
    if (!WEB_CLIENT_ID || working) return;
    setWorking(true);
    clearAuthError();
    try {
      const { GoogleSignin } = require('@react-native-google-signin/google-signin');
      const result = await GoogleSignin.signIn();
      if (result.type !== 'success' || !result.data?.idToken) {
        throw new Error('Google did not return an identity token');
      }
      await exchangeGoogleToken(result.data.idToken);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Google sign-in failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <BrandedLogo size={logoSize} />
      <Text style={[styles.title, { color: colors.text }]}>Jarvis</Text>
      <Text style={[styles.tagline, { color: colors.textMuted }]}>{mission_tagline}</Text>
      {!WEB_CLIENT_ID ? (
        <Text style={[styles.error, { color: colors.error }]}>Google sign-in is not configured.</Text>
      ) : null}
      {authError ? <Text style={[styles.error, { color: colors.error }]}>{authError}</Text> : null}
      {WEB_CLIENT_ID && IS_WEB ? (
        <View style={styles.buttonWrap}>
          <GoogleLogin
            onSuccess={(credentialResponse) => {
              if (!credentialResponse.credential || working) return;
              setWorking(true);
              clearAuthError();
              exchangeGoogleToken(credentialResponse.credential)
                .catch((error) => {
                  setAuthError(error instanceof Error ? error.message : 'Google sign-in failed');
                })
                .finally(() => setWorking(false));
            }}
            onError={() => setAuthError('Google sign-in failed')}
            useOneTap={false}
          />
        </View>
      ) : null}
      {WEB_CLIENT_ID && !IS_WEB ? (
        <Pressable
          onPress={() => void handleNativeSignIn()}
          disabled={working}
          style={[styles.button, { backgroundColor: colors.accent, opacity: working ? 0.65 : 1 }]}
        >
          {working ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Sign in with Google</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  logoCircle: { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: 'bold', marginTop: 16 },
  tagline: { fontSize: 14, marginBottom: 28, textAlign: 'center' },
  buttonWrap: { minHeight: 48 },
  button: {
    width: '100%',
    maxWidth: 400,
    minHeight: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { textAlign: 'center', marginBottom: 16 },
});
