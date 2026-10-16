import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { getMe } from '@/lib/api-client';
import { registerHomeGoToCameras, registerHomeGoToChat } from '@/lib/homeNavigationBridge';

import { useAuth } from '../contexts/AuthContext';
import { formatTimerClock, useTimer } from '../contexts/TimerContext';
import { useTheme } from '../contexts/ThemeContext';
import { AvatarMenu } from './AvatarMenu';
import { GmailTabs as EmailTabs } from './gmail/GmailTabs';
import { CamerasTab } from './jarvis/CamerasTab';
import { ChatTab } from './jarvis/ChatTab';
import { ProjectsTab } from './jarvis/ProjectsTab';
import { ShoppingTab } from './jarvis/ShoppingTab';
import { TimersTab } from './jarvis/TimersTab';
import { TodosTab } from './jarvis/TodosTab';
import { HomeTab } from './jarvis/HomeTab';
import { SettingsPanel } from './SettingsPanel';
import { TvRemotePage } from './jarvis/TvRemotePage';
import { CodingTasksTab } from './jarvis/CodingTasksTab';

export type HomePage =
  | 'chat'
  | 'home'
  | 'projects'
  | 'todos'
  | 'shopping'
  | 'timers'
  | 'cameras'
  | 'tvs'
  | 'settings'
  | 'email'
  | 'code';

const NAV_ITEMS: {
  key: HomePage;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
  { key: 'chat', label: 'Chat', icon: 'chatbubble-outline' },
  { key: 'home', label: 'Home', icon: 'home-outline' },
  { key: 'projects', label: 'Projects', icon: 'briefcase-outline' },
  { key: 'todos', label: 'Todos', icon: 'checkbox-outline' },
  { key: 'shopping', label: 'Shopping lists', icon: 'cart-outline' },
  { key: 'timers', label: 'Timer', icon: 'timer-outline' },
  { key: 'cameras', label: 'Cameras', icon: 'videocam-outline' },
  { key: 'tvs', label: 'TVs', icon: 'tv-outline' },
  { key: 'code', label: 'Code Factory', icon: 'terminal-outline' },
  { key: 'email', label: 'Email & alerts', icon: 'mail-outline' },
];

type HomeShellProps = {
  drawerOpen: boolean;
  onCloseDrawer: () => void;
};

export function HomeShell({ drawerOpen, onCloseDrawer }: HomeShellProps) {
  const { colors } = useTheme();
  const { accessToken, refreshUser, user } = useAuth();
  const { width } = useWindowDimensions();
  const [page, setPage] = useState<HomePage>('chat');
  const [cameraFocusId, setCameraFocusId] = useState<string | null>(null);
  const {
    status,
    remainingMs,
    modalDismissed,
    dismissModal,
    dismissAlarm,
    handleTimerPageVisibility,
  } = useTimer();
  const drawerPinned = width >= 1180;
  const showTimerBubble =
    page !== 'timers' && status !== 'idle' && (!modalDismissed || status === 'alarming');

  useEffect(() => {
    handleTimerPageVisibility(page === 'timers');
  }, [page, handleTimerPageVisibility]);

  /** After Gmail OAuth (e.g. native browser), refresh profile when opening Email while still disconnected. */
  useEffect(() => {
    if (page !== 'email' || !accessToken || user?.gmail_enabled) return;
    getMe(accessToken).then(refreshUser).catch(() => {});
  }, [page, accessToken, user?.gmail_enabled, refreshUser]);

  const selectPage = useCallback(
    (key: HomePage) => {
      setPage(key);
      if (!drawerPinned) {
        onCloseDrawer();
      }
    },
    [drawerPinned, onCloseDrawer]
  );

  useEffect(() => {
    registerHomeGoToChat(() => selectPage('chat'));
    registerHomeGoToCameras((deviceId) => {
      if (deviceId) {
        setCameraFocusId(deviceId);
      }
      selectPage('cameras');
    });
    return () => {
      registerHomeGoToChat(null);
      registerHomeGoToCameras(null);
    };
  }, [selectPage]);

  const clearCameraFocus = useCallback(() => setCameraFocusId(null), []);

  const renderDrawerContent = () => (
    <View style={styles.drawerContent}>
      <ScrollView style={styles.drawerScroll}>
        {NAV_ITEMS.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={[
              styles.drawerRow,
              page === item.key && {
                backgroundColor: `${colors.accent}18`,
              },
            ]}
            onPress={() => selectPage(item.key)}
          >
            <Ionicons
              name={item.icon}
              size={22}
              color={page === item.key ? colors.accent : colors.textMuted}
            />
            <Text
              style={[
                styles.drawerLabel,
                {
                  color: page === item.key ? colors.accent : colors.text,
                },
              ]}
            >
              {item.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={[styles.drawerFooter, { borderTopColor: colors.border }]}>
        <AvatarMenu
          placement="drawer"
          onSettings={() => {
            selectPage('settings');
          }}
        />
      </View>
    </View>
  );

  return (
    <View
      style={[
        styles.fill,
        drawerPinned && styles.desktopLayout,
        { backgroundColor: colors.background },
      ]}
    >
      {drawerPinned && (
        <View
          style={[
            styles.desktopDrawer,
            {
              backgroundColor: colors.surface,
              borderRightColor: colors.border,
            },
          ]}
        >
          {renderDrawerContent()}
        </View>
      )}
      <View style={[styles.fill, styles.mainColumn, drawerPinned && styles.desktopContent]}>
        <View style={styles.pageRail}>
          {page === 'chat' && <ChatTab />}
          {page === 'home' && <HomeTab />}
          {page === 'projects' && <ProjectsTab />}
          {page === 'todos' && <TodosTab />}
          {page === 'shopping' && <ShoppingTab />}
          {page === 'timers' && <TimersTab />}
          <CamerasTab
            active={page === 'cameras'}
            focusDeviceId={cameraFocusId}
            onFocusDeviceConsumed={clearCameraFocus}
          />
          {page === 'tvs' && <TvRemotePage />}
          {page === 'code' && <CodingTasksTab />}
          {page === 'settings' && <SettingsPanel />}
          {page === 'email' && <EmailTabs />}
        </View>
      </View>

      {showTimerBubble && (
        <View
          style={[
            styles.timerBubble,
            {
              backgroundColor: colors.surface,
              borderColor: status === 'alarming' ? colors.accent : colors.border,
            },
          ]}
        >
          <TouchableOpacity
            style={styles.timerBubbleBody}
            onPress={() => selectPage('timers')}
            activeOpacity={0.9}
          >
            <View style={styles.timerBubbleHeader}>
              <Text style={[styles.timerBubbleLabel, { color: colors.textMuted }]}>
                {status === 'alarming' ? 'Timer finished' : 'Timer'}
              </Text>
              <TouchableOpacity
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                onPress={dismissModal}
              >
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.timerBubbleClock, { color: colors.text }]}>
              {status === 'alarming' ? '00:00' : formatTimerClock(remainingMs)}
            </Text>
            <Text style={[styles.timerBubbleHint, { color: colors.textMuted }]}>
              {status === 'alarming'
                ? 'Alarm sounding'
                : 'Tap to return to the timer'}
            </Text>
          </TouchableOpacity>
          {status === 'alarming' && (
            <TouchableOpacity
              style={[styles.timerBubbleAction, { backgroundColor: colors.accent }]}
              onPress={dismissAlarm}
            >
              <Text style={styles.timerBubbleActionText}>Dismiss alarm</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Modal
        visible={drawerOpen}
        transparent
        animationType="fade"
        onRequestClose={onCloseDrawer}
      >
        <Pressable style={styles.backdrop} onPress={onCloseDrawer}>
          <Pressable
            style={[styles.drawer, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            {renderDrawerContent()}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  /** Lets flex children shrink on web instead of forcing horizontal overflow */
  mainColumn: { minWidth: 0 },
  desktopLayout: {
    flexDirection: 'row',
  },
  desktopDrawer: {
    width: 280,
    borderRightWidth: 1,
    paddingTop: 16,
    paddingBottom: 16,
  },
  desktopContent: {
    minWidth: 0,
  },
  pageRail: {
    flex: 1,
    width: '100%',
    maxWidth: 880,
    minWidth: 0,
    alignSelf: 'center',
  },
  drawerContent: {
    flex: 1,
  },
  timerBubble: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 200,
    borderWidth: 1,
    borderRadius: 18,
    padding: 12,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  timerBubbleBody: {
    gap: 6,
  },
  timerBubbleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  timerBubbleLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  timerBubbleClock: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -1,
  },
  timerBubbleHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  timerBubbleAction: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  timerBubbleActionText: {
    color: '#f2ebff',
    fontSize: 13,
    fontWeight: '700',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    flexDirection: 'row',
  },
  drawer: {
    marginTop: 56,
    marginBottom: 56,
    marginLeft: 0,
    width: '78%',
    maxWidth: 320,
    borderTopRightRadius: 12,
    borderBottomRightRadius: 12,
    paddingVertical: 12,
    elevation: 8,
  },
  drawerScroll: { maxHeight: '100%' },
  drawerFooter: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 10,
    borderTopWidth: 1,
    alignItems: 'flex-start',
  },
  drawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  drawerLabel: { fontSize: 16 },
});
