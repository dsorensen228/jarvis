const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
const flush = () => new Promise(done => setImmediate(done));

function loader(mocks = {}) {
  const cache = new Map();
  function load(path) {
    const filename = ['', '.ts', '.tsx', '.js'].map(ext => path + ext).find(existsSync);
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded = new Module(filename, module);
    cache.set(filename, loaded);
    loaded.require = id => {
      if (id in mocks) return mocks[id];
      if (id.startsWith('@/')) return load(resolve(__dirname, '..', id.slice(2)));
      if (id.startsWith('.')) return load(resolve(dirname(filename), id));
      return require(id);
    };
    const source = readFileSync(filename, 'utf8');
    loaded._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
    return loaded.exports;
  }
  return load;
}

async function harness(t, options = {}) {
  const state = { permission: 'undetermined', canAskAgain: true, registered: [], unregistered: [], channels: [], requests: 0, failure: false, auth: { accessToken: 'session', user: { id: 'user' } }, ...options };
  let onActive, onToken;
  const notifications = {
    AndroidImportance: { HIGH: 4 }, DEFAULT_ACTION_IDENTIFIER: 'default',
    setNotificationHandler() {},
    setNotificationChannelAsync: async (id, config) => { await flush(); state.channels.push({ id, ...config }); },
    setNotificationCategoryAsync: async () => {},
    getPermissionsAsync: async () => ({ status: state.permission, canAskAgain: state.canAskAgain }),
    requestPermissionsAsync: async () => {
      state.requests++;
      // Android 13 cannot request notification permission before a channel exists.
      if (state.channels.length) state.permission = 'granted';
      return { status: state.permission, canAskAgain: state.canAskAgain };
    },
    getExpoPushTokenAsync: async options => { state.tokenOptions = options; return { data: options?.devicePushToken?.data === 'new-native-token' ? 'ExponentPushToken[new]' : 'ExponentPushToken[initial]' }; },
    addPushTokenListener: listener => { onToken = listener; return { remove() { onToken = null; } }; },
  };
  const empty = () => null;
  const load = loader({
    'expo-notifications': notifications,
    'react-native': { Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: (_event, listener) => { onActive = listener; return { remove() { onActive = null; } }; } } },
    'expo-constants': { expoConfig: { extra: { eas: { projectId: 'test-project' } } }, deviceName: 'test-phone' },
    '@/lib/api-client': { registerPushToken: async (body, token) => { if (state.failure) throw new Error('offline'); await state.onRegister?.(body, token); state.registered.push({ body, token }); }, unregisterPushToken: async (body, token) => { state.unregistered.push({ body, token }); }, setTokenProvider() {}, setTokenRefresher() {}, setOnAuthFailure() {} },
    '@/contexts/AuthContext': { useAuth: () => state.auth },
    '../contexts/AuthContext': { useAuth: () => state.auth, AuthProvider: empty },
    '../contexts/ThemeContext': { useTheme: () => ({}), ThemeProvider: empty },
    '../contexts/ConversationContext': { ConversationProvider: empty },
    '../contexts/TimerContext': { TimerProvider: empty },
    '../components/GmailNotificationBridge': { GmailNotificationBridge: empty },
    '../components/CameraPersonNotificationBridge': { CameraPersonNotificationBridge: empty },
    '@react-oauth/google': { GoogleOAuthProvider: empty },
    'expo-router': { Stack: empty, useRouter: () => ({}) },
    'expo-status-bar': { StatusBar: empty },
    '@/lib/runtimePublicEnv': { getGoogleWebClientId: () => '' },
  });
  const bridgePath = resolve(__dirname, '../components/PushTokenBridge.tsx');
  const { PushTokenBridge } = load(bridgePath);
  let renderer;
  await act(async () => { renderer = create(React.createElement(PushTokenBridge)); for (let i = 0; i < 8; i++) await flush(); });
  t.after(() => act(() => renderer.unmount()));
  return { state, load, async auth(accessToken) { state.auth = { accessToken, user: accessToken ? { id: 'user' } : null }; await act(async () => { renderer.update(React.createElement(PushTokenBridge)); for (let i = 0; i < 8; i++) await flush(); }); }, async active() { await act(async () => { onActive?.('active'); for (let i = 0; i < 8; i++) await flush(); }); }, async rotate() { await act(async () => { onToken?.({ type: 'android', data: 'new-native-token' }); for (let i = 0; i < 8; i++) await flush(); }); } };
}

test('Android creates high importance alert channels before asking permission and registers with the current session', async t => {
  const app = await harness(t);
  assert.equal(app.state.registered.length, 1);
  assert.deepEqual(app.state.channels.map(channel => channel.id).sort(), ['camera-person', 'task-status', 'urgent-email']);
  assert.ok(app.state.channels.every(channel => channel.importance === 4 && channel.sound === 'default'));
  assert.equal(app.state.registered[0].token, 'session');
  assert.equal(app.state.tokenOptions.projectId, 'test-project');
});

test('permanent notification denial does not reopen an unresolvable permission prompt', async t => {
  const app = await harness(t, { permission: 'denied', canAskAgain: false });
  assert.equal(app.state.requests, 0);
  assert.equal(app.state.registered.length, 0);
});

test('returning to the app retries registration after the network or permission recovers', async t => {
  const app = await harness(t, { permission: 'granted', failure: true });
  assert.equal(app.state.registered.length, 0);
  app.state.failure = false;
  await app.active();
  assert.equal(app.state.registered.length, 1);
});

test('native push token rotation registers the replacement Expo token', async t => {
  const app = await harness(t, { permission: 'granted' });
  await app.rotate();
  assert.equal(app.state.registered.at(-1).body.token, 'ExponentPushToken[new]');
});

test('a camera notification tapped before the home screen mounts opens its camera exactly once', () => {
  const nav = loader()(resolve(__dirname, '../lib/homeNavigationBridge.ts'));
  const opened = [];
  nav.navigateHomeToCameras('front-door');
  nav.registerHomeGoToCameras(id => opened.push(id));
  nav.registerHomeGoToCameras(null);
  nav.registerHomeGoToCameras(id => opened.push(id));
  assert.deepEqual(opened, ['front-door']);
});

test('task notifications wait for home navigation and preserve the requested task', () => {
  const nav = loader()(resolve(__dirname, '../lib/homeNavigationBridge.ts'));
  const opened = [];
  nav.navigateHomeToTask('research', 'research-7');
  nav.registerHomeGoToTask((kind, id) => opened.push({ kind, id }));
  assert.deepEqual(opened, [{ kind: 'research', id: 'research-7' }]);
});

test('task push taps route coding and research tasks once and ignore unrelated or malformed payloads', async t => {
  const response = (id, data, actionIdentifier = 'default') => ({ actionIdentifier, notification: { request: { identifier: id, content: { data } } } });
  const initial = response('one', { type: 'research_task', task_id: 'research-7', status: 'success' });
  let onResponse;
  const load = loader({ 'expo-notifications': { DEFAULT_ACTION_IDENTIFIER: 'default', useLastNotificationResponse: () => initial,
    addNotificationResponseReceivedListener: listener => { onResponse = listener; return { remove() {} }; } } });
  const nav = load(resolve(__dirname, '../lib/homeNavigationBridge.ts'));
  const { TaskNotificationBridge } = load(resolve(__dirname, '../components/TaskNotificationBridge.tsx'));
  const opened = [];
  nav.registerHomeGoToTask((kind, id) => opened.push({ kind, id }));
  let renderer;
  await act(async () => { renderer = create(React.createElement(TaskNotificationBridge)); await flush(); });
  t.after(() => act(() => renderer.unmount()));
  act(() => {
    onResponse(initial);
    onResponse(response('two', { type: 'code_task', task_id: 'code-8', status: 'failed' }));
    onResponse(response('other', { type: 'person_detected', task_id: 'fake' }));
    onResponse(response('bad', { type: 'code_task', task_id: {} }));
    onResponse(response('dismiss', { type: 'code_task', task_id: 'code-9' }, 'dismiss'));
  });
  assert.deepEqual(opened, [{ kind: 'research', id: 'research-7' }, { kind: 'code', id: 'code-8' }]);
});

test('task detail notification focus loads by ID and ignores a stale response after another task is tapped', async t => {
  const { useNotificationTaskFocus } = loader()(resolve(__dirname, '../hooks/useNotificationTaskFocus.ts'));
  const pending = new Map();
  const opened = [];
  let consumed = 0;
  const fetchTask = id => new Promise(done => pending.set(id, done));
  function Focus({ id }) { useNotificationTaskFocus(id, fetchTask, task => opened.push(task), () => consumed++); return null; }
  let renderer;
  act(() => { renderer = create(React.createElement(Focus, { id: 'old' })); });
  t.after(() => act(() => renderer.unmount()));
  act(() => renderer.update(React.createElement(Focus, { id: 'new' })));
  await act(async () => { pending.get('old')({ id: 'old' }); pending.get('new')({ id: 'new', status: 'failed' }); await flush(); });
  assert.deepEqual(opened, [{ id: 'new', status: 'failed' }]);
  assert.equal(consumed, 1);
});

test('denied and failed registrations expose recovery status and explicit retry can recover', async t => {
  const app = await harness(t, { permission: 'denied', canAskAgain: false });
  const state = app.load(resolve(__dirname, '../lib/pushNotificationState.ts'));
  assert.equal(state.getPushNotificationStatus().phase, 'denied');
  app.state.permission = 'granted';
  app.state.failure = true;
  await app.active();
  assert.equal(state.getPushNotificationStatus().phase, 'error');
  app.state.failure = false;
  await act(async () => { state.retryPushNotifications(); for (let i = 0; i < 8; i++) await flush(); });
  assert.equal(state.getPushNotificationStatus().phase, 'registered');
});

test('notification recovery opens the Android notification settings for Jarvis and exposes retry', async t => {
  const intents = [];
  let retried = 0;
  const host = name => props => React.createElement(name, props, props.children);
  const load = loader({
    'react-native': { Platform: { OS: 'android' }, Linking: { sendIntent: async (...args) => intents.push(args) } },
    'expo-constants': { expoConfig: { android: { package: 'com.jarvis.app' } } },
    '@/lib/pushNotificationState': { usePushNotificationStatus: () => ({ phase: 'denied', message: 'Allow notifications in Settings.' }), retryPushNotifications: () => retried++ },
    './SettingsUI': { SettingsGroup: host('group'), SettingsButton: host('button'), SettingsNotice: host('notice') },
  });
  const { NotificationSettings } = load(resolve(__dirname, '../components/settings/NotificationSettings.tsx'));
  let renderer;
  act(() => { renderer = create(React.createElement(NotificationSettings)); });
  t.after(() => act(() => renderer.unmount()));
  const button = label => renderer.root.findAllByType('button').find(node => node.props.label === label);
  await act(async () => { button('Notification settings').props.onPress(); await flush(); });
  act(() => button('Retry notifications').props.onPress());
  assert.deepEqual(intents, [['android.settings.APP_NOTIFICATION_SETTINGS', [{ key: 'android.provider.extra.APP_PACKAGE', value: 'com.jarvis.app' }]]]);
  assert.equal(retried, 1);
  assert.equal(renderer.root.findByType('notice').props.tone, 'error');
});


test('rotating an Expo token retires the previous server registration', async t => {
  const app = await harness(t, { permission: 'granted' });
  await app.rotate();
  assert.ok(app.state.unregistered.some(entry => entry.body.token === 'ExponentPushToken[initial]'));
});

test('a late registration cannot replace refreshed credentials used to clean up after sign-out', async t => {
  let release;
  const pending = new Promise(done => release = done);
  const app = await harness(t, { permission: 'granted', onRegister: async (_body, token) => { if (token === 'session') await pending; } });
  await app.auth('refreshed-session');
  await act(async () => { release(); for (let i = 0; i < 8; i++) await flush(); });
  await app.auth(null);
  assert.equal(app.state.unregistered.at(-1).token, 'refreshed-session');
});
