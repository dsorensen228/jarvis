import {
  getApiBaseUrl,
  createCameraStreamSession,
  createJarvisDevice,
  deleteJarvisDevice,
  getMe,
  updateJarvisDevice,
  updateMeSettings,
  uploadAvatar,
  type CameraStreamSession,
  type JarvisDevice,
  type JarvisDeviceType,
} from '@/lib/api-client';
import { Field, PickerField } from '@/components/settings/FormFields';
import { Section } from '@/components/settings/Section';
import { JarvisDeviceEditForm, JarvisDeviceTile } from '@/components/smartHome/JarvisDeviceEditor';
import { JarvisTabIcon } from '@/components/icons/JarvisTabIcon';
import { useSmartHome } from '@/contexts/SmartHomeContext';
import { mission_full, mission_tagline } from '@/lib/identity';
import { getApkDownloadUrl } from '@/lib/runtimePublicEnv';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useAuth } from '../contexts/AuthContext';
import { useTheme, type ColorScheme } from '../contexts/ThemeContext';

const APK_DOWNLOAD_URL = getApkDownloadUrl();

type SettingsTab = 'jarvis' | 'jarvisDevices' | 'about';

type SettingsTabDef = {
  key: SettingsTab;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** Custom SVG face icon instead of Ionicon `icon` (Jarvis profile tab). */
  jarvisFaceIcon?: boolean;
};

const SETTINGS_TABS: SettingsTabDef[] = [
  { key: 'jarvis', label: 'Jarvis', icon: 'sparkles-outline', jarvisFaceIcon: true },
  { key: 'jarvisDevices', label: 'Jarvis Devices', icon: 'hardware-chip-outline' },
  { key: 'about', label: 'About', icon: 'information-circle-outline' },
];

function PersonalityRow({
  label,
  labels,
  value,
  onChange,
  colors,
}: {
  label: string;
  labels: [string, string, string];
  value: 1 | 2 | 3;
  onChange: (v: 1 | 2 | 3) => Promise<void>;
  colors: { accent: string; surface: string; text: string };
}) {
  return (
    <View style={styles.personalityRow}>
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      <View style={styles.segmentedRow}>
        {([1, 2, 3] as const).map((level) => (
          <TouchableOpacity
            key={level}
            style={[
              styles.segmentedButton,
              {
                backgroundColor: value === level ? colors.accent : colors.surface,
              },
            ]}
            onPress={() => void onChange(level)}
          >
            <Text
              style={[
                styles.segmentedButtonText,
                { color: value === level ? '#fff' : colors.text },
              ]}
            >
              {labels[level - 1]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}




export function SettingsPanel() {
  const { user, refreshUser } = useAuth();
  const { colors, colorScheme, setColorScheme } = useTheme();
  const {
    loadSmartControls,
    jarvisDevices,
    rooms,
    userDirectory,
    tileWidth,
    setTileGridInnerWidth,
  } = useSmartHome();

  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [newJarvisDeviceName, setNewJarvisDeviceName] = useState('');
  const [newJarvisAddress, setNewJarvisAddress] = useState('');
  const [newJarvisCallbackPortStr, setNewJarvisCallbackPortStr] = useState('');
  const [newJarvisRoomName, setNewJarvisRoomName] = useState('');
  const [newJarvisDeviceType, setNewJarvisDeviceType] =
    useState<JarvisDeviceType>('voice_interface');
  const [newJarvisActingUserId, setNewJarvisActingUserId] = useState('');
  const [newJarvisDoorbell, setNewJarvisDoorbell] = useState(false);
  const [newJarvisCallbackSecret, setNewJarvisCallbackSecret] = useState('');
  const [streamPreviewDevice, setStreamPreviewDevice] = useState<JarvisDevice | null>(null);
  const [streamPreviewSession, setStreamPreviewSession] = useState<CameraStreamSession | null>(null);
  const [streamTick, setStreamTick] = useState(0);
  const [jarvisDeviceModalOpen, setJarvisDeviceModalOpen] = useState(false);
  const [editingJarvisDevice, setEditingJarvisDevice] = useState<JarvisDevice | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('jarvis');

  const avatarUri = user?.avatar_url ? `${getApiBaseUrl()}${user.avatar_url}` : null;

  const loadEverything = useCallback(async () => {
    try {
      const me = await getMe().catch(() => null);
      if (me) {
        refreshUser(me);
      }
    } finally {
      setLoading(false);
    }
  }, [refreshUser]);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  useEffect(() => {
    if (activeTab !== 'jarvisDevices') return;
    void loadSmartControls();
  }, [activeTab, loadSmartControls]);

  const refreshUserFromApi = async () => {
    const me = await getMe();
    refreshUser(me);
  };

  const handlePickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== 'granted') {
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets[0]) {
      return;
    }

    setUploading(true);
    try {
      const response = await fetch(result.assets[0].uri);
      const blob = await response.blob();
      await uploadAvatar(blob);
      await refreshUserFromApi();
    } finally {
      setUploading(false);
    }
  };

  const setTheme = async (scheme: ColorScheme) => {
    setColorScheme(scheme);
    try {
      await updateMeSettings({ theme: scheme });
      await refreshUserFromApi();
    } catch {
      // local change is still fine
    }
  };

  const persistSetting = async (body: Parameters<typeof updateMeSettings>[0]) => {
    await updateMeSettings(body);
    await refreshUserFromApi();
  };

  const roomOptionsForModal = useMemo(
    () => [
      { label: 'No room', value: '' },
      ...rooms.map((entry) => ({ label: entry.name, value: entry.name })),
    ],
    [rooms]
  );

  const newJarvisActingOptions = useMemo(
    () => [
      { label: 'Not set', value: '' },
      ...userDirectory.map((u) => ({
        label: u.display_name?.trim()
          ? `${u.display_name} (${u.email || u.user_id})`
          : u.email || u.user_id,
        value: u.user_id,
      })),
    ],
    [userDirectory]
  );
  const newJarvisTypeOptions = useMemo(
    () => [
      { label: 'Voice', value: 'voice_interface' },
      { label: 'Camera', value: 'camera' },
    ],
    []
  );

  useEffect(() => {
    if (!streamPreviewDevice) return;
    const t = setInterval(() => setStreamTick((x) => x + 1), 1600);
    return () => clearInterval(t);
  }, [streamPreviewDevice]);

  useEffect(() => {
    if (!streamPreviewDevice) {
      setStreamPreviewSession(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const s = await createCameraStreamSession(streamPreviewDevice.id);
        if (!cancelled) setStreamPreviewSession(s);
      } catch {
        if (!cancelled) setStreamPreviewSession(null);
      }
    };
    void load();
    const iv = setInterval(() => void load(), 8 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [streamPreviewDevice]);

  if (loading) {
    return (
      <View style={[styles.loadingWrap, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.screenContent}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={[
          styles.settingsTabBar,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
      >
        {SETTINGS_TABS.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[
                styles.settingsTabButton,
                selected && { backgroundColor: `${colors.accent}18` },
              ]}
              onPress={() => setActiveTab(tab.key)}
            >
              {tab.jarvisFaceIcon ? (
                <JarvisTabIcon
                  size={18}
                  color={selected ? colors.accent : colors.textMuted}
                />
              ) : (
                <Ionicons
                  name={tab.icon}
                  size={18}
                  color={selected ? colors.accent : colors.textMuted}
                />
              )}
              <Text
                style={[
                  styles.settingsTabLabel,
                  { color: selected ? colors.accent : colors.textMuted },
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {activeTab === 'jarvis' ? (
        <>
      <Section
        title="Profile"
        subtitle="Account identity, avatar, and the way Jarvis presents itself."
        colors={colors}
      >
        <View style={styles.profileRow}>
          <TouchableOpacity style={styles.avatarButton} onPress={handlePickImage}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.profileAvatar} />
            ) : (
              <View
                style={[
                  styles.profileAvatarFallback,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                ]}
              >
                <Ionicons name="person" size={28} color={colors.textMuted} />
              </View>
            )}
            {uploading ? (
              <View style={styles.avatarLoading}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : null}
          </TouchableOpacity>
          <View style={styles.profileMeta}>
            <Text style={[styles.profileName, { color: colors.text }]}>
              {user?.name || 'User'}
            </Text>
            <Text style={[styles.profileEmail, { color: colors.textMuted }]}>
              {user?.email || ''}
            </Text>
          </View>
        </View>
        <PersonalityRow
          label="Jarvis tone"
          labels={['Mild', 'Medium', 'Strong']}
          value={(user?.jarvis_personality ?? 1) as 1 | 2 | 3}
          onChange={(value) => persistSetting({ jarvis_personality: value })}
          colors={colors}
        />
      </Section>
      <Section
        title="Local inference"
        subtitle="Jarvis runs one Qwen reasoning model plus dedicated Faster Whisper and Kokoro services on the Jetson. Runtime model changes belong in the server deployment, not the app."
        colors={colors}
      >
        <Text style={{ color: colors.text }}>Qwen3 30B A3B Instruct 2507</Text>
      </Section>

      <Section
        title="Appearance"
        subtitle="Keep the shell styling consistent wherever you open the app."
        colors={colors}
      >
        <View style={styles.segmentedRow}>
          {(['light', 'dark'] as ColorScheme[]).map((scheme) => (
            <TouchableOpacity
              key={scheme}
              style={[
                styles.segmentedButton,
                {
                  backgroundColor:
                    colorScheme === scheme ? colors.accent : colors.surface,
                },
              ]}
              onPress={() => void setTheme(scheme)}
            >
              <Text
                style={[
                  styles.segmentedButtonText,
                  { color: colorScheme === scheme ? '#fff' : colors.text },
                ]}
              >
                {scheme === 'light' ? 'Light' : 'Dark'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>
        </>
      ) : null}

      {activeTab === 'jarvisDevices' ? (
      <Section
        title="Jarvis Devices"
        subtitle="Register voice and camera hardware on your LAN and assign rooms."
        colors={colors}
      >
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.subsectionTitle, { color: colors.text }]}>
            Your devices
          </Text>
          <TouchableOpacity
            style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
            onPress={() => setJarvisDeviceModalOpen(true)}
          >
            <Text style={styles.smallPrimaryText}>Add Jarvis device</Text>
          </TouchableOpacity>
        </View>
        {jarvisDevices.length === 0 ? (
          <View
            style={[
              styles.inlineCard,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.deviceNote, { color: colors.textMuted }]}>
              No Jarvis devices yet.
            </Text>
          </View>
        ) : (
          <View
            style={styles.deviceGrid}
            onLayout={(e) => setTileGridInnerWidth(e.nativeEvent.layout.width)}
          >
            {jarvisDevices.map((device) => (
              <JarvisDeviceTile
                key={device.id}
                device={device}
                rooms={rooms}
                colors={colors}
                tileStyle={{ width: tileWidth }}
                onPress={() => setEditingJarvisDevice(device)}
              />
            ))}
          </View>
        )}
      </Section>
      ) : null}


      {activeTab === 'about' ? (
        <>
          <Section
            title="About Jarvis"
            subtitle={mission_tagline}
            colors={colors}
          >
            <Text style={[styles.aboutBody, { color: colors.text }]}>{mission_full}</Text>
          </Section>
          <Section
            title="Android APK"
            subtitle="Direct install link for the current Android build."
            colors={colors}
          >
            {APK_DOWNLOAD_URL ? (
              <>
                <Text style={[styles.aboutBody, { color: colors.textMuted }]}>
                  Use this direct APK link when you need to install or share the current build.
                </Text>
                <TouchableOpacity
                  style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
                  onPress={() => void Linking.openURL(APK_DOWNLOAD_URL)}
                >
                  <Text style={styles.smallPrimaryText}>Download APK</Text>
                </TouchableOpacity>
                <Text style={[styles.downloadUrl, { color: colors.textMuted }]}>
                  {APK_DOWNLOAD_URL}
                </Text>
              </>
            ) : (
              <Text style={[styles.aboutBody, { color: colors.textMuted }]}>
                EXPO_PUBLIC_APK_DOWNLOAD_URL is not set for this build.
              </Text>
            )}
          </Section>
        </>
      ) : null}

      <Modal
        visible={jarvisDeviceModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setJarvisDeviceModalOpen(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setJarvisDeviceModalOpen(false)}
        >
          <Pressable
            style={[styles.pickerModal, { backgroundColor: colors.surface }]}
            onPress={(event) => event.stopPropagation()}
          >
            <View style={styles.modalCardBody}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Add Jarvis Device</Text>
              <Text style={[styles.sectionSubtitle, { color: colors.textMuted }]}>
                Register a new hardware endpoint and optionally assign its room and voice identity.
              </Text>
              <Field
                label="Device name"
                value={newJarvisDeviceName}
                onChangeText={setNewJarvisDeviceName}
                colors={colors}
              />
              <Field
                label="LAN address (mDNS hostname)"
                value={newJarvisAddress}
                onChangeText={setNewJarvisAddress}
                placeholder="voice-node.local"
                colors={colors}
              />
              <Field
                label="Callback port (optional)"
                value={newJarvisCallbackPortStr}
                onChangeText={setNewJarvisCallbackPortStr}
                placeholder="8089"
                colors={colors}
                keyboardType="number-pad"
              />
              <PickerField
                label="Device type"
                value={newJarvisDeviceType}
                placeholder="Type"
                options={newJarvisTypeOptions}
                onSelect={(v) => {
                  setNewJarvisDeviceType(v as JarvisDeviceType);
                  if (v === 'camera') setNewJarvisDoorbell(false);
                }}
                colors={colors}
              />
              {newJarvisDeviceType === 'camera' ? (
                <Field
                  label="Callback secret (same as Pi)"
                  value={newJarvisCallbackSecret}
                  onChangeText={setNewJarvisCallbackSecret}
                  colors={colors}
                  secureTextEntry
                />
              ) : null}
              <PickerField
                label="Room"
                value={newJarvisRoomName}
                placeholder="Select room"
                options={roomOptionsForModal}
                onSelect={setNewJarvisRoomName}
                colors={colors}
              />
              <PickerField
                label="Acts as user"
                value={newJarvisActingUserId}
                placeholder={userDirectory.length ? 'Select user' : 'Enter id below'}
                options={newJarvisActingOptions}
                onSelect={setNewJarvisActingUserId}
                colors={colors}
              />
              {userDirectory.length === 0 ? (
                <Field
                  label="Acting user id (manual)"
                  value={newJarvisActingUserId}
                  onChangeText={setNewJarvisActingUserId}
                  placeholder="Mongo / Google user id"
                  colors={colors}
                />
              ) : null}
              {newJarvisDeviceType === 'voice_interface' ? (
                <TouchableOpacity
                  style={styles.jarvisCheckRow}
                  onPress={() => setNewJarvisDoorbell((d) => !d)}
                >
                  <Ionicons
                    name={newJarvisDoorbell ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={newJarvisDoorbell ? colors.accent : colors.textMuted}
                  />
                  <Text style={[styles.jarvisCheckLabel, { color: colors.text }]}>
                    Doorbell / voice alerts
                  </Text>
                </TouchableOpacity>
              ) : null}
              <View style={styles.modalActions}>
                <TouchableOpacity onPress={() => setJarvisDeviceModalOpen(false)}>
                  <Text style={[styles.linkText, { color: colors.textMuted }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.smallPrimary, { backgroundColor: colors.accent }]}
                  onPress={async () => {
                    const addr = newJarvisAddress.trim();
                    if (!addr) {
                      Alert.alert('Address required', 'Enter this Pi’s LAN hostname (e.g. voice-node.local).');
                      return;
                    }
                    const cps = newJarvisCallbackPortStr.trim();
                    let callback_port: number | undefined;
                    if (cps !== '') {
                      const n = parseInt(cps, 10);
                      if (Number.isNaN(n) || n < 1 || n > 65535) {
                        Alert.alert('Invalid port', 'Callback port must be a number from 1 to 65535.');
                        return;
                      }
                      callback_port = n;
                    }
                    await createJarvisDevice({
                      device_name: newJarvisDeviceName.trim(),
                      address: addr,
                      ...(callback_port !== undefined ? { callback_port } : {}),
                      room: newJarvisRoomName || null,
                      device_type: newJarvisDeviceType,
                      acting_user_id: newJarvisActingUserId.trim() || null,
                      doorbell_alerts_enabled:
                        newJarvisDeviceType === 'voice_interface' ? newJarvisDoorbell : false,
                      ...(newJarvisDeviceType === 'camera' && newJarvisCallbackSecret.trim()
                        ? { callback_secret: newJarvisCallbackSecret.trim() }
                        : {}),
                    });
                    setNewJarvisDeviceName('');
                    setNewJarvisAddress('');
                    setNewJarvisCallbackPortStr('');
                    setNewJarvisRoomName('');
                    setNewJarvisDeviceType('voice_interface');
                    setNewJarvisActingUserId('');
                    setNewJarvisDoorbell(false);
                    setNewJarvisCallbackSecret('');
                    setJarvisDeviceModalOpen(false);
                    await loadSmartControls();
                  }}
                >
                  <Text style={styles.smallPrimaryText}>Add Device</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={editingJarvisDevice != null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingJarvisDevice(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setEditingJarvisDevice(null)}
        >
          <Pressable
            style={[styles.pickerModal, { backgroundColor: colors.surface, maxHeight: '92%' }]}
            onPress={(e) => e.stopPropagation()}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.modalCardBody}
            >
              {editingJarvisDevice ? (
                <>
                  <TouchableOpacity
                    style={{ alignSelf: 'flex-end', paddingBottom: 4 }}
                    onPress={() => setEditingJarvisDevice(null)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                  <JarvisDeviceEditForm
                    device={editingJarvisDevice}
                    rooms={rooms}
                    userDirectory={userDirectory}
                    onOpenStream={(d) => {
                      setStreamTick(0);
                      setStreamPreviewDevice(d);
                    }}
                    onSave={async (id, body) => {
                      await updateJarvisDevice(id, body);
                      await loadSmartControls();
                      setEditingJarvisDevice(null);
                    }}
                    onDelete={async (id) => {
                      await deleteJarvisDevice(id);
                      await loadSmartControls();
                      setEditingJarvisDevice(null);
                    }}
                    colors={colors}
                  />
                </>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={streamPreviewDevice != null}
        transparent
        animationType="fade"
        onRequestClose={() => setStreamPreviewDevice(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setStreamPreviewDevice(null)}
        >
          <Pressable
            style={[styles.pickerModal, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Camera preview</Text>
            <Text style={[styles.deviceNote, { color: colors.textMuted }]}>
              Proxied through the API (requires callback secret on the device). For live MJPEG use the
              Cameras tab.
            </Text>
            {streamPreviewSession && streamPreviewDevice ? (
              <Image
                style={styles.streamSnapshot}
                source={{
                  uri: `${getApiBaseUrl()}${streamPreviewSession.snapshot_path}?camera_token=${encodeURIComponent(
                    streamPreviewSession.camera_token
                  )}&t=${streamTick}`,
                }}
                resizeMode="contain"
              />
            ) : streamPreviewDevice ? (
              <Text style={[styles.deviceNote, { color: colors.textMuted }]}>
                Could not start preview session. Save the device with ngrok URL (and optional local
                URL if the API uses LAN mode), plus callback secret on cameras, then try again.
              </Text>
            ) : null}
            <TouchableOpacity
              style={[styles.smallPrimary, { backgroundColor: colors.accent, marginTop: 12 }]}
              onPress={() => setStreamPreviewDevice(null)}
            >
              <Text style={styles.smallPrimaryText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0 },
  screenContent: {
    padding: 20,
    paddingBottom: 32,
    gap: 16,
    minWidth: 0,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 24,
    padding: 18,
    gap: 14,
  },
  settingsTabBar: {
    flexDirection: 'row',
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 20,
    padding: 6,
    gap: 6,
  },
  settingsTabButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  settingsTabLabel: {
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  sectionSubtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minWidth: 0,
  },
  avatarButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    overflow: 'hidden',
  },
  profileAvatar: {
    width: '100%',
    height: '100%',
    borderRadius: 36,
  },
  profileAvatarFallback: {
    width: '100%',
    height: '100%',
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  avatarLoading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileMeta: { flex: 1, minWidth: 0, gap: 4 },
  profileName: { fontSize: 20, fontWeight: '700' },
  profileEmail: { fontSize: 14 },
  personalityRow: { gap: 10 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  segmentedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segmentedButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
  },
  segmentedButtonText: { fontSize: 14, fontWeight: '600' },
  field: { gap: 8 },
  fieldLabel: { fontSize: 14, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
  },
  pickerButton: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pickerText: { fontSize: 15 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  pickerModal: {
    width: '100%',
    maxWidth: 560,
    borderRadius: 20,
    overflow: 'hidden',
  },
  catalogModal: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '92%',
    borderRadius: 20,
    borderWidth: 1,
    padding: 18,
  },
  catalogScroll: {
    maxHeight: 280,
    marginTop: 8,
  },
  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalCardBody: {
    padding: 18,
    gap: 14,
  },
  pickerOption: {
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  pickerOptionText: {
    fontSize: 16,
    fontWeight: '600',
  },
  connectBox: { gap: 12 },
  smallPrimary: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
    minWidth: 0,
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  costSensitivityBlock: {
    marginTop: 4,
    marginBottom: 8,
    gap: 4,
  },
  costSlider: {
    width: '100%',
    height: 40,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  syncSplit: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    minHeight: 44,
    maxWidth: 200,
  },
  syncSplitMain: {
    flex: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  syncSplitChevron: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.35)',
  },
  syncMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  syncMenuSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    paddingBottom: 24,
    paddingTop: 8,
  },
  syncMenuRow: {
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  syncMenuRowText: {
    fontSize: 16,
    fontWeight: '600',
  },
  subsectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inputGrow: { flex: 1, minWidth: 0 },
  inlineStack: { gap: 10 },
  roomDeviceGroup: { gap: 10 },
  roomDeviceHeading: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  inlineCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 12,
  },
  smartRoomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  smartRoomTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  smartRoomTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  roomDeviceHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardTitle: { fontSize: 17, fontWeight: '700' },
  cardMeta: { fontSize: 13, marginTop: 4 },
  inlineActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  linkText: { fontSize: 14, fontWeight: '600' },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  deviceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
  },
  deviceTile: {
    width: '100%',
    minHeight: 154,
    borderWidth: 1,
    borderRadius: 20,
    padding: 14,
    gap: 12,
  },
  deviceTileCompound: {
    minHeight: 180,
  },
  deviceTileHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lightToggle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceTileBody: {
    marginTop: 'auto',
    gap: 6,
  },
  subDeviceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  subDeviceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  subDeviceChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  deviceTileTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  deviceTileMeta: {
    fontSize: 13,
    lineHeight: 18,
  },
  deviceNote: { fontSize: 13, lineHeight: 18 },
  jarvisTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  typeBadge: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  typeBadgeText: { fontSize: 12, fontWeight: '600' },
  jarvisCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
    marginBottom: 4,
  },
  jarvisCheckLabel: { fontSize: 14, flex: 1, lineHeight: 20 },
  streamSnapshot: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: '100%',
    minHeight: 220,
    maxHeight: 360,
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: '#111',
  },
  smallGhost: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  smallGhostText: { fontSize: 14, fontWeight: '700' },
  aboutBody: {
    fontSize: 15,
    lineHeight: 23,
  },
  downloadUrl: {
    fontSize: 13,
    lineHeight: 19,
  },
});
