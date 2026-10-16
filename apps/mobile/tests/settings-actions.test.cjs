const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');

const flush = () => new Promise(done => setImmediate(done));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function harness(t) {
  const state = { permission: 'granted', picker: { canceled: false, assets: [{ uri: 'file://selected-photo' }] }, uploads: 0, pickerCalls: 0, failUpload: false, user: { id: 'one', name: 'Test user' }, refreshes: [], openedUrls: [] };
  const user = { useAuth: () => ({ user: state.user, refreshUser, signOut() {} }) };
  function refreshUser(value) { state.refreshes.push(value); }
  const colors = { background: '#000', surface: '#000', text: '#fff', textMuted: '#aaa', accent: '#7654ff', accentMuted: '#987aff', border: '#333', error: '#f66' };
  const host = name => props => React.createElement(name, props, props.children);
  const native = Object.fromEntries(['ActivityIndicator', 'Image', 'Pressable', 'Text', 'View'].map(name => [name, name]));
  native.StyleSheet = { create: value => value };
  native.Linking = { openURL: async url => state.openedUrls.push(url) };
  const mocks = {
    'react-native': native,
    '@expo/vector-icons': { Ionicons: 'Icon' },
    'expo-constants': { expoConfig: { version: '1.0.15' } },
    'expo-image-picker': { MediaTypeOptions: { Images: 'images' }, requestMediaLibraryPermissionsAsync: async () => ({ status: state.permission }), launchImageLibraryAsync: async () => { state.pickerCalls++; return state.picker; } },
    '@/contexts/AuthContext': user,
    '@/contexts/ThemeContext': { useTheme: () => ({ colors, colorScheme: 'dark', setColorScheme() {} }) },
    '@/lib/api-client': { getMe: async () => state.getMe ? state.getMe() : state.user, updateMeSettings: async () => {}, uploadAvatar: async () => { state.uploads++; if (state.failUpload) throw new Error('offline'); return { avatar_url: '/avatar.png' }; } },
    '@/lib/runtimePublicEnv': { getApiBaseUrl: () => 'https://api.example.test', getApkDownloadUrl: () => 'https://download.example.test/latest.apk', ngrokSkipBrowserWarningHeaders: () => ({ 'ngrok-skip-browser-warning': 'true' }) },
    '@/lib/identity': { mission_full: 'About', mission_tagline: 'Jarvis' },
    './settings/NotificationSettings': { NotificationSettings: () => null },
    './settings/DeviceSettings': { DeviceSettings: host('devices') },
    './settings/SettingsUI': Object.fromEntries(['Screen', 'Row', 'Group', 'Button', 'Notice'].map(name => [`Settings${name}`, host(name.toLowerCase())])),
  };
  const filename = resolve(__dirname, '../components/SettingsPanel.tsx');
  const loaded = new Module(filename, module);
  loaded.require = id => id in mocks ? mocks[id] : require(id);
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, filename);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ blob: async () => new Blob(['photo'], { type: 'image/png' }) });
  let renderer;
  await act(async () => { renderer = create(React.createElement(loaded.exports.SettingsPanel)); await flush(); });
  t.after(() => { act(() => renderer.unmount()); global.fetch = originalFetch; });
  const find = (type, label) => renderer.root.findAllByType(type).find(node => node.props.label === label);
  return {
    state, renderer,
    async press(type, label) { const node = find(type, label); assert.ok(node, `${type}: ${label}`); await act(async () => { node.props.onPress(); await flush(); }); },
    async back() { await act(async () => { renderer.root.findByType('screen').props.onBack(); await flush(); }); },
    button(label) { return find('button', label); },
    notices() { return renderer.root.findAllByType('notice').map(node => node.props.message); },
  };
}

test('denied photo access and a canceled picker do not upload or leave the action busy', async t => {
  const app = await harness(t);
  await app.press('row', 'Account');
  app.state.permission = 'denied';
  await app.press('button', 'Change profile photo');
  assert.equal(app.state.pickerCalls, 0);
  assert.equal(app.state.uploads, 0);
  assert.ok(app.notices().some(message => /Allow photo access/.test(message)));
  assert.equal(app.button('Change profile photo').props.loading, false);
  app.state.permission = 'granted';
  app.state.picker = { canceled: true, assets: [] };
  await app.press('button', 'Change profile photo');
  assert.equal(app.state.uploads, 0);
  assert.deepEqual(app.notices(), []);
  assert.equal(app.button('Change profile photo').props.loading, false);
});

test('photo upload failure can retry and refresh the displayed account after success', async t => {
  const app = await harness(t);
  await app.press('row', 'Account');
  app.state.failUpload = true;
  await app.press('button', 'Change profile photo');
  assert.equal(app.state.uploads, 1);
  assert.ok(app.notices().some(message => /Could not upload/.test(message)));
  assert.equal(app.button('Change profile photo').props.loading, false);
  app.state.failUpload = false;
  app.state.user = { ...app.state.user, avatar_url: '/avatar.png' };
  await app.press('button', 'Change profile photo');
  assert.equal(app.state.uploads, 2);
  assert.equal(app.state.refreshes.at(-1).avatar_url, '/avatar.png');
  assert.deepEqual(app.notices(), ['Photo updated']);
});

test('leaving connection diagnostics aborts the request and ignores a late response', async t => {
  const app = await harness(t);
  const pending = deferred();
  let signal;
  global.fetch = async (_url, options) => { signal = options.signal; return pending.promise; };
  await app.press('row', 'App & connections');
  await app.press('button', 'Check connection');
  assert.equal(app.button('Check connection').props.loading, true);
  await app.back();
  assert.equal(signal.aborted, true);
  await act(async () => { pending.resolve({ status: 200, json: async () => ({ database: true, llm: true, speech: { asr: true, tts: true } }) }); await flush(); });
  await app.press('row', 'App & connections');
  assert.equal(app.button('Check connection').props.loading, false);
  assert.deepEqual(app.notices(), []);
  assert.equal(app.renderer.root.findAllByType('Text').some(node => node.props.children === 'Ready'), false);
});

test('a late photo profile refresh cannot restore an account after settings unmounts', async t => {
  const app = await harness(t);
  await app.press('row', 'Account');
  const pending = deferred();
  app.state.getMe = () => pending.promise;
  const refreshCount = app.state.refreshes.length;
  await app.press('button', 'Change profile photo');
  assert.equal(app.state.uploads, 1);
  act(() => app.renderer.unmount());
  await act(async () => { pending.resolve({ id: 'old-account', avatar_url: '/old-avatar.png' }); await flush(); });
  assert.equal(app.state.refreshes.length, refreshCount, 'unmounted settings must not update shared account state');
});
