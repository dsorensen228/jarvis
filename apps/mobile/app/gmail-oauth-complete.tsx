import { JARVIS_GMAIL_OAUTH_MESSAGE_TYPE } from '@/lib/gmailOAuthMessage';
import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

/**
 * Gmail OAuth finishes here (popup). Notifies opener via postMessage and closes the window on web.
 */
export default function GmailOAuthCompleteScreen() {
  const params = useLocalSearchParams<{ status?: string; error?: string }>();

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const status = typeof params.status === 'string' ? params.status : undefined;
    const error = typeof params.error === 'string' ? params.error : undefined;
    const connected = status === 'connected';

    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(
          { type: JARVIS_GMAIL_OAUTH_MESSAGE_TYPE, connected, error },
          window.location.origin
        );
      }
    } finally {
      window.setTimeout(() => {
        try {
          window.close();
        } catch {
          /* ignore */
        }
      }, 100);
    }
  }, [params.status, params.error]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.text}>
        {Platform.OS === 'web'
          ? 'Finishing Gmail connection…'
          : 'Gmail connection updated. Return to Jarvis.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#000000',
  },
  text: {
    color: '#e4ddea',
    fontSize: 16,
    textAlign: 'center',
  },
});
