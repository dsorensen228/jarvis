import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { AlertsTab } from './AlertsTab';
import { ConnectPrompt } from './ConnectPrompt';

export function GmailTabs() {
  const { user } = useAuth();
  const { colors } = useTheme();

  const enabled = user?.gmail_enabled ?? false;

  if (!enabled) {
    return <ConnectPrompt />;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <AlertsTab />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
});
