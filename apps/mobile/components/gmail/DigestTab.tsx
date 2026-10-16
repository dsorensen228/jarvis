import { useGmailDigest } from '@/hooks/useGmailDigest';
import React from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';

export function DigestTab() {
  const { colors } = useTheme();
  const { summary, loading, error, refreshing, refresh } = useGmailDigest();

  const dynamicStyles = {
    container: { backgroundColor: colors.background },
    summary: { color: colors.text },
    emptyText: { color: colors.textMuted },
  };

  if (loading && !summary) {
    return (
      <View style={[styles.container, dynamicStyles.container, styles.center]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.loadingText, { color: colors.textMuted }]}>
          Loading digest...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, dynamicStyles.container]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={colors.accent}
        />
      }
    >
      {error && (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      )}
      {summary ? (
        <Text style={[styles.summary, dynamicStyles.summary]}>{summary}</Text>
      ) : (
        !error && (
          <Text style={[styles.emptyText, dynamicStyles.emptyText]}>
            No emails in the last 24 hours.
          </Text>
        )
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  error: {
    fontSize: 14,
    marginBottom: 16,
  },
  summary: {
    fontSize: 15,
    lineHeight: 22,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
});
