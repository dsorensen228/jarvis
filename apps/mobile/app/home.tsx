import { getMe } from '@/lib/api-client';
import { Redirect, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Header } from '../components/Header';
import { HomeShell } from '../components/HomeShell';
import { useAuth } from '../contexts/AuthContext';
import { SmartHomeProvider } from '../contexts/SmartHomeContext';
import { useTheme } from '../contexts/ThemeContext';

export default function HomeScreen() {
  const { accessToken, refreshUser } = useAuth();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ gmail?: string }>();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (params.gmail === 'connected' && accessToken) {
      getMe(accessToken).then(refreshUser).catch(() => {});
    }
  }, [params.gmail, accessToken, refreshUser]);

  if (!accessToken) {
    return <Redirect href="/login" />;
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header onJarvisPress={() => setDrawerOpen(true)} />
      <SmartHomeProvider>
        <HomeShell
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
        />
      </SmartHomeProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minWidth: 0,
  },
});
