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

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getMe } from '@/lib/api-client';
import { formatTimerFinish } from '@/lib/timerFormat';
import { registerHomeGoToCameras, registerHomeGoToChat, registerHomeGoToTv, registerHomeGoToTask } from '@/lib/homeNavigationBridge';

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
import { ResearchTab } from './jarvis/ResearchTab';

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
  | 'code'
  | 'research';

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
  { key: 'research', label: 'Research', icon: 'search-outline' },
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
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<HomePage>('chat');
  const [cameraFocusId, setCameraFocusId] = useState<string | null>(null);
  const [codeFocusId, setCodeFocusId] = useState<string | null>(null);
  const [researchFocusId, setResearchFocusId] = useState<string | null>(null);
  const [tvFocusId, setTvFocusId] = useState<string | null>(null);
  const {
    status,
    remainingMs,
    label: timerLabel,
    endAtMs,
    silenced,
    pauseTimer,
    resumeTimer,
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
    registerHomeGoToTv((deviceId) => {
      setTvFocusId(deviceId);
      selectPage('tvs');
    });
    registerHomeGoToTask((kind, taskId) => {
      if (kind === 'code') setCodeFocusId(taskId);
      else setResearchFocusId(taskId);
      selectPage(kind);
    });
    return () => {
      registerHomeGoToTask(null);
      registerHomeGoToTv(null);
      registerHomeGoToChat(null);
      registerHomeGoToCameras(null);
    };
  }, [selectPage]);

  const clearCodeFocus = useCallback(() => setCodeFocusId(null), []);
  const clearResearchFocus = useCallback(() => setResearchFocusId(null), []);
  const clearCameraFocus = useCallback(() => setCameraFocusId(null), []);

  const renderNavItem = (item: typeof NAV_ITEMS[number]) => (
    <Pressable
      key={item.key}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: page === item.key }}
      aria-selected={page === item.key}
      onPress={() => selectPage(item.key)}
      style={({ pressed, hovered }: any) => [
        styles.drawerRow,
        { backgroundColor: page === item.key ? `${colors.accent}24` : pressed || hovered ? colors.surfaceElevated : 'transparent' },
      ]}
    >
      <Ionicons name={item.icon} size={20} color={page === item.key ? colors.accentMuted : colors.textMuted} />
      <Text style={[styles.drawerLabel, { color: page === item.key ? colors.accentMuted : colors.text }]}>{item.label}</Text>
      {page === item.key && <View style={[styles.activeDot, { backgroundColor: colors.accentMuted }]} />}
    </Pressable>
  );

  const renderDrawerContent = () => (
    <View style={styles.drawerContent}>
      <View style={styles.drawerHeading}>
        <Text accessibilityRole="header" style={[styles.drawerTitle, { color: colors.text }]}>Workspace</Text>
        {!drawerPinned && <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onCloseDrawer} style={styles.closeButton}>
          <Ionicons name="close" size={22} color={colors.textMuted} />
        </Pressable>}
      </View>
      <ScrollView style={styles.drawerScroll} contentContainerStyle={styles.drawerScrollContent} showsVerticalScrollIndicator={false}>
        {[
          { title: 'Assistant', keys: ['chat', 'research', 'code', 'email'] },
          { title: 'Organize', keys: ['projects', 'todos', 'shopping', 'timers'] },
          { title: 'Your home', keys: ['home', 'cameras', 'tvs'] },
        ].map(group => <View key={group.title} style={styles.navGroup}>
          <Text style={[styles.groupLabel, { color: colors.textMuted }]}>{group.title}</Text>
          {group.keys.map(key => renderNavItem(NAV_ITEMS.find(item => item.key === key)!))}
        </View>)}
      </ScrollView>
      <View style={[styles.drawerFooter, { borderTopColor: colors.border }]}>
        {renderNavItem({ key: 'settings', label: 'Settings', icon: 'settings-outline' })}
        <View style={styles.accountRow}>
          <AvatarMenu placement="drawer" onSettings={() => selectPage('settings')} />
          <View style={styles.accountDetails}>
            <Text numberOfLines={1} style={[styles.accountName, { color: colors.text }]}>{user?.name || 'Account'}</Text>
            <Text numberOfLines={1} style={[styles.accountEmail, { color: colors.textMuted }]}>{user?.email || 'Account menu'}</Text>
          </View>
        </View>
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
          testID="navigation-panel"
          style={[
            styles.desktopDrawer,
            {
              backgroundColor: colors.background,
              borderRightColor: colors.border,
            },
          ]}
        >
          {renderDrawerContent()}
        </View>
      )}
      <View style={[styles.fill, styles.mainColumn, drawerPinned && styles.desktopContent]}>
        {showTimerBubble && <View style={[styles.timerBubble, { backgroundColor: colors.surfaceElevated, borderColor: status === 'alarming' ? colors.accent : colors.border }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open timer" style={styles.timerBubbleBody} onPress={() => selectPage('timers')}>
            <Ionicons name={status === 'alarming' ? 'notifications-outline' : 'timer-outline'} size={22} color={colors.accentMuted} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={[styles.timerBubbleLabel, { color: colors.text }]}>{timerLabel || 'Timer'}</Text>
              <Text style={[styles.timerBubbleHint, { color: colors.textMuted }]}>{status === 'alarming' ? silenced ? 'Finished · sound stopped' : 'Time’s up' : status === 'paused' ? 'Paused' : endAtMs ? `Until ${formatTimerFinish(endAtMs)}` : 'Running'}</Text>
            </View>
            <Text style={[styles.timerBubbleClock, { color: colors.text }]}>{formatTimerClock(remainingMs)}</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={status === 'alarming' ? 'Dismiss finished timer' : status === 'paused' ? 'Resume timer' : 'Pause timer'}
            onPress={status === 'alarming' ? dismissAlarm : status === 'paused' ? resumeTimer : pauseTimer} style={styles.timerBubbleAction}>
            <Ionicons name={status === 'alarming' ? 'checkmark' : status === 'paused' ? 'play' : 'pause'} size={22} color={colors.accentMuted} />
          </TouchableOpacity>
          {status !== 'alarming' && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Hide timer banner" onPress={dismissModal} style={styles.timerBubbleAction}><Ionicons name="close" size={18} color={colors.textMuted} /></TouchableOpacity>}
        </View>}
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
          {page === 'tvs' && <TvRemotePage focusDeviceId={tvFocusId} />}
          {page === 'code' && <CodingTasksTab focusTaskId={codeFocusId} onFocusConsumed={clearCodeFocus} />}
          {page === 'research' && <ResearchTab focusTaskId={researchFocusId} onFocusConsumed={clearResearchFocus} />}
          {page === 'settings' && <SettingsPanel />}
          {page === 'email' && <EmailTabs />}
        </View>
      </View>


      <Modal
        visible={drawerOpen && !drawerPinned}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={onCloseDrawer}
      >
        <Pressable style={styles.backdrop} onPress={onCloseDrawer}>
          <Pressable
            testID="navigation-panel"
            style={[styles.drawer, { backgroundColor: colors.background, borderRightColor: colors.border, paddingTop: insets.top, paddingBottom: insets.bottom }]}
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
  fill: { flex: 1, minHeight: 0 },
  /** Lets flex children shrink on web instead of forcing horizontal overflow */
  mainColumn: { minWidth: 0 },
  desktopLayout: {
    flexDirection: 'row',
  },
  desktopDrawer: {
    width: 264,
    alignSelf: 'stretch',
    minHeight: 0,
    borderRightWidth: 1,

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
  drawerContent: { flex: 1, minHeight: 0 },
  drawerHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 24, paddingRight: 12, minHeight: 64 },
  drawerTitle: { fontSize: 17, fontWeight: '700' },
  closeButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  navGroup: { gap: 3, marginBottom: 20 },
  groupLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', paddingHorizontal: 12, marginBottom: 6 },
  activeDot: { width: 5, height: 5, borderRadius: 3, marginLeft: 'auto' },
  drawerScrollContent: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  accountDetails: { flex: 1, minWidth: 0, gap: 3 },
  accountName: { fontSize: 14, fontWeight: '600' },
  accountEmail: { fontSize: 12 },
  timerBubble: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 16, margin: 12, marginBottom: 0, paddingLeft: 12, paddingRight: 4, minHeight: 68, gap: 2 },
  timerBubbleBody: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  timerBubbleLabel: { fontSize: 13, fontWeight: '700' },
  timerBubbleClock: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  timerBubbleHint: { fontSize: 11, marginTop: 3 },
  timerBubbleAction: { width: 40, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    flexDirection: 'row',
  },
  drawer: {
    alignSelf: 'stretch',
    width: '86%',
    maxWidth: 320,
    borderRightWidth: 1,
    elevation: 8,
  },
  drawerScroll: { flex: 1, minHeight: 0 },
  drawerFooter: { padding: 12, borderTopWidth: 1, flexShrink: 0 },
  drawerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    minHeight: 46, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
  },
  drawerLabel: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
});
