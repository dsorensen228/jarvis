import {
  commandSmartDevice,
  getJarvisDevices,
  getRoomDisplay,
  getSmartDevices,
  launchApp,
  pressRemoteKey,
  type RemoteKey,
  type SmartDevice,
} from '@/lib/api-client';
import { deviceHasCapability } from '@/components/smartHome/lightHelpers';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';

const DPAD_SIZE = 208;
const DPAD_BTN = 52;
const DPAD_OK = 58;

function hasMediaPlayer(device: SmartDevice): boolean {
  return device.components.some((component) => component.domain === 'media_player');
}

export function TvRemotePage() {
  const { colors } = useTheme();
  const [screens, setScreens] = useState<SmartDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [launchHint, setLaunchHint] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const [devices, jarvisDevices] = await Promise.all([
        getSmartDevices(),
        getJarvisDevices().catch(() => []),
      ]);
      const rows = devices.filter(hasMediaPlayer);
      setScreens(rows);
      // Which screen a room means is the server's decision, so the phone, the
      // touchscreen, and the agent all land on the same one.
      const rooms = jarvisDevices
        .filter((device) => device.device_type === 'voice_interface')
        .map((device) => (device.room || '').trim())
        .filter(Boolean);
      let preferred: string | null = null;
      for (const room of rooms) {
        const display = await getRoomDisplay(room).catch(() => null);
        if (display && rows.some((row) => row.id === display.id)) {
          preferred = display.id;
          break;
        }
      }
      setSelectedId((prev) => {
        if (prev && rows.some((row) => row.id === prev)) return prev;
        return preferred ?? rows[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load screens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => screens.find((screen) => screen.id === selectedId) ?? null,
    [screens, selectedId]
  );

  const run = async (label: string, work: () => Promise<unknown>) => {
    if (!selectedId) return;
    setPending(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setPending(null);
    }
  };

  const sendKey = (key: RemoteKey) => run(key, () => pressRemoteKey(selectedId!, key));

  const sendAction = (
    label: string,
    action: 'turn_on' | 'turn_off' | 'play' | 'pause' | 'mute' | 'unmute' | 'volume_up' | 'volume_down'
  ) => run(label, () => commandSmartDevice(selectedId!, { action }));

  const sendRemoteKey = (label: string, key: RemoteKey) =>
    run(label, () =>
      commandSmartDevice(selectedId!, { action: 'key', parameters: { key } })
    );

  const sendMuteToggle = () => {
    if (rokuStyleRemote) {
      return sendRemoteKey('mute', 'volume_mute');
    }
    return sendAction('mute', volumeMuted ? 'unmute' : 'mute');
  };

  const sendPlay = () => {
    if (rokuStyleRemote) {
      return sendRemoteKey('play', 'play');
    }
    return sendAction('play', 'play');
  };

  const sendPause = () => {
    if (rokuStyleRemote) {
      return sendRemoteKey('pause', 'play');
    }
    return sendAction('pause', 'pause');
  };

  const sendPower = () =>
    run('power', async () => {
      await commandSmartDevice(selectedId!, {
        action: selected?.power === true ? 'turn_off' : 'turn_on',
      });
      await load();
    });

  const sendLaunch = () => {
    const hint = launchHint.trim();
    if (!hint) return;
    return run('launch', async () => {
      await launchApp(selectedId!, { name: hint });
      setLaunchHint('');
    });
  };

  const busy = !!pending;
  const iconColor = colors.text;
  const labelMuted = colors.textMuted;
  const volumeMuted = selected?.components.find((c) => c.domain === 'media_player')?.muted === true;
  const rokuStyleRemote = deviceHasCapability(selected, 'remote_keys');
  const ringBorder = '#4a2d6e';
  const okBg = '#6b3d9e';

  const keyBtn = (
    name: React.ComponentProps<typeof Ionicons>['name'],
    key: RemoteKey,
    label: string
  ) => (
    <TouchableOpacity
      accessibilityLabel={label}
      style={[
        styles.iconCircle,
        { borderColor: colors.border, backgroundColor: colors.surface, opacity: pending === key ? 0.55 : 1 },
      ]}
      disabled={busy}
      onPress={() => void sendKey(key)}
    >
      <Ionicons name={name} size={24} color={iconColor} />
    </TouchableOpacity>
  );

  const actionBtn = (
    name: React.ComponentProps<typeof Ionicons>['name'],
    label: string,
    action: 'play' | 'pause' | 'mute' | 'volume_up' | 'volume_down'
  ) => (
    <TouchableOpacity
      accessibilityLabel={label}
      style={[
        styles.iconCircle,
        { borderColor: colors.border, backgroundColor: colors.surface, opacity: pending === label ? 0.55 : 1 },
      ]}
      disabled={busy}
      onPress={() => void sendAction(label, action)}
    >
      <Ionicons name={name} size={24} color={iconColor} />
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!screens.length) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background, padding: 24 }]}>
        <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
          No screens yet. Add one in Home Assistant, then open Home → Sync.
        </Text>
        <TouchableOpacity
          style={[styles.retryBtn, { backgroundColor: colors.accent, marginTop: 16 }]}
          onPress={() => void load()}
        >
          <Text style={styles.retryBtnText}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.scrollPad}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: colors.text }]}>Screens</Text>
      {error ? <Text style={[styles.err, { color: colors.error }]}>{error}</Text> : null}

      <Text style={[styles.label, { color: labelMuted }]}>Screen</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pickerRow}>
        {screens.map((screen) => {
          const on = screen.id === selectedId;
          return (
            <TouchableOpacity
              key={screen.id}
              style={[
                styles.tvChip,
                {
                  borderColor: on ? colors.accent : colors.border,
                  backgroundColor: on ? `${colors.accent}22` : colors.surface,
                },
              ]}
              onPress={() => setSelectedId(screen.id)}
            >
              <Text style={{ color: on ? colors.accent : colors.text }} numberOfLines={1}>
                {screen.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {selected ? (
        <Text style={[styles.subMeta, { color: labelMuted }]} numberOfLines={1}>
          {[
            selected.room,
            selected.available ? selected.components[0]?.app : 'Unavailable',
            selected.model,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}

      <View style={styles.remoteColumn}>
        <View style={styles.navRow}>
          {keyBtn('arrow-back-outline', 'back', 'Back')}
          {keyBtn('home-outline', 'home', 'Home')}
          <TouchableOpacity
            accessibilityLabel="Power"
            style={[
              styles.iconCircle,
              { borderColor: colors.border, backgroundColor: colors.surface, opacity: pending === 'power' ? 0.55 : 1 },
            ]}
            disabled={busy}
            onPress={() => void sendPower()}
          >
            <Ionicons name="power" size={26} color={iconColor} />
          </TouchableOpacity>
        </View>

        <View
          style={[
            styles.dpadRing,
            {
              width: DPAD_SIZE,
              height: DPAD_SIZE,
              borderRadius: DPAD_SIZE / 2,
              borderColor: ringBorder,
              backgroundColor: colors.surface,
            },
          ]}
        >
          <View style={styles.dpadRow}>
            <View style={{ width: DPAD_BTN, height: DPAD_BTN }} />
            <TouchableOpacity
              accessibilityLabel="Up"
              style={[
                styles.dpadArrow,
                { width: DPAD_BTN, height: DPAD_BTN, borderRadius: DPAD_BTN / 2, borderColor: colors.border },
              ]}
              disabled={busy}
              onPress={() => void sendKey('up')}
            >
              <Ionicons name="chevron-up" size={30} color={iconColor} />
            </TouchableOpacity>
            <View style={{ width: DPAD_BTN, height: DPAD_BTN }} />
          </View>
          <View style={styles.dpadRow}>
            <TouchableOpacity
              accessibilityLabel="Left"
              style={[
                styles.dpadArrow,
                { width: DPAD_BTN, height: DPAD_BTN, borderRadius: DPAD_BTN / 2, borderColor: colors.border },
              ]}
              disabled={busy}
              onPress={() => void sendKey('left')}
            >
              <Ionicons name="chevron-back" size={30} color={iconColor} />
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel="OK"
              style={[
                styles.dpadOk,
                {
                  width: DPAD_OK,
                  height: DPAD_OK,
                  borderRadius: DPAD_OK / 2,
                  backgroundColor: okBg,
                  borderColor: '#8b47c9',
                },
              ]}
              disabled={busy}
              onPress={() => void sendKey('select')}
            >
              <Text style={styles.dpadOkText}>OK</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel="Right"
              style={[
                styles.dpadArrow,
                { width: DPAD_BTN, height: DPAD_BTN, borderRadius: DPAD_BTN / 2, borderColor: colors.border },
              ]}
              disabled={busy}
              onPress={() => void sendKey('right')}
            >
              <Ionicons name="chevron-forward" size={30} color={iconColor} />
            </TouchableOpacity>
          </View>
          <View style={styles.dpadRow}>
            <View style={{ width: DPAD_BTN, height: DPAD_BTN }} />
            <TouchableOpacity
              accessibilityLabel="Down"
              style={[
                styles.dpadArrow,
                { width: DPAD_BTN, height: DPAD_BTN, borderRadius: DPAD_BTN / 2, borderColor: colors.border },
              ]}
              disabled={busy}
              onPress={() => void sendKey('down')}
            >
              <Ionicons name="chevron-down" size={30} color={iconColor} />
            </TouchableOpacity>
            <View style={{ width: DPAD_BTN, height: DPAD_BTN }} />
          </View>
        </View>

        <View style={styles.navRow}>
          {keyBtn('play-back-outline', 'rewind', 'Rewind')}
          <TouchableOpacity
            accessibilityLabel="Play"
            style={[
              styles.iconCircle,
              { borderColor: colors.border, backgroundColor: colors.surface, opacity: pending === 'play' ? 0.55 : 1 },
            ]}
            disabled={busy}
            onPress={() => void sendPlay()}
          >
            <Ionicons name="play-outline" size={24} color={iconColor} />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Pause"
            style={[
              styles.iconCircle,
              { borderColor: colors.border, backgroundColor: colors.surface, opacity: pending === 'pause' ? 0.55 : 1 },
            ]}
            disabled={busy}
            onPress={() => void sendPause()}
          >
            <Ionicons name="pause-outline" size={24} color={iconColor} />
          </TouchableOpacity>
          {keyBtn('play-forward-outline', 'fast_forward', 'Fast forward')}
        </View>

        <View style={styles.volRow}>
          <TouchableOpacity
            accessibilityLabel={volumeMuted ? 'Unmute' : 'Mute'}
            style={[
              styles.iconCircle,
              {
                borderColor: colors.border,
                backgroundColor: colors.surface,
                opacity: pending === 'mute' ? 0.55 : 1,
              },
            ]}
            disabled={busy}
            onPress={() => void sendMuteToggle()}
          >
            <Ionicons name="volume-mute-outline" size={24} color={iconColor} />
          </TouchableOpacity>
          {actionBtn('volume-low-outline', 'volume down', 'volume_down')}
          {actionBtn('volume-high-outline', 'volume up', 'volume_up')}
        </View>
      </View>

      <Text style={[styles.label, { color: labelMuted, marginTop: 22 }]}>Open app (name)</Text>
      <View style={styles.launchRow}>
        <TextInput
          value={launchHint}
          onChangeText={setLaunchHint}
          placeholder={selected?.components[0]?.apps?.slice(0, 2).join(', ') || 'Netflix, Hulu, …'}
          placeholderTextColor={labelMuted}
          style={[
            styles.launchInput,
            { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface },
          ]}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[
            styles.launchGo,
            { backgroundColor: colors.accent, opacity: pending === 'launch' ? 0.6 : 1 },
          ]}
          disabled={busy}
          onPress={() => void sendLaunch()}
        >
          <Text style={styles.launchGoText}>Go</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollPad: { padding: 16, paddingBottom: 32, alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 8, alignSelf: 'stretch' },
  label: { fontSize: 13, marginBottom: 6, alignSelf: 'stretch' },
  err: { marginBottom: 8, alignSelf: 'stretch' },
  pickerRow: { marginBottom: 8, maxHeight: 44, alignSelf: 'stretch' },
  tvChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginRight: 8,
    maxWidth: 220,
  },
  subMeta: { fontSize: 12, marginBottom: 18, alignSelf: 'stretch' },
  remoteColumn: {
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    gap: 16,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navRow: {
    flexDirection: 'row',
    gap: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  volRow: {
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dpadRing: {
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  dpadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dpadArrow: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dpadOk: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dpadOkText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  launchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch', maxWidth: 400 },
  launchInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  launchGo: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10 },
  launchGoText: { color: '#fff', fontWeight: '600' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  retryBtnText: { color: '#fff', fontWeight: '600' },
});
