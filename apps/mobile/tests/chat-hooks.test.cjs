const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadHook(name, mocks) {
  const filename = resolve(__dirname, `../components/jarvis/chat/${name}.ts`);
  const loaded = new Module(filename, module);
  loaded.require = (id) => id in mocks ? mocks[id] : require(id);
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports[name];
}

const conversation = (id) => ({ id, user_id: 'user-1', title: id, message_count: 0, created_at: 'now', updated_at: 'now' });
const userMessage = { id: 'saved-user-message', conversation_id: 'one', role: 'user', content: 'Hello', created_at: 'now' };

function streamHarness(t, initialConversation = conversation('one')) {
  let context, auth, hook, controls;
  const streams = [];
  let fullConversation = { ...conversation('one'), messages: [] };
  const useHook = loadHook('useChatStream', {
    '@/lib/api-client': {
      createConversation: async () => conversation('created'),
      getConversation: async () => fullConversation,
      postMessageStream(id, text, options) {
        const pending = deferred();
        streams.push({ id, text, options, ...pending });
        return pending.promise;
      },
    },
    '../../../contexts/ConversationContext': { useConversation: () => context },
    '../../../contexts/AuthContext': { useAuth: () => auth },
  });
  function Harness() {
    const [currentConversation, setCurrentConversation] = React.useState(initialConversation);
    const [conversations, setConversations] = React.useState(initialConversation ? [initialConversation] : []);
    const [messages, setMessages] = React.useState([]);
    const [error, setError] = React.useState(null);
    const [session, setSession] = React.useState({ accessToken: 'first-token', user: { id: 'user-1' } });
    auth = session;
    context = { currentConversation, setCurrentConversation, conversations, setConversations, messages, setMessages, error, setError };
    controls = { setSession, setCurrentConversation, setMessages };
    hook = useHook();
    return null;
  }
  let renderer;
  act(() => { renderer = create(React.createElement(Harness)); });
  t.after(() => act(() => renderer.unmount()));
  return {
    get hook() { return hook; }, get context() { return context; }, get controls() { return controls; }, streams,
    setFull(value) { fullConversation = value; },
    unmount() { act(() => renderer.unmount()); },
  };
}

test('new chats use one abortable stream and keep live output when the conversation acquires its ID', async (t) => {
  const app = streamHarness(t, null);
  let sending;
  await act(async () => { sending = app.hook.send({ text: 'Hello' }); });
  assert.equal(app.streams[0].id, undefined);
  act(() => {
    app.streams[0].options.onEvent({ type: 'conversation.updated', data: { ...conversation('one'), message_count: 1 } });
    app.streams[0].options.onEvent({ type: 'response.text.delta', data: { text: 'Working' } });
  });
  act(() => app.hook.reset());
  assert.equal(app.context.currentConversation.id, 'one');
  assert.equal(app.hook.answer, 'Working');
  assert.equal(app.hook.busy, true);
  await act(async () => { app.streams[0].resolve({ response: 'Working' }); await sending; });
});

test('account changes abort the old turn and ignore late events, errors, and draft restoration', async (t) => {
  const app = streamHarness(t);
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  act(() => {
    app.controls.setSession({ accessToken: 'other-token', user: { id: 'user-2' } });
    app.controls.setCurrentConversation(conversation('other-account'));
    app.controls.setMessages([]);
  });
  assert.equal(app.streams[0].options.signal.aborted, true);
  act(() => app.streams[0].options.onEvent({ type: 'message.created', data: userMessage }));
  let handled;
  await act(async () => { app.streams[0].reject(new Error('Old request failed')); handled = await sending; });
  assert.deepEqual(app.context.messages, []);
  assert.equal(app.context.currentConversation.id, 'other-account');
  assert.equal(app.context.error, null);
  assert.equal(app.hook.notice, null);
  assert.equal(handled, true, 'the caller must not restore the old account’s draft');
});

test('an abandoned turn cannot clear the busy state of a newer conversation turn', async (t) => {
  const app = streamHarness(t);
  let first, second;
  act(() => { first = app.hook.send({ text: 'Hello' }); });
  act(() => { app.controls.setCurrentConversation(conversation('two')); app.controls.setMessages([]); });
  act(() => { second = app.hook.send({ text: 'Another question' }); });
  assert.equal(app.streams.length, 2);
  await act(async () => { app.streams[0].reject(new Error('Aborted late')); await first; });
  assert.equal(app.hook.busy, true);
  act(() => app.hook.stop());
  assert.equal(app.streams[1].options.signal.aborted, true, 'stop still owns the second turn');
  await act(async () => { app.streams[1].reject(new Error('Stopped')); await second; });
});

test('stopping after server acceptance preserves partial text and labels unfinished tool activity', async (t) => {
  const app = streamHarness(t);
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  act(() => {
    app.streams[0].options.onEvent({ type: 'conversation.updated', data: { ...conversation('one'), message_count: 1 } });
    app.streams[0].options.onEvent({ type: 'message.created', data: userMessage });
    app.streams[0].options.onEvent({ type: 'tool.started', data: { id: 'tool', name: 'web_search', status: 'running' } });
    app.streams[0].options.onEvent({ type: 'response.text.delta', data: { text: 'Partial answer' } });
    app.hook.stop();
  });
  let accepted;
  await act(async () => { app.streams[0].reject(new Error('Aborted')); accepted = await sending; });
  assert.equal(accepted, true);
  assert.equal(app.hook.answer, '');
  assert.match(app.context.messages.at(-1).content, /Partial answer/);
  assert.match(app.hook.notice, /stopped/i);
  assert.equal(app.context.messages.at(-1).tool_calls[0].status, 'interrupted');
  assert.equal(app.context.messages[0].id, 'saved-user-message');
});

test('a lost acceptance event is reconciled from saved history before offering a retry', async (t) => {
  const app = streamHarness(t);
  app.setFull({ ...conversation('one'), message_count: 1, messages: [userMessage] });
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  let accepted;
  await act(async () => { app.streams[0].reject(new Error('Connection lost')); accepted = await sending; });
  assert.equal(accepted, true);
  assert.equal(app.context.messages[0].id, 'saved-user-message');
  assert.match(app.hook.notice, /saved/i);
});

test('a proxy failure is checked for a saved user turn instead of assuming the POST was rejected', async (t) => {
  const app = streamHarness(t);
  app.setFull({ ...conversation('one'), message_count: 1, messages: [userMessage] });
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  let accepted;
  const error = Object.assign(new Error('Gateway timeout'), { name: 'ChatStreamHttpError', status: 504 });
  await act(async () => { app.streams[0].reject(error); accepted = await sending; });
  assert.equal(accepted, true);
  assert.equal(app.context.messages[0].id, 'saved-user-message');
});

test('stopping between title and user-message events reconciles the optimistic message ID', async (t) => {
  const app = streamHarness(t);
  app.setFull({ ...conversation('one'), message_count: 1, messages: [userMessage] });
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  act(() => {
    app.streams[0].options.onEvent({ type: 'conversation.updated', data: { ...conversation('one'), message_count: 1 } });
    app.hook.stop();
  });
  await act(async () => { app.streams[0].reject(new Error('Stopped')); await sending; });
  assert.equal(app.context.messages[0].id, 'saved-user-message');
});

test('a fully saved assistant message is retained as complete if the connection drops after it arrives', async (t) => {
  const app = streamHarness(t);
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  const assistant = { ...userMessage, id: 'answer', role: 'assistant', content: 'Complete response' };
  act(() => {
    app.streams[0].options.onEvent({ type: 'message.created', data: userMessage });
    app.streams[0].options.onEvent({ type: 'message.created', data: assistant });
  });
  await act(async () => { app.streams[0].reject(new Error('Connection lost')); await sending; });
  assert.equal(app.context.messages.at(-1).content, 'Complete response');
  assert.equal(app.hook.notice, null);
  assert.equal(app.context.error, null);
});

test('refreshing the same account token does not stop an active response', async (t) => {
  const app = streamHarness(t);
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  act(() => app.controls.setSession({ accessToken: 'refreshed-token', user: { id: 'user-1' } }));
  assert.equal(app.streams[0].options.signal.aborted, false);
  assert.equal(app.hook.busy, true);
  await act(async () => { app.streams[0].resolve({ response: 'Done' }); await sending; });
});

function audioHarness(t, platform = 'web') {
  let hook;
  const requests = [];
  const errors = [];
  const files = new Set();
  const nativeSounds = [];
  let nextStop;
  const useHook = loadHook('useChatAudio', {
    'react-native': { Platform: { OS: platform } },
    'expo-file-system': {
      cacheDirectory: '/cache/', EncodingType: { Base64: 'base64' },
      writeAsStringAsync: async (uri) => { files.add(uri); },
      deleteAsync: async (uri) => { files.delete(uri); },
    },
    'expo-av': { Audio: { Sound: { createAsync: async ({ uri }) => {
      const stop = nextStop; nextStop = undefined;
      const sound = { uri, stopAsync: () => stop?.promise ?? Promise.resolve(), unloadAsync: async () => {}, playAsync: async () => {}, setOnPlaybackStatusUpdate() {} };
      nativeSounds.push(sound);
      return { sound };
    } } } },
    '@/lib/api-client': { fetchMessageTtsWav() { const pending = deferred(); requests.push(pending); return pending.promise; } },
    '../../../contexts/AuthContext': { useAuth: () => ({ accessToken: 'token', user: { id: 'user-1' } }) },
  });
  function Harness() { hook = useHook((error) => errors.push(error)); return null; }
  let renderer;
  act(() => { renderer = create(React.createElement(Harness)); });
  t.after(() => act(() => renderer.unmount()));
  return { get hook() { return hook; }, requests, errors, files, nativeSounds,
    delayNextStop(value) { nextStop = value; }, unmount() { act(() => renderer.unmount()); } };
}

test('a web play promise resolving after stop cannot revive playback state', async (t) => {
  const original = global.Audio;
  const playing = deferred();
  let audio;
  global.Audio = class { constructor() { audio = this; } play() { return playing.promise; } pause() { this.paused = true; } };
  t.after(() => { global.Audio = original; });
  const app = audioHarness(t);
  let speech;
  await act(async () => { speech = app.hook.speak({ ...userMessage, role: 'assistant' }); });
  await act(async () => app.requests[0].resolve(new ArrayBuffer(8)));
  await act(async () => app.hook.stop());
  await act(async () => { playing.resolve(); await speech; });
  assert.equal(app.hook.playing, null);
  assert.equal(app.hook.loading, null);
  assert.equal(audio.paused, true);
});

test('slow native cleanup cannot delete the next response’s audio file', async (t) => {
  const app = audioHarness(t, 'android');
  const stopFirst = deferred();
  app.delayNextStop(stopFirst);
  let first;
  await act(async () => { first = app.hook.speak({ ...userMessage, id: 'first', role: 'assistant' }); });
  await act(async () => { app.requests[0].resolve(new ArrayBuffer(8)); await first; });
  let cleanup, second;
  act(() => { cleanup = app.hook.stop(); });
  await act(async () => { second = app.hook.speak({ ...userMessage, id: 'second', role: 'assistant' }); });
  await act(async () => { app.requests[1].resolve(new ArrayBuffer(8)); await second; });
  const newUri = app.nativeSounds[1].uri;
  await act(async () => { stopFirst.resolve(); await cleanup; });
  assert.equal(app.hook.playing, 'second');
  assert.equal(app.files.has(newUri), true);
  assert.equal(app.files.has(app.nativeSounds[0].uri), false);
});

test('TTS resolving after unmount does not create a player or report an error', async (t) => {
  const app = audioHarness(t, 'android');
  let speech;
  await act(async () => { speech = app.hook.speak({ ...userMessage, role: 'assistant' }); });
  app.unmount();
  await act(async () => { app.requests[0].resolve(new ArrayBuffer(8)); await speech; });
  assert.equal(app.nativeSounds.length, 0);
  assert.deepEqual(app.errors, []);
});

test('an interrupted accepted turn adopts its durable assistant and task activity', async (t) => {
  const app = streamHarness(t);
  const tools = [{ id: 'call-1', name: 'create_research_task', status: 'completed', result: { id: 'research-1', status: 'running' } }];
  const assistant = { ...userMessage, id: 'saved-partial', role: 'assistant', content: 'Response interrupted.', tool_calls: tools, metadata: { interrupted: true } };
  app.setFull({ ...conversation('one'), message_count: 2, messages: [userMessage, assistant] });
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  act(() => {
    app.streams[0].options.onEvent({ type: 'message.created', data: userMessage });
    app.streams[0].options.onEvent({ type: 'tool.finished', data: tools[0] });
  });
  await act(async () => { app.streams[0].reject(new Error('Model failed')); await sending; });
  assert.equal(app.context.messages.at(-1).id, 'saved-partial');
  assert.deepEqual(app.context.messages.at(-1).tool_calls, tools);
  assert.deepEqual(app.hook.tools, [], 'canonical activity replaces the ephemeral copy');
});

test('stopping before server cleanup persists preserves a local partial across the next send', async (t) => {
  const app = streamHarness(t);
  const tool = { id: 'call-1', name: 'create_code_task', status: 'completed', result: { id: 'code-1', status: 'running' } };
  app.setFull({ ...conversation('one'), messages: [userMessage] });
  let first, second;
  act(() => { first = app.hook.send({ text: 'Hello' }); });
  act(() => {
    app.streams[0].options.onEvent({ type: 'message.created', data: userMessage });
    app.streams[0].options.onEvent({ type: 'tool.finished', data: tool });
    app.streams[0].options.onEvent({ type: 'response.text.delta', data: { text: 'Task started.' } });
    app.hook.stop();
  });
  await act(async () => { app.streams[0].reject(new Error('Stopped')); await first; });
  const partial = app.context.messages.at(-1);
  assert.match(partial.id, /^interrupted-/);
  assert.match(partial.content, /Task started/);
  assert.equal(partial.tool_calls[0].result.id, 'code-1');
  act(() => { second = app.hook.send({ text: 'What is next?' }); });
  assert.equal(app.context.messages.filter(message => message.id === partial.id).length, 1);
  assert.equal(app.context.messages.find(message => message.id === partial.id).tool_calls[0].result.id, 'code-1');
  const nextUser = { ...userMessage, id: 'next-user', content: 'What is next?' };
  const canonicalPartial = { ...partial, id: 'saved-partial' };
  app.setFull({ ...conversation('one'), messages: [userMessage, canonicalPartial, nextUser] });
  act(() => app.streams[1].options.onEvent({ type: 'message.created', data: nextUser }));
  await act(async () => { app.streams[1].reject(new Error('Disconnected')); await second; });
  assert.equal(app.context.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(app.context.messages.find(message => message.role === 'assistant').id, 'saved-partial');
  assert.ok(!app.context.messages.some(message => message.id === partial.id));
});

test('late interrupted-history recovery cannot replace another account’s transcript', async (t) => {
  const app = streamHarness(t);
  const history = deferred();
  app.setFull(history.promise);
  let sending;
  act(() => { sending = app.hook.send({ text: 'Hello' }); });
  act(() => app.streams[0].options.onEvent({ type: 'message.created', data: userMessage }));
  await act(async () => { app.streams[0].reject(new Error('Disconnected')); });
  act(() => {
    app.controls.setSession({ accessToken: 'other-token', user: { id: 'user-2' } });
    app.controls.setCurrentConversation(conversation('other-account'));
    app.controls.setMessages([]);
  });
  await act(async () => {
    history.resolve({ ...conversation('one'), messages: [userMessage] });
    await sending;
  });
  assert.deepEqual(app.context.messages, []);
  assert.equal(app.context.currentConversation.id, 'other-account');
});
