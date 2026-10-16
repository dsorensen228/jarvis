import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  createJarvisDevice, deleteJarvisDevice, fetchCameraSnapshotDataUri, getJarvisDevices,
  getRooms, getUsersDirectory, updateJarvisDevice,
  type JarvisDevice, type JarvisDeviceType, type Room, type UserDirectoryEntry,
} from '@/lib/api-client';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Field, PickerField } from './FormFields';
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsRow, SettingsScreen } from './SettingsUI';
import { deviceKind, devicePurpose, deviceReportTime, deviceStatus, validateDeviceConnection } from './DeviceStatus';

type Page = 'inventory' | 'overview' | 'assignments' | 'behavior' | 'connection' | 'diagnostics' | 'add-type' | 'add-basics' | 'add-assignments';
type Draft = { name: string; room: string; type: JarvisDeviceType; url: string; secret: string; alerts: boolean; prompt: string; mainCamera: boolean };
const emptyDraft = (): Draft => ({ name: '', room: '', type: 'voice_interface', url: '', secret: '', alerts: false, prompt: '', mainCamera: false });
const fromDevice = (device: JarvisDevice): Draft => ({ name: device.device_name, room: device.room || '', type: device.device_type, url: device.base_url || '', secret: '', alerts: device.doorbell_alerts_enabled, prompt: device.describe_scene_prompt || '', mainCamera: Boolean(device.is_main_describe_camera) });
const messageFor = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function Toggle({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} aria-checked={value}
    disabled={disabled} onPress={() => onChange(!value)} style={[styles.toggle, { borderColor: colors.border, opacity: disabled ? 0.6 : 1 }]}>
    <Text style={[styles.toggleLabel, { color: colors.text }]}>{label}</Text>
    <Ionicons name={value ? 'checkbox' : 'square-outline'} size={26} color={value ? colors.accentMuted : colors.textMuted} />
  </Pressable>;
}

function Copy({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return <Text style={[styles.copy, { color: colors.textMuted }]}>{children}</Text>;
}

export function DeviceSettings({ onBack }: { onBack: () => void }) {
  const { colors } = useTheme();
  const { user } = useAuth();
  const [page, setPage] = useState<Page>('inventory');
  const [devices, setDevices] = useState<JarvisDevice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [directory, setDirectory] = useState<UserDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [choicesLoading, setChoicesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [initialDraft, setInitialDraft] = useState<Draft>(emptyDraft);
  const [discard, setDiscard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const mounted = useRef(true);
  const listRequest = useRef(0);
  const snapshotRequest = useRef(0);
  const selected = devices.find(device => device.id === selectedId);
  const selectedKind = selected ? deviceKind(selected) : null;
  const supportedPurpose = selectedKind === 'voice' || selectedKind === 'camera';
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const editPage = page === 'assignments' || page === 'behavior' || page === 'connection';
  const adding = page.startsWith('add-');

  const refresh = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await getJarvisDevices();
      if (mounted.current && request === listRequest.current) setDevices(rows);
    } catch (failure) {
      if (mounted.current && request === listRequest.current) setLoadError(messageFor(failure, 'Could not load devices.'));
    } finally {
      if (mounted.current && request === listRequest.current) setLoading(false);
    }
  }, []);

  const loadChoices = useCallback(async () => {
    setChoicesLoading(true);
    setChoicesError(null);
    const [roomResult, usersResult] = await Promise.allSettled([getRooms(), getUsersDirectory()]);
    if (!mounted.current) return;
    if (roomResult.status === 'fulfilled') setRooms(roomResult.value);
    if (usersResult.status === 'fulfilled') setDirectory(usersResult.value);
    const failures = [roomResult.status === 'rejected' ? 'Room choices could not load.' : '', usersResult.status === 'rejected' ? 'Account names could not load.' : ''].filter(Boolean);
    setChoicesError(failures.length ? failures.join(' ') : null);
    setChoicesLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void loadChoices();
    return () => { mounted.current = false; listRequest.current++; snapshotRequest.current++; };
  }, [refresh, loadChoices]);

  const go = (next: Page) => {
    snapshotRequest.current++;
    setSnapshot(null);
    setSnapshotError(null);
    setSnapshotBusy(false);
    setError(null);
    setDiscard(false);
    setConfirmRemove(false);
    setPage(next);
  };
  const leave = () => {
    if (page === 'inventory') onBack();
    else if (page === 'overview' || page === 'add-type') go('inventory');
    else if (page === 'add-basics') go('add-type');
    else if (page === 'add-assignments') go('add-basics');
    else go('overview');
  };
  const back = () => {
    if (busy) return;
    if (dirty && (editPage || page === 'add-type')) setDiscard(true);
    else leave();
  };
  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const edit = (next: Page) => {
    if (!selected || busy) return;
    const nextDraft = fromDevice(selected);
    setDraft(nextDraft);
    setInitialDraft(nextDraft);
    setNotice(null);
    go(next);
  };
  const startAdd = () => {
    const nextDraft = emptyDraft();
    setDraft(nextDraft);
    setInitialDraft(nextDraft);
    setNotice(null);
    go('add-type');
  };

  const validateBasics = () => {
    if (!draft.name.trim()) return 'Enter a device name.';
    if (draft.name.trim().length > 200) return 'Device names must be 200 characters or fewer.';
    return validateDeviceConnection(draft.url, draft.type === 'camera', draft.secret);
  };
  const save = async () => {
    if (busy || (!adding && !selected)) return;
    let validation: string | null = null;
    if (adding) validation = validateBasics();
    if (page === 'assignments') {
      if (!draft.name.trim()) validation = 'Enter a device name.';
      else if (draft.name.trim().length > 200) validation = 'Device names must be 200 characters or fewer.';
    }
    if (page === 'connection') validation = validateDeviceConnection(draft.url, draft.type === 'camera', draft.secret);
    if (draft.room.length > 200) validation = 'Room names must be 200 characters or fewer.';
    if (validation) { setError(validation); return; }
    setError(null);
    setBusy(true);
    try {
      let saved: JarvisDevice;
      if (adding) {
        saved = await createJarvisDevice({ device_name: draft.name.trim(), device_type: draft.type, base_url: draft.url.trim() || null,
          room: draft.room.trim() || null, doorbell_alerts_enabled: draft.type === 'voice_interface' && draft.alerts,
          ...(draft.type === 'camera' ? { describe_scene_prompt: draft.prompt.trim() || null, is_main_describe_camera: draft.mainCamera,
            ...(draft.secret.trim() ? { callback_secret: draft.secret.trim() } : {}) } : {}),
        });
      } else {
        const body: Parameters<typeof updateJarvisDevice>[1] = page === 'assignments'
          ? { device_name: draft.name.trim(), room: draft.room.trim() || null,
              ...(draft.type !== selected!.device_type ? { device_type: draft.type } : {}),
              ...(draft.type === 'camera' && selected!.device_type !== 'camera' ? { doorbell_alerts_enabled: false } : {}) }
          : page === 'connection'
            ? { base_url: draft.url.trim() || null, ...(draft.secret.trim() ? { callback_secret: draft.secret.trim() } : {}) }
            : draft.type === 'camera'
              ? { describe_scene_prompt: draft.prompt.trim() || null, is_main_describe_camera: draft.mainCamera }
              : { doorbell_alerts_enabled: draft.alerts };
        saved = await updateJarvisDevice(selected!.id, body);
      }
      if (!mounted.current) return;
      listRequest.current++;
      setLoading(false);
      setDevices(previous => [saved, ...previous.filter(item => item.id !== saved.id).map(item => saved.is_main_describe_camera && item.device_type === 'camera' ? { ...item, is_main_describe_camera: false } : item)]);
      setSelectedId(saved.id);
      setDraft(fromDevice(saved));
      setInitialDraft(fromDevice(saved));
      setNotice(adding ? 'Device added.' : 'Changes saved.');
      go('overview');
    } catch (failure) {
      if (mounted.current) setError(messageFor(failure, 'Could not save the device. Try again.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteJarvisDevice(selected.id);
      if (!mounted.current) return;
      listRequest.current++;
      setLoading(false);
      setDevices(previous => previous.filter(item => item.id !== selected.id));
      setSelectedId(null);
      setNotice('Device removed from this account.');
      go('inventory');
    } catch (failure) {
      if (mounted.current) setError(messageFor(failure, 'Could not remove the device. Try again.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const loadSnapshot = async () => {
    if (!selected || snapshotBusy) return;
    const request = ++snapshotRequest.current;
    setSnapshotBusy(true);
    setSnapshotError(null);
    try {
      const frame = await fetchCameraSnapshotDataUri(selected.id);
      if (mounted.current && request === snapshotRequest.current) setSnapshot(frame);
    } catch (failure) {
      if (mounted.current && request === snapshotRequest.current) setSnapshotError(messageFor(failure, 'Could not load a camera snapshot.'));
    } finally {
      if (mounted.current && request === snapshotRequest.current) setSnapshotBusy(false);
    }
  };

  if (discard) return <SettingsScreen title="Unsaved changes" onBack={() => setDiscard(false)}>
    <SettingsGroup title="Discard unsaved changes?">
      <Copy>Your saved settings will stay unchanged.</Copy>
    </SettingsGroup>
    <SettingsButton label="Keep editing" variant="secondary" onPress={() => setDiscard(false)} />
    <SettingsButton label="Discard changes" variant="danger" onPress={() => { setDraft(initialDraft); leave(); }} />
  </SettingsScreen>;

  const roomOptions = [{ label: 'No room', value: '' }, ...rooms.map(room => ({ label: room.name, value: room.name }))];
  if (draft.room && !roomOptions.some(option => option.value === draft.room)) roomOptions.push({ label: draft.room, value: draft.room });
  const roomField = <>
    {choicesError && <SettingsNotice message={choicesError} />}
    {choicesError && <SettingsButton label="Retry room and account choices" variant="secondary" onPress={() => void loadChoices()} loading={choicesLoading} />}
    {choicesLoading && <Copy>Loading room choices…</Copy>}
    {!rooms.length && !choicesLoading
      ? <Field label="Room" value={draft.room} onChangeText={value => updateDraft('room', value)} placeholder="Optional room name" colors={colors} disabled={busy} />
      : <PickerField label="Room" value={draft.room} placeholder="Select room" options={roomOptions} onSelect={value => updateDraft('room', value)} colors={colors} disabled={busy || choicesLoading} />}
  </>;
  const connectionFields = <>
    <Field label="Callback URL" value={draft.url} onChangeText={value => updateDraft('url', value)} colors={colors} keyboardType="url" disabled={busy}
      placeholder={draft.type === 'camera' ? 'http://camera-one.local:8089' : 'Optional callback URL'} />
    <Copy>{draft.type === 'camera' ? 'Use the camera’s full address, including its protocol and port.' : adding || selectedKind === 'voice' ? 'Optional. Voice devices connect themselves.' : 'Optional callback address for this device.'}</Copy>
    {draft.type === 'camera' && <>
      <Field label="Callback secret" value={draft.secret} onChangeText={value => updateDraft('secret', value)} colors={colors} secureTextEntry disabled={busy}
        placeholder={adding ? 'Secret configured on the camera' : 'Leave blank to keep the existing secret'} />
      <Copy>Use the secret configured on the camera. Saved secrets are never displayed.</Copy>
    </>}
  </>;
  const behaviorFields = draft.type === 'camera' ? <>
    <Toggle label="Default describe-scene camera" value={draft.mainCamera} onChange={value => updateDraft('mainCamera', value)} disabled={busy} />
    <Copy>Used when you ask Jarvis to describe a scene without naming a camera. Selecting this replaces the previous default.</Copy>
    <Field label="Scene instructions" value={draft.prompt} onChangeText={value => updateDraft('prompt', value)} colors={colors} multiline minHeight={120} disabled={busy} placeholder="Optional details Jarvis should look for" />
  </> : <>
    <Toggle label="Announce person detections" value={draft.alerts} onChange={value => updateDraft('alerts', value)} disabled={busy} />
    <Copy>Speak person-detection alerts from your cameras while this device is connected.</Copy>
  </>;

  const title = page === 'inventory' ? 'Devices' : page === 'overview' ? 'Device'
    : page === 'assignments' ? 'Assignments' : page === 'behavior' ? selected?.device_type === 'camera' ? 'Camera behavior' : 'Voice alerts'
      : page === 'connection' ? 'Connection' : page === 'diagnostics' ? 'Diagnostics'
        : page === 'add-type' ? 'Add device' : page === 'add-basics' ? 'Device details' : 'Device assignment';

  const inventoryActions = <View style={styles.toolbar}>
    <Pressable accessibilityRole="button" accessibilityLabel="Add device" onPress={startAdd} style={styles.addAction}>
      <Ionicons name="add" size={20} color={colors.accentMuted} />
      <Text style={{ color: colors.accentMuted, fontSize: 14, fontWeight: '600' }}>Add</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Refresh devices" accessibilityState={{ disabled: loading, busy: loading }} disabled={loading}
      onPress={() => void refresh()} style={styles.refreshAction}>
      {loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <Ionicons name="refresh-outline" size={20} color={colors.textMuted} />}
    </Pressable>
  </View>;

  return <SettingsScreen title={title} onBack={back} action={page === 'inventory' ? inventoryActions : undefined}>
    {notice && !adding && !editPage && <SettingsNotice message={notice} tone="info" />}
    {error && <SettingsNotice message={error} />}
    {page === 'inventory' && <>
      {loadError && <SettingsNotice message={`Could not refresh devices. ${loadError}`} />}
      {loading && !devices.length && <View accessibilityLiveRegion="polite" style={styles.loading}><ActivityIndicator color={colors.accentMuted} /><Copy>Loading devices…</Copy></View>}
      {!loading && !loadError && !devices.length && <Copy>No devices yet. Devices that sign in to your account appear here automatically.</Copy>}
      {devices.length > 0 && <SettingsGroup>{devices.map(device => <SettingsRow key={device.id} icon={deviceKind(device) === 'camera' ? 'camera-outline' : deviceKind(device) === 'voice' ? 'mic-outline' : deviceKind(device) === 'display' ? 'tv-outline' : deviceKind(device) === 'wearable' ? 'watch-outline' : 'hardware-chip-outline'} label={device.device_name}
        description={`${devicePurpose(device)} · ${device.room || 'No room'}\n${deviceStatus(device)}${deviceReportTime(device) ? ` · ${deviceReportTime(device)}` : ''}`}
        accessibilityLabel={`Manage device: ${device.device_name}`} onPress={() => { setSelectedId(device.id); setNotice(null); go('overview'); }} />)}</SettingsGroup>}
    </>}

    {page === 'add-type' && <>
      <Copy>Devices appear automatically when they sign in. Add a record here only for manual setup.</Copy>
      <SettingsRow icon="mic-outline" label="Voice interface" description="Voice sessions and spoken camera alerts. No callback address required." onPress={() => { updateDraft('type', 'voice_interface'); go('add-basics'); }} />
      <SettingsRow icon="camera-outline" label="Camera" description="Camera snapshots and scene descriptions through a callback endpoint." onPress={() => { updateDraft('type', 'camera'); go('add-basics'); }} />
    </>}
    {page === 'add-basics' && <>
      <Copy>Step 1 of 2 · {draft.type === 'camera' ? 'Camera' : 'Voice interface'}</Copy>
      <Field label="Device name" value={draft.name} onChangeText={value => updateDraft('name', value)} colors={colors} disabled={busy} />
      {connectionFields}
      <SettingsButton label="Continue" onPress={() => { const validation = validateBasics(); if (validation) setError(validation); else go('add-assignments'); }} />
    </>}
    {page === 'add-assignments' && <>
      <Copy>Step 2 of 2 · {draft.name.trim()}</Copy>
      {roomField}
      {behaviorFields}
      <Copy>Account: {user?.email || user?.name || 'your signed-in account'}</Copy>
      <SettingsButton label="Add device" loading={busy} onPress={() => void save()} />
    </>}

    {selected && page === 'overview' && <>
      <Text accessibilityRole="header" style={[styles.deviceName, { color: colors.text }]}>{selected.device_name}</Text>
      <Copy>{devicePurpose(selected)} · {selected.room || 'No room assigned'}</Copy>
      <SettingsGroup title="Reported status">
        <Text style={[styles.status, { color: colors.text }]}>{deviceStatus(selected)}</Text>
        {deviceReportTime(selected) && <Copy>Last report: {deviceReportTime(selected)}</Copy>}
        {selected.detector_degraded_reason && <SettingsNotice message={`Person detection: ${selected.detector_degraded_reason}`} />}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow label="Assignments" description="Name, purpose, and room" onPress={() => edit('assignments')} />
        {supportedPurpose && <SettingsRow label={selectedKind === 'camera' ? 'Camera behavior' : 'Voice alerts'} description={selectedKind === 'camera' ? 'Scene instructions and default camera' : 'Spoken person-detection alerts'} onPress={() => edit('behavior')} />}
        <SettingsRow label="Connection" description={selected.base_url || 'No callback endpoint configured'} onPress={() => edit('connection')} />
        <SettingsRow label="Diagnostics" description={selected.device_type === 'camera' ? 'Reported health and a fresh camera snapshot' : 'Reported connection and device identity'} onPress={() => { if (!busy) go('diagnostics'); }} />
      </SettingsGroup>
      <Copy>Account: {directory.find(entry => entry.user_id === selected.user_id)?.email || (selected.user_id === user?.id ? user?.email : selected.user_id) || 'Current account'}</Copy>
      {confirmRemove ? <SettingsGroup title="Remove this device?">
        <Copy>This removes the saved device record. It does not turn off the hardware. A running device may register itself again.</Copy>
        <SettingsButton label="Keep device" variant="secondary" disabled={busy} onPress={() => { setConfirmRemove(false); setError(null); }} />
        <SettingsButton label="Confirm removal" variant="danger" loading={busy} onPress={() => void remove()} />
      </SettingsGroup> : <SettingsButton label="Remove device" variant="danger" onPress={() => setConfirmRemove(true)} />}
    </>}

    {selected && page === 'assignments' && <>
      <Field label="Device name" value={draft.name} onChangeText={value => updateDraft('name', value)} colors={colors} disabled={busy} />
      {supportedPurpose ? <PickerField label="Device type" value={draft.type} placeholder="Select device type" options={[{ label: 'Voice interface', value: 'voice_interface' }, { label: 'Camera', value: 'camera' }]}
        onSelect={value => updateDraft('type', value as JarvisDeviceType)} colors={colors} disabled={busy} /> : <Copy>Device type: {devicePurpose(selected)}</Copy>}
      {roomField}
      {draft.type !== selected.device_type && <SettingsNotice message="Changing the registered purpose does not reconfigure the hardware." tone="info" />}
    </>}
    {selected && page === 'behavior' && behaviorFields}
    {selected && page === 'connection' && <>
      {connectionFields}
      {selected.device_type === 'camera' && <Copy>{selected.callback_configured ? 'A camera callback secret is saved.' : 'No camera callback secret is saved. Set one to enable authenticated snapshots.'}</Copy>}
    </>}
    {selected && editPage && <SettingsButton label="Save changes" loading={busy} disabled={!dirty} onPress={() => void save()} />}

    {selected && page === 'diagnostics' && <>
      <SettingsButton label="Refresh status" variant="secondary" loading={loading} onPress={() => void refresh()} />
      {loadError && <SettingsNotice message={`Could not refresh status. ${loadError}`} />}
      <SettingsGroup title="Last device report">
        <Copy>{deviceStatus(selected)}</Copy>
        {deviceReportTime(selected) && <Copy>Reported at {deviceReportTime(selected)}</Copy>}
        {selected.device_type === 'camera' && <>
          <Copy>Camera readiness: {selected.health?.ready === true ? 'Reported ready' : selected.health?.ready === false ? 'Reported not ready' : 'Not reported'}</Copy>
          {selected.health?.frame_sequence != null && <Copy>Last reported frame: {selected.health.frame_sequence}</Copy>}
          {selected.camera_model && <Copy>Camera model: {selected.camera_model}</Copy>}
          {selected.resolution?.length === 2 && <Copy>Reported resolution: {selected.resolution.join(' × ')}</Copy>}
          {selected.detector_degraded_reason && <SettingsNotice message={`Person detection: ${selected.detector_degraded_reason}`} />}
        </>}
      </SettingsGroup>
      <SettingsGroup title="Identity and connection">
        <Copy>Device ID: {selected.id}</Copy>
        <Copy>{selected.base_url ? `Callback URL: ${selected.base_url}` : selectedKind === 'voice' ? 'No callback URL. Voice devices use their connection to the API.' : 'No callback URL configured.'}</Copy>
        {selected.acting_user_id && <Copy>Legacy acting-user record: {selected.acting_user_id}. This record does not change the account used by the hardware.</Copy>}
      </SettingsGroup>
      {selected.device_type === 'camera' ? <SettingsGroup title="Camera snapshot">
        <Copy>Request one fresh frame through the API to check camera access.</Copy>
        {snapshot && <Image source={{ uri: snapshot }} accessibilityLabel={`Snapshot from ${selected.device_name}`} style={styles.snapshot} resizeMode="contain" onError={() => setSnapshotError('The camera response could not be displayed.')} />}
        {snapshotError && <SettingsNotice message={snapshotError} />}
        <SettingsButton label={snapshotError ? 'Retry snapshot' : snapshot ? 'Refresh snapshot' : 'Load snapshot'} loading={snapshotBusy} onPress={() => void loadSnapshot()} />
      </SettingsGroup> : selectedKind === 'voice' ? <Copy>Check microphone, speaker, and wake-word settings on the voice device.</Copy> : null}
    </>}
    {!selected && !adding && page !== 'inventory' && <>
      <SettingsNotice message="This device is no longer in the device list." />
      <SettingsButton label="Back to devices" variant="secondary" onPress={() => go('inventory')} />
    </>}
  </SettingsScreen>;
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  addAction: { minHeight: 44, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  refreshAction: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  deviceName: { fontSize: 22, fontWeight: '600', lineHeight: 29, minWidth: 0 },
  copy: { fontSize: 14, lineHeight: 21, minWidth: 0, flexShrink: 1 },
  status: { fontSize: 16, fontWeight: '600', lineHeight: 23 },
  loading: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  toggle: { minHeight: 54, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  toggleLabel: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22 },
  snapshot: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#000000' },
});
