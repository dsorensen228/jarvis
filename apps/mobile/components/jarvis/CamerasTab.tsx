import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';
import { buildCameraStreamPageUrl, createCameraStreamSession, fetchCameraSnapshotDataUri, getJarvisDevices } from '../../lib/api-client/client';
import type { CameraStreamSession, JarvisDevice } from '../../lib/api-client/types';
import { pollCamera } from '../../lib/cameraFeed';

export type CamerasTabProps = {
  active: boolean;
  focusDeviceId?: string | null;
  onFocusDeviceConsumed?: () => void;
};

function cameraStreamRefreshDelayMs(expiresInSec: number): number {
  const sec = Number.isFinite(expiresInSec) && expiresInSec > 30 ? expiresInSec : 900;
  return Math.min(Math.max(sec * 1000 - 120_000, 30_000), 14 * 60 * 1000);
}

/** Keyed by camera and retry so old requests can never populate a new selection. */
function CameraFeed({ device, onRetry }: { device: JarvisDevice; onRetry: () => void }) {
  const { colors } = useTheme();
  const [session, setSession] = useState<CameraStreamSession | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return pollCamera(
        () => createCameraStreamSession(device.id),
        value => { setSession(value); setFailed(false); },
        () => setFailed(true),
        value => cameraStreamRefreshDelayMs(value.expires_in),
      );
    }
    return pollCamera(
      () => fetchCameraSnapshotDataUri(device.id),
      value => { setFrame(value); setFailed(false); },
      () => setFailed(true),
      () => 450,
    );
  }, [device.id]);

  const url = session ? buildCameraStreamPageUrl(device.id, session.camera_token) : null;
  const hasFrame = Platform.OS === 'web' ? Boolean(url) : Boolean(frame);
  const label = device.device_name || device.id;
  return (
    <View style={[styles.videoCard, { borderColor: colors.border }]}>
      <View style={[styles.imageArea, failed && styles.staleFrame]}>
        {Platform.OS === 'web' ? url && React.createElement('img', {
          key: url, src: url, alt: label,
          onError: () => setFailed(true),
          style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
        }) : frame && <Image source={{ uri: frame }} style={styles.imageArea} resizeMode="contain" accessibilityLabel={label} onError={() => setFailed(true)} />}
      </View>
      {failed ? (
        <View style={styles.feedStatus} accessibilityLiveRegion="polite">
          <Text style={styles.feedText}>Camera unavailable</Text>
          {frame && <Text style={styles.feedText}>Last frame</Text>}
          <TouchableOpacity accessibilityRole="button" onPress={onRetry} style={styles.feedRetry}>
            <Text style={styles.feedText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !hasFrame ? (
        <View style={styles.feedStatus}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.feedText}>Connecting…</Text>
        </View>
      ) : null}
    </View>
  );
}

export function CamerasTab({ active, focusDeviceId, onFocusDeviceConsumed }: CamerasTabProps) {
  const { colors } = useTheme();
  const [devices, setDevices] = useState<JarvisDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [feedRevision, setFeedRevision] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    void getJarvisDevices().then(rows => {
      if (cancelled) return;
      const cams = rows.filter(d => d.device_type === 'camera');
      setDevices(cams);
      setSelectedId(previous => cams.some(d => d.id === previous) ? previous : cams[0]?.id ?? null);
    }).catch(() => {
      if (!cancelled) setError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, listRevision]);

  useEffect(() => {
    if (active && focusDeviceId && devices.some(d => d.id === focusDeviceId)) {
      setSelectedId(focusDeviceId);
      onFocusDeviceConsumed?.();
    }
  }, [active, focusDeviceId, devices, onFocusDeviceConsumed]);

  if (!active) return null;
  const selected = devices.find(d => d.id === selectedId);
  return (
    <ScrollView style={[styles.fill, { backgroundColor: colors.background }]} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Cameras</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh cameras" disabled={loading}
          onPress={() => setListRevision(v => v + 1)} style={styles.refresh}>
          {loading ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="refresh-outline" size={22} color={colors.accent} />}
        </TouchableOpacity>
      </View>
      {error ? (
        <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityLiveRegion="polite">
          <Text style={{ color: colors.error, flex: 1 }}>Could not load cameras</Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => setListRevision(v => v + 1)} style={styles.refresh}>
            <Text style={{ color: colors.accent, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {!devices.length && !error && <Text style={{ color: colors.textMuted }}>{loading ? 'Loading cameras…' : 'No cameras'}</Text>}
      {devices.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={true} style={styles.chips} contentContainerStyle={styles.chipRow}>
          {devices.map(device => {
            const on = device.id === selectedId;
            return (
              <TouchableOpacity key={device.id} accessibilityRole="tab" accessibilityState={{ selected: on }} aria-selected={on}
                style={[styles.chip, { borderColor: on ? colors.accent : colors.border, backgroundColor: on ? `${colors.accent}22` : colors.surface }]}
                onPress={() => setSelectedId(device.id)}>
                <Text numberOfLines={1} style={{ color: on ? colors.accent : colors.text, fontWeight: '600' }}>{device.device_name || device.id}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
      {selected && <CameraFeed key={`${selected.id}:${feedRevision}`} device={selected} onRetry={() => setFeedRevision(v => v + 1)} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  content: { padding: 16, paddingBottom: 24, gap: 12, width: '100%', maxWidth: 1200, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 22, fontWeight: '800' },
  refresh: { minWidth: 44, minHeight: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  chips: { flexGrow: 0 },
  chipRow: { gap: 8, paddingBottom: 4 },
  chip: { minHeight: 44, maxWidth: 240, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1 },
  videoCard: { width: '100%', aspectRatio: 16 / 9, borderWidth: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#050508', alignItems: 'center', justifyContent: 'center' },
  imageArea: { ...StyleSheet.absoluteFillObject },
  staleFrame: { opacity: 0.3 },
  feedStatus: { alignItems: 'center', gap: 8, padding: 12, backgroundColor: '#050508dd', borderRadius: 12 },
  feedText: { color: '#fff', fontSize: 14 },
  feedRetry: { minWidth: 72, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#a88bd4', borderRadius: 10 },
  banner: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, borderRadius: 12, borderWidth: 1, gap: 8 },
});
