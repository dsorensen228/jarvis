import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme, type ColorScheme } from '@/contexts/ThemeContext';
import { getMe, updateMeSettings, uploadAvatar } from '@/lib/api-client';
import { getApiBaseUrl, getApkDownloadUrl, ngrokSkipBrowserWarningHeaders } from '@/lib/runtimePublicEnv';
import { mission_full, mission_tagline } from '@/lib/identity';
import { NotificationSettings } from './settings/NotificationSettings';
import { DeviceSettings } from './settings/DeviceSettings';
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsRow, SettingsScreen } from './settings/SettingsUI';

type Destination = 'home' | 'account' | 'preferences' | 'tone' | 'appearance' | 'devices' | 'app' | 'about';
type Readiness = { database: boolean; llm: boolean; speech: { asr: boolean; tts: boolean } };
const toneLabels = ['Mild', 'Medium', 'Strong'];

function Choice({ label, accessibilityLabel, selected, disabled, onPress }: {
  label: string; accessibilityLabel: string; selected: boolean; disabled: boolean; onPress: () => void;
}) {
  const { colors } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected, disabled }} aria-selected={selected} disabled={disabled} onPress={onPress}
    style={[s.choice, { borderBottomColor: colors.border, opacity: disabled ? 0.6 : 1 }]}>
    <Text style={[s.choiceLabel, { color: colors.text }]}>{label}</Text>
    <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={23} color={selected ? colors.accentMuted : colors.textMuted} />
  </Pressable>;
}

export function SettingsPanel() {
  const { user, refreshUser, signOut } = useAuth();
  const { colors, colorScheme, setColorScheme } = useTheme();
  const [page, setPage] = useState<Destination>('home');
  const [notice, setNotice] = useState<{ message: string; tone: 'error' | 'info' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<Readiness | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const checkController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void getMe().then(me => { if (mounted.current) refreshUser(me); }).catch(() => {
      if (mounted.current) setNotice({ message: 'Could not refresh your account. Showing saved information.', tone: 'error' });
    });
    return () => { mounted.current = false; checkController.current?.abort(); };
  }, [refreshUser]);

  const navigate = (destination: Destination) => {
    if (checking) {
      checkController.current?.abort();
      checkController.current = null;
      setChecking(false);
    }
    setPage(destination);
    setNotice(null);
  };
  const status = notice && <SettingsNotice {...notice} />;
  const tone = Math.min(3, Math.max(1, user?.jarvis_personality ?? 1));

  const persist = async (body: Parameters<typeof updateMeSettings>[0], scheme?: ColorScheme) => {
    if (saving) return;
    setSaving(true);
    setNotice(null);
    if (scheme) setColorScheme(scheme);
    try {
      await updateMeSettings(body);
      const me = await getMe();
      if (mounted.current) {
        refreshUser(me);
        setNotice({ message: 'Saved', tone: 'info' });
      }
    } catch {
      if (mounted.current) setNotice({ message: scheme ? 'Theme changed on this device. Could not sync it to your account.' : 'Could not save your preference. Try again.', tone: 'error' });
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const changePhoto = async () => {
    if (uploading) return;
    setNotice(null);
    setUploading(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!mounted.current) return;
      if (permission.status !== 'granted') {
        setNotice({ message: 'Allow photo access in your device settings to choose a profile photo.', tone: 'error' });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (!mounted.current || result.canceled || !result.assets[0]) return;
      const response = await fetch(result.assets[0].uri);
      const blob = await response.blob();
      if (!mounted.current) return;
      await uploadAvatar(blob);
      if (!mounted.current) return;
      const me = await getMe();
      if (!mounted.current) return;
      refreshUser(me);
      setNotice({ message: 'Photo updated', tone: 'info' });
    } catch {
      if (mounted.current) setNotice({ message: 'Could not upload your photo. Try again.', tone: 'error' });
    } finally {
      if (mounted.current) setUploading(false);
    }
  };

  const checkConnection = async () => {
    if (checking) return;
    const controller = new AbortController();
    checkController.current = controller;
    setChecking(true);
    setNotice(null);
    setHealth(null);
    setCheckedAt(null);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${getApiBaseUrl().replace(/\/$/, '')}/health/ready`, { headers: ngrokSkipBrowserWarningHeaders(), signal: controller.signal });
      const result = await response.json();
      if (![200, 503].includes(response.status) || typeof result.database !== 'boolean' || typeof result.llm !== 'boolean' || typeof result.speech?.asr !== 'boolean' || typeof result.speech?.tts !== 'boolean') throw new Error('Unexpected health response');
      if (!controller.signal.aborted && mounted.current) {
        setHealth(result);
        setCheckedAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      }
    } catch {
      if (mounted.current && checkController.current === controller) setNotice({ message: 'Could not reach the Jarvis server. Check your connection and try again.', tone: 'error' });
    } finally {
      clearTimeout(timeout);
      if (mounted.current && checkController.current === controller) { setChecking(false); checkController.current = null; }
    }
  };

  if (page === 'devices') return <DeviceSettings onBack={() => navigate('home')} />;
  if (page === 'home') return <SettingsScreen title="Settings">
    {status}
    <SettingsGroup>
      <SettingsRow icon="person-outline" label="Account" value={user?.name || user?.email || 'Profile and sign-in'} onPress={() => navigate('account')} />
      <SettingsRow icon="options-outline" label="Preferences" value={`${colorScheme === 'dark' ? 'Dark' : 'Light'} appearance · ${toneLabels[tone - 1]} tone`} onPress={() => navigate('preferences')} />
      <SettingsRow icon="hardware-chip-outline" label="Jarvis devices" value="Voice interfaces and cameras" onPress={() => navigate('devices')} />
      <SettingsRow icon="information-circle-outline" label="App & connections" value="Server status, version and Android download" onPress={() => navigate('app')} />
    </SettingsGroup>
  </SettingsScreen>;

  if (page === 'account') {
    const avatar = user?.avatar_url ? /^https?:\/\//.test(user.avatar_url) ? user.avatar_url : `${getApiBaseUrl()}${user.avatar_url}` : null;
    return <SettingsScreen title="Account" onBack={() => navigate('home')}>
      <View style={s.profile}>
        {avatar ? <Image source={{ uri: avatar }} style={s.avatar} /> : <View style={[s.avatar, s.avatarFallback, { borderColor: colors.border }]}><Ionicons name="person-outline" size={26} color={colors.textMuted} /></View>}
        <View style={s.profileText}><Text style={[s.name, { color: colors.text }]}>{user?.name || 'User'}</Text><Text selectable style={[s.body, { color: colors.textMuted }]}>{user?.email}</Text></View>
      </View>
      <SettingsButton label="Change profile photo" onPress={() => void changePhoto()} loading={uploading} variant="secondary" />
      {status}
      <SettingsGroup><SettingsRow label="Sign out" icon="log-out-outline" onPress={() => signOut()} /></SettingsGroup>
    </SettingsScreen>;
  }

  if (page === 'preferences') return <SettingsScreen title="Preferences" onBack={() => navigate('home')}>
    <SettingsGroup>
      <SettingsRow label="Jarvis tone" value={toneLabels[tone - 1]} onPress={() => navigate('tone')} />
      <SettingsRow label="Appearance" value={colorScheme === 'dark' ? 'Dark' : 'Light'} onPress={() => navigate('appearance')} />
    </SettingsGroup>
  </SettingsScreen>;

  if (page === 'tone' || page === 'appearance') return <SettingsScreen title={page === 'tone' ? 'Jarvis tone' : 'Appearance'} onBack={() => navigate('preferences')}>
    <SettingsGroup>
      {page === 'tone' ? toneLabels.map((label, index) => <Choice key={label} label={label} accessibilityLabel={`Jarvis tone: ${label}`} selected={tone === index + 1} disabled={saving} onPress={() => void persist({ jarvis_personality: (index + 1) as 1 | 2 | 3 })} />)
        : (['light', 'dark'] as const).map(scheme => <Choice key={scheme} label={scheme === 'light' ? 'Light' : 'Dark'} accessibilityLabel={`${scheme === 'light' ? 'Light' : 'Dark'} theme`} selected={colorScheme === scheme} disabled={saving} onPress={() => void persist({ theme: scheme }, scheme)} />)}
    </SettingsGroup>
    {saving ? <View style={s.saving}><ActivityIndicator size="small" color={colors.textMuted} /><SettingsNotice tone="info" message="Saving…" /></View> : status}
  </SettingsScreen>;

  if (page === 'about') return <SettingsScreen title="About Jarvis" onBack={() => navigate('app')}>
    <Text style={[s.body, { color: colors.text }]}>{mission_tagline}</Text>
    <Text style={[s.body, { color: colors.textMuted }]}>{mission_full}</Text>
    <SettingsGroup title="Local inference"><SettingsRow label="Qwen3 30B A3B Instruct 2507" description="Locally hosted reasoning, speech recognition and voice." /></SettingsGroup>
  </SettingsScreen>;

  const apkUrl = getApkDownloadUrl();
  return <SettingsScreen title="App & connections" onBack={() => navigate('home')}>
    <SettingsGroup title="Jarvis server">
      <Text selectable style={[s.endpoint, { color: colors.textMuted }]}>{getApiBaseUrl()}</Text>
      {health && <View style={s.health}>
        {([['Database', health.database], ['Reasoning', health.llm], ['Speech recognition', health.speech.asr], ['Voice', health.speech.tts]] as const).map(([label, ready]) => <View key={label} style={s.healthRow}>
          <Text style={[s.healthLabel, { color: colors.text }]}>{label}</Text><Text style={{ color: ready ? colors.textMuted : colors.error }}>{ready ? 'Ready' : 'Unavailable'}</Text>
        </View>)}
        <SettingsNotice tone="info" message={`Checked ${checkedAt}`} />
      </View>}
      <SettingsButton label="Check connection" onPress={() => void checkConnection()} loading={checking} variant="secondary" />
    </SettingsGroup>
    {status}
    <NotificationSettings />
    <SettingsGroup title="This app">
      <SettingsRow label="Version" value={Constants.expoConfig?.version ?? 'Unknown'} />
      {apkUrl ? <SettingsRow label="Download Android app" icon="download-outline" onPress={() => { void Linking.openURL(apkUrl).catch(() => setNotice({ message: 'Could not open the download link. Try again.', tone: 'error' })); }} /> : <SettingsRow label="Android download unavailable" />}
      <SettingsRow label="About Jarvis" onPress={() => navigate('about')} />
    </SettingsGroup>
  </SettingsScreen>;
}

const s = StyleSheet.create({
  choice: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 18, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth },
  choiceLabel: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  profileText: { flex: 1, minWidth: 0, gap: 6 },
  avatar: { width: 52, height: 52, borderRadius: 26 },
  avatarFallback: { borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  name: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23 },
  saving: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  endpoint: { fontSize: 14, lineHeight: 21, marginBottom: 16 },
  health: { gap: 12, marginBottom: 20 },
  healthRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  healthLabel: { flexGrow: 1, fontSize: 14 },
});
