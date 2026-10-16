import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';
import {
  buildCameraStreamPageUrl,
  createCameraStreamSession,
  fetchCameraSnapshotDataUri,
  getJarvisDevices,
} from '../../lib/api-client/client';
import type { CameraStreamSession, JarvisDevice } from '../../lib/api-client/types';

export type CamerasTabProps = {
  /** False when another home tab is selected — tears down MJPEG and session timers immediately. */
  active: boolean;
  /** Optional camera device id from a person-detected push tap. */
  focusDeviceId?: string | null;
  onFocusDeviceConsumed?: () => void;
};

function cameraStreamRefreshDelayMs(expiresInSec: number): number {
  const sec =
    typeof expiresInSec === 'number' && Number.isFinite(expiresInSec) && expiresInSec > 30
      ? expiresInSec
      : 900;
  return Math.min(Math.max(sec * 1000 - 120_000, 30_000), 14 * 60 * 1000);
}

const NATIVE_SNAPSHOT_MS = 450;

export function CamerasTab({ active, focusDeviceId, onFocusDeviceConsumed }: CamerasTabProps) {
  const { colors } = useTheme();
  const [devices, setDevices] = useState<JarvisDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<CameraStreamSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [nativeFrame, setNativeFrame] = useState<string | null>(null);
  const snapshotBusy = useRef(false);

  /** Drop stream session / frames so leaving the tab stops camera traffic. */
  const killCameraFeed = useCallback(() => {
    setSession(null);
    setNativeFrame(null);
    setStreamKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!active) {
      killCameraFeed();
    }
  }, [active, killCameraFeed]);

  const loadDevices = useCallback(async () => {
    setError(null);
    try {
      const rows = await getJarvisDevices();
      const cams = rows.filter((d) => d.device_type === 'camera');
      setDevices(cams);
      setSelectedId((prev) => {
        if (prev && cams.some((d) => d.id === prev)) return prev;
        return cams[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load cameras');
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadDevices();
  }, [active, loadDevices]);

  useEffect(() => {
    if (!active || !focusDeviceId) return;
    if (devices.some((d) => d.id === focusDeviceId)) {
      setSelectedId(focusDeviceId);
      onFocusDeviceConsumed?.();
    }
  }, [active, focusDeviceId, devices, onFocusDeviceConsumed]);
  const selected = devices.find((d) => d.id === selectedId) ?? null;

  const refreshSession = useCallback(async (): Promise<CameraStreamSession | null> => {
    if (!selectedId) {
      setSession(null);
      return null;
    }
    setSessionError(null);
    try {
      const s = await createCameraStreamSession(selectedId);
      setSession(s);
      setStreamKey((k) => k + 1);
      return s;
    } catch (e) {
      setSession(null);
      setSessionError(e instanceof Error ? e.message : 'Stream session failed');
      return null;
    }
  }, [selectedId]);

  /** Web keeps the multipart MJPEG session; native polls authenticated snapshots instead. */
  useEffect(() => {
    if (!active || !selectedId || Platform.OS !== 'web') {
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = (s: CameraStreamSession | null) => {
      if (cancelled) return;
      const delay = s ? cameraStreamRefreshDelayMs(s.expires_in) : 60_000;
      timeoutId = setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      if (cancelled) return;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const s = await refreshSession();
      scheduleNext(s);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [active, selectedId, refreshSession]);

  useEffect(() => {
    if (!active || !selectedId || Platform.OS === 'web') {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled || snapshotBusy.current) {
        timer = setTimeout(() => void tick(), NATIVE_SNAPSHOT_MS);
        return;
      }
      snapshotBusy.current = true;
      try {
        const uri = await fetchCameraSnapshotDataUri(selectedId);
        if (!cancelled) {
          setNativeFrame(uri);
          setSessionError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSessionError(e instanceof Error ? e.message : 'Snapshot failed');
        }
      } finally {
        snapshotBusy.current = false;
        if (!cancelled) {
          timer = setTimeout(() => void tick(), NATIVE_SNAPSHOT_MS);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, selectedId]);

  const streamUrl =
    Platform.OS === 'web' && active && session && selectedId
      ? buildCameraStreamPageUrl(selectedId, session.camera_token)
      : null;

  if (!active) {
    return null;
  }

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (devices.length === 0) {
    return (
      <ScrollView
        style={[styles.fill, { backgroundColor: colors.background }]}
        contentContainerStyle={styles.emptyPad}
      >
        <Text style={[styles.title, { color: colors.text }]}>Cameras</Text>
        <Text style={[styles.note, { color: colors.textMuted }]}>
          No camera-type Jarvis devices yet. Add one under Settings → Jarvis Devices (device type
          Camera), set the Pi’s LAN address (mDNS hostname) and callback secret to match the device,
          then return here.
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={[styles.fill, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, { color: colors.text }]}>Cameras</Text>
      {error ? (
        <Text style={[styles.warn, { color: colors.error }]}>{error}</Text>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
        {devices.map((d) => {
          const on = d.id === selectedId;
          return (
            <TouchableOpacity
              key={d.id}
              style={[
                styles.chip,
                {
                  borderColor: colors.border,
                  backgroundColor: on ? `${colors.accent}22` : colors.surface,
                },
              ]}
              onPress={() => setSelectedId(d.id)}
            >
              <Text style={{ color: on ? colors.accent : colors.text, fontWeight: '600' }}>
                {d.device_name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {selected ? (
        <Text style={[styles.meta, { color: colors.textMuted }]} numberOfLines={2}>
          {selected.room ? `${selected.room} · ` : ''}
          {Platform.OS === 'web'
            ? 'Live MJPEG via API (JWT refresh before expiry).'
            : 'Live snapshots via API (Android-safe; MJPEG WebView is unreliable).'}
        </Text>
      ) : null}

      {sessionError ? (
        <View style={[styles.banner, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text style={{ color: colors.error, flex: 1 }}>{sessionError}</Text>
          <TouchableOpacity
            onPress={() =>
              void (Platform.OS === 'web'
                ? refreshSession()
                : selectedId
                  ? fetchCameraSnapshotDataUri(selectedId).then(setNativeFrame)
                  : Promise.resolve())
            }
            style={styles.retryBtn}
          >
            <Text style={{ color: colors.accent, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={[styles.videoCard, { borderColor: colors.border, backgroundColor: '#0a0a0a' }]}>
        {Platform.OS === 'web' ? (
          !streamUrl ? (
            <View style={styles.videoInner}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            React.createElement('img', {
              key: streamKey,
              src: streamUrl,
              alt: '',
              style: {
                maxWidth: '100%',
                maxHeight: 520,
                width: 'auto',
                height: 'auto',
                objectFit: 'contain',
                objectPosition: 'center',
                display: 'block',
              },
            })
          )
        ) : !nativeFrame ? (
          <View style={styles.videoInner}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <Image source={{ uri: nativeFrame }} style={styles.nativeImage} resizeMode="contain" />
        )}
      </View>

      <TouchableOpacity
        style={[styles.refreshRow, { borderColor: colors.border }]}
        onPress={() => void loadDevices()}
      >
        <Ionicons name="refresh-outline" size={20} color={colors.accent} />
        <Text style={{ color: colors.accent, marginLeft: 8 }}>Refresh device list</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 32, gap: 14 },
  emptyPad: { padding: 20, paddingTop: 24 },
  title: { fontSize: 22, fontWeight: '800' },
  note: { fontSize: 15, lineHeight: 22, marginTop: 8 },
  warn: { fontSize: 14 },
  meta: { fontSize: 13 },
  chips: { flexGrow: 0, marginVertical: 4 },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  videoCard: {
    borderWidth: 1,
    borderRadius: 16,
    overflow: 'hidden',
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoInner: {
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeImage: { width: '100%', minHeight: 240, height: 320, backgroundColor: '#000' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  retryBtn: { padding: 8 },
  refreshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
});
