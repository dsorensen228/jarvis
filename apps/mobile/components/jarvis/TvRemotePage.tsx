import {
  commandSmartDevice,
  getSmartDevices,
  type RemoteKey,
  type SmartDevice,
  type SmartHomeCommandBody,
} from '@/lib/api-client';
import {
  createTvCommandQueue,
  tvMedia,
  tvSources,
  tvStatus,
  tvSupports,
  tvSupportsKey,
} from '@/lib/tvRemoteState';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';

type Panel = 'remote' | 'apps' | 'keyboard' | 'more';
type Icon = React.ComponentProps<typeof Ionicons>['name'];

export function TvRemotePage({ focusDeviceId }: { focusDeviceId?: string | null }) {
  const { colors } = useTheme();
  const [screens, setScreens] = useState<SmartDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusDeviceId ?? null);
  const [panel, setPanel] = useState<Panel>('remote');
  const [pending, setPending] = useState(0);
  const [sourceQuery, setSourceQuery] = useState('');
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [channel, setChannel] = useState('');
  const mounted = useRef(false);
  const queue = useRef<ReturnType<typeof createTvCommandQueue> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestVersion = useRef(0);
  const readInFlight = useRef(false);

  const load = useCallback(async (reportError = false) => {
    if (readInFlight.current) return;
    readInFlight.current = true;
    const version = ++requestVersion.current;
    try {
      const devices = await getSmartDevices();
      if (!mounted.current || version !== requestVersion.current) return;
      const rows = devices.filter((device) => tvMedia(device));
      setScreens(rows);
      setReadError(false);
      setSelectedId((previous) =>
        rows.some((row) => row.id === previous)
          ? previous
          : (rows.find((row) => row.primary_for_room)?.id ?? rows[0]?.id ?? null)
      );
      if (reportError) setError(null);
    } catch {
      if (mounted.current && version === requestVersion.current) setReadError(true);
    } finally {
      if (version === requestVersion.current) {
        readInFlight.current = false;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queue.current = createTvCommandQueue({
      onPending: setPending,
      onError: (e) => setError(e instanceof Error ? e.message : 'The TV command failed.'),
      onSettled: () => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => void load(), 700);
      },
    });
    void load(true);
    const poll = setInterval(() => {
      if (AppState.currentState === 'active') void load();
    }, 10000);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => {
      mounted.current = false;
      requestVersion.current++;
      readInFlight.current = false;
      clearInterval(poll);
      appState.remove();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      queue.current?.dispose();
    };
  }, [load]);

  useEffect(() => {
    if (focusDeviceId) setSelectedId(focusDeviceId);
  }, [focusDeviceId]);
  useEffect(() => {
    queue.current?.select(selectedId);
    setPanel('remote');
    setError(null);
    setSourceQuery('');
    setInputText('');
    setSearchQuery('');
    setChannel('');
  }, [selectedId]);

  const selected = useMemo(
    () => screens.find((screen) => screen.id === selectedId) ?? null,
    [screens, selectedId]
  );
  const media = tvMedia(selected);
  const sources = tvSources(selected, sourceQuery);
  const blocked = readError || !selected?.available || pending >= 8;
  const supports = (capability: Parameters<typeof tvSupports>[1]) =>
    tvSupports(selected, capability);
  const hasKey = (key: RemoteKey) => tvSupportsKey(selected, key);
  const hasMore = supports('search') || supports('channel_tune') || supports('find_remote');
  const power = media?.power ?? selected?.power;
  const status = selected ? tvStatus(selected) : '';
  const title = power === false ? '' : media?.media_title;

  const send = (body: SmartHomeCommandBody, onSuccess?: () => void) => {
    if (!selectedId || blocked) return;
    const target = selectedId;
    setError(null);
    if (!queue.current?.enqueue(target, () => commandSmartDevice(target, body), onSuccess)) {
      setError('Wait for the queued commands to finish.');
    }
  };
  const key = (remoteKey: RemoteKey) => send({ action: 'key', parameters: { key: remoteKey } });
  const control = (
    icon: Icon,
    label: string,
    onPress: () => void,
    options: { active?: boolean; large?: boolean; disabled?: boolean } = {}
  ) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked || options.disabled, selected: options.active }}
      aria-pressed={options.active}
      disabled={blocked || options.disabled}
      onPress={onPress}
      style={[
        styles.control,
        options.large && styles.largeControl,
        {
          backgroundColor: options.active ? colors.accent : colors.surfaceElevated,
          borderColor: options.active ? colors.accent : colors.border,
          opacity: blocked || options.disabled ? 0.4 : 1,
        },
      ]}
    >
      <Ionicons
        name={icon}
        size={options.large ? 30 : 23}
        color={options.active ? '#fff' : colors.text}
      />
    </TouchableOpacity>
  );
  const remoteControl = (remoteKey: RemoteKey, icon: Icon, label: string) =>
    hasKey(remoteKey) ? control(icon, label, () => key(remoteKey)) : null;
  const textField = (
    value: string,
    change: (value: string) => void,
    placeholder: string,
    submit: () => void,
    button: string,
    numeric = false
  ) => (
    <View style={styles.inputRow}>
      <TextInput
        value={value}
        onChangeText={change}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        placeholderTextColor={colors.textMuted}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.surfaceElevated,
            borderColor: colors.border,
          },
        ]}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={256}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        returnKeyType="send"
        onSubmitEditing={() => {
          if (!blocked && pending === 0 && value.trim()) submit();
        }}
      />
      <TouchableOpacity
        accessibilityRole="button"
        disabled={blocked || pending > 0 || !value.trim()}
        onPress={submit}
        style={[
          styles.submit,
          {
            backgroundColor: colors.accent,
            opacity: blocked || pending > 0 || !value.trim() ? 0.4 : 1,
          },
        ]}
      >
        <Text style={styles.submitText}>{button}</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading)
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.page}>
        <View style={styles.headingRow}>
          <Text style={[styles.heading, { color: colors.text }]}>TV</Text>
          {pending > 0 ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Refresh TVs"
            style={styles.refresh}
            onPress={() => void load(true)}
          >
            <Ionicons name="refresh-outline" size={22} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={[styles.error, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
        {readError ? (
          <View style={styles.staleRow}>
            <Text accessibilityRole="alert" style={[styles.staleText, { color: colors.error }]}>
              TV status is out of date. Refresh to reconnect.
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void load(true)}
              style={styles.refresh}
            >
              <Text style={{ color: colors.accent }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {!screens.length && !readError ? (
          <Text style={[styles.empty, { color: colors.textMuted }]}>
            No TVs found. Add one in Home Assistant, then Sync in Home.
          </Text>
        ) : null}
        {screens.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.screenPicker}
          >
            {screens.map((screen) => (
              <TouchableOpacity
                key={screen.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: screen.id === selectedId }}
                aria-checked={screen.id === selectedId}
                onPress={() => {
                  queue.current?.select(screen.id);
                  setSelectedId(screen.id);
                }}
                style={[
                  styles.screenChip,
                  {
                    borderColor: screen.id === selectedId ? colors.accent : colors.border,
                    backgroundColor:
                      screen.id === selectedId ? `${colors.accent}18` : colors.surface,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={{ color: screen.id === selectedId ? colors.accent : colors.text }}
                >
                  {screen.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}
        {selected ? (
          <>
            <View
              style={[
                styles.nowPlaying,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View style={styles.statusBody}>
                <Text style={[styles.deviceName, { color: colors.text }]} numberOfLines={1}>
                  {selected.name}
                </Text>
                <Text style={[styles.status, { color: colors.textMuted }]} numberOfLines={1}>
                  {status}
                </Text>
                {title ? (
                  <Text style={[styles.mediaTitle, { color: colors.text }]} numberOfLines={2}>
                    {title}
                  </Text>
                ) : null}
                {media?.media_channel && power !== false ? (
                  <Text style={[styles.status, { color: colors.textMuted }]}>
                    {media.media_channel}
                  </Text>
                ) : null}
              </View>
              {supports('power')
                ? control(
                    'power',
                    power === true ? 'Turn TV off' : 'Turn TV on',
                    () => send({ action: power === true ? 'turn_off' : 'turn_on' }),
                    { active: power === true, disabled: pending > 0 }
                  )
                : null}
            </View>
            <View style={[styles.tabs, { borderColor: colors.border }]}>
              {(
                [
                  ['remote', 'Remote', true],
                  ['apps', 'Apps & inputs', supports('app_launch')],
                  ['keyboard', 'Keyboard', supports('text_input')],
                  ['more', 'More', hasMore],
                ] as [Panel, string, boolean][]
              )
                .filter(([, , shown]) => shown)
                .map(([id, label]) => (
                  <TouchableOpacity
                    key={id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: panel === id }}
                    aria-selected={panel === id}
                    onPress={() => setPanel(id)}
                    style={[styles.tab, panel === id && { backgroundColor: `${colors.accent}20` }]}
                  >
                    <Text
                      style={[
                        styles.tabText,
                        { color: panel === id ? colors.accent : colors.textMuted },
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
            </View>
            {panel === 'remote' ? (
              <View style={styles.remote}>
                {supports('remote_keys') ? (
                  <>
                    <View style={styles.buttonRow}>
                      {remoteControl('back', 'arrow-back-outline', 'Back')}
                      {remoteControl('home', 'home-outline', 'Home')}
                      {remoteControl('info', 'ellipsis-horizontal', 'Options')}
                    </View>
                    <View
                      style={[
                        styles.dpad,
                        { backgroundColor: colors.surface, borderColor: colors.border },
                      ]}
                    >
                      <View style={styles.dpadRow}>
                        {control('chevron-up', 'Up', () => key('up'), {
                          large: true,
                          disabled: !hasKey('up'),
                        })}
                      </View>
                      <View style={styles.dpadRow}>
                        {control('chevron-back', 'Left', () => key('left'), {
                          large: true,
                          disabled: !hasKey('left'),
                        })}
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="OK"
                          disabled={blocked || !hasKey('select')}
                          onPress={() => key('select')}
                          style={[
                            styles.ok,
                            {
                              backgroundColor: colors.accent,
                              opacity: blocked || !hasKey('select') ? 0.4 : 1,
                            },
                          ]}
                        >
                          <Text style={styles.okText}>OK</Text>
                        </TouchableOpacity>
                        {control('chevron-forward', 'Right', () => key('right'), {
                          large: true,
                          disabled: !hasKey('right'),
                        })}
                      </View>
                      <View style={styles.dpadRow}>
                        {control('chevron-down', 'Down', () => key('down'), {
                          large: true,
                          disabled: !hasKey('down'),
                        })}
                      </View>
                    </View>
                  </>
                ) : null}
                <View style={styles.buttonRow}>
                  {remoteControl('replay', 'refresh-outline', 'Instant replay')}
                  {remoteControl('rewind', 'play-back-outline', 'Rewind')}
                  {supports('playback') || hasKey('play')
                    ? control(
                        media?.playback_state === 'playing' ? 'pause' : 'play',
                        'Play or pause',
                        () => send({ action: 'play_pause' }),
                        { disabled: pending > 0 }
                      )
                    : null}
                  {remoteControl('fast_forward', 'play-forward-outline', 'Fast forward')}
                </View>
                {supports('volume') || supports('mute') ? (
                  <View style={[styles.volumeBar, { borderColor: colors.border }]}>
                    {supports('mute')
                      ? control(
                          media?.muted ? 'volume-mute' : 'volume-mute-outline',
                          media?.muted ? 'Unmute' : 'Mute or unmute',
                          () => send({ action: 'mute_toggle' }),
                          { active: media?.muted === true, disabled: pending > 0 }
                        )
                      : null}
                    {supports('volume') ? (
                      <>
                        {control('remove', 'Volume down', () => send({ action: 'volume_down' }))}
                        <View style={styles.volumeLabel}>
                          <Ionicons
                            name="volume-medium-outline"
                            size={20}
                            color={colors.textMuted}
                          />
                          {media?.volume_percent !== undefined ? (
                            <Text style={{ color: colors.textMuted }}>{media.volume_percent}%</Text>
                          ) : null}
                        </View>
                        {control('add', 'Volume up', () => send({ action: 'volume_up' }))}
                      </>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
            {panel === 'apps' ? (
              <View style={styles.panel}>
                <TextInput
                  value={sourceQuery}
                  onChangeText={setSourceQuery}
                  placeholder="Filter apps & inputs"
                  accessibilityLabel="Filter apps and inputs"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  style={[
                    styles.input,
                    styles.filter,
                    {
                      color: colors.text,
                      borderColor: colors.border,
                      backgroundColor: colors.surface,
                    },
                  ]}
                />
                <View style={styles.sourceGrid}>
                  {sources.map((source) => (
                    <TouchableOpacity
                      key={source}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${source}`}
                      accessibilityState={{ selected: media?.app === source, disabled: blocked }}
                      aria-pressed={media?.app === source}
                      disabled={blocked}
                      onPress={() => send({ action: 'select_source', parameters: { source } })}
                      style={[
                        styles.source,
                        {
                          borderColor: media?.app === source ? colors.accent : colors.border,
                          backgroundColor:
                            media?.app === source ? `${colors.accent}18` : colors.surface,
                          opacity: blocked ? 0.4 : 1,
                        },
                      ]}
                    >
                      <Text style={[styles.sourceText, { color: colors.text }]} numberOfLines={2}>
                        {source}
                      </Text>
                      <Ionicons
                        name={media?.app === source ? 'checkmark' : 'chevron-forward'}
                        size={16}
                        color={media?.app === source ? colors.accent : colors.textMuted}
                      />
                    </TouchableOpacity>
                  ))}
                </View>
                {!sources.length ? (
                  <Text style={[styles.empty, { color: colors.textMuted }]}>
                    {tvSources(selected).length
                      ? 'No matching apps or inputs.'
                      : 'Home Assistant has no apps or inputs for this TV yet.'}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {panel === 'keyboard' ? (
              <View style={styles.panel}>
                <Text style={[styles.help, { color: colors.textMuted }]}>
                  Select a text field on the TV, then send text.
                </Text>
                {textField(
                  inputText,
                  setInputText,
                  'Text for TV',
                  () => {
                    const submitted = inputText;
                    send({ action: 'text', parameters: { text: submitted } }, () =>
                      setInputText((current) => (current === submitted ? '' : current))
                    );
                  },
                  'Send'
                )}
                <View style={styles.buttonRow}>
                  {remoteControl('backspace', 'backspace-outline', 'Delete character')}
                  {remoteControl('enter', 'return-down-back-outline', 'Enter')}
                  {remoteControl('search', 'search-outline', 'Open TV search')}
                </View>
              </View>
            ) : null}
            {panel === 'more' ? (
              <View style={styles.panel}>
                {supports('search') ? (
                  <View style={styles.fieldGroup}>
                    <Text style={[styles.fieldLabel, { color: colors.text }]}>Search Roku</Text>
                    {textField(
                      searchQuery,
                      setSearchQuery,
                      'Title, actor, or director',
                      () => send({ action: 'search', parameters: { query: searchQuery.trim() } }),
                      'Search'
                    )}
                  </View>
                ) : null}
                {supports('channel_tune') ? (
                  <View style={styles.fieldGroup}>
                    <Text style={[styles.fieldLabel, { color: colors.text }]}>TV channel</Text>
                    {textField(
                      channel,
                      setChannel,
                      'Channel number',
                      () => send({ action: 'channel', parameters: { channel: channel.trim() } }),
                      'Tune',
                      true
                    )}
                    <View style={styles.buttonRow}>
                      {remoteControl('channel_down', 'remove', 'Channel down')}
                      {remoteControl('channel_up', 'add', 'Channel up')}
                    </View>
                  </View>
                ) : null}
                {supports('find_remote') ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={blocked}
                    onPress={() => send({ action: 'find_remote' })}
                    style={[
                      styles.findRemote,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                        opacity: blocked ? 0.4 : 1,
                      },
                    ]}
                  >
                    <Ionicons name="volume-high-outline" size={22} color={colors.accent} />
                    <Text style={{ color: colors.text }}>Find remote</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { padding: 16, paddingBottom: 32, alignItems: 'center' },
  page: { width: '100%', maxWidth: 540, gap: 12 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heading: { flex: 1, fontSize: 24, fontWeight: '700' },
  refresh: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  error: { fontSize: 13, lineHeight: 19 },
  staleRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  staleText: { flex: 1, fontSize: 13, lineHeight: 19 },
  screenPicker: { gap: 8 },
  screenChip: {
    maxWidth: 220,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  nowPlaying: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderRadius: 16,
  },
  statusBody: { flex: 1, minWidth: 0, gap: 4 },
  deviceName: { fontSize: 17, fontWeight: '600' },
  status: { fontSize: 13 },
  mediaTitle: { fontSize: 14, marginTop: 4 },
  tabs: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, padding: 3 },
  tab: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 4,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 9,
  },
  tabText: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  remote: { alignItems: 'center', gap: 12, paddingTop: 4 },
  buttonRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, flexWrap: 'wrap' },
  control: {
    width: 48,
    height: 48,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  largeControl: { width: 54, height: 50, borderWidth: 0, borderRadius: 20 },
  dpad: {
    width: 216,
    height: 196,
    padding: 8,
    borderWidth: 1,
    borderRadius: 48,
    justifyContent: 'center',
    gap: 3,
  },
  dpadRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  ok: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  okText: { color: '#fff', fontWeight: '700', fontSize: 18 },
  volumeBar: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
  },
  volumeLabel: { minWidth: 36, alignItems: 'center', gap: 2 },
  panel: { gap: 16, paddingTop: 4 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  filter: { flex: 0 },
  submit: { minHeight: 48, justifyContent: 'center', borderRadius: 12, paddingHorizontal: 16 },
  submitText: { color: '#fff', fontWeight: '600' },
  sourceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '48%',
    flexGrow: 1,
    gap: 8,
    minHeight: 60,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
  sourceText: { flex: 1, minWidth: 0, fontSize: 14 },
  empty: { fontSize: 14, lineHeight: 21, paddingVertical: 16 },
  help: { fontSize: 13, lineHeight: 20 },
  fieldGroup: { gap: 10 },
  fieldLabel: { fontSize: 15, fontWeight: '600' },
  findRemote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
  },
});
