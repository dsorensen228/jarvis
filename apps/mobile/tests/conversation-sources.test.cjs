const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

function loadTypeScript(relative, mocks = {}) {
  const filename = resolve(__dirname, relative);
  const loaded = new Module(filename, module);
  loaded.require = (id) => {
    if (id in mocks) return mocks[id];
    if (id === './chat-stream') return loadTypeScript('../lib/api-client/chat-stream.ts');
    return require(id);
  };
  loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

function loadClient() {
  return loadTypeScript('../lib/api-client/client.ts', {
    'react-native': { Platform: { OS: 'web' } },
    '../runtimePublicEnv': { getApiBaseUrl: () => 'https://jarvis.test', ngrokSkipBrowserWarningHeaders: () => ({}) },
  });
}

const conversation = (id, source) => ({ id, source, title: 'Voice chat', user_id: 'owner', created_at: 'now', updated_at: 'now' });

test('history asks for typed chats and excludes voice rows from search results', async (t) => {
  const requests = [];
  t.mock.method(global, 'fetch', async (url) => {
    requests.push(new URL(url));
    return new Response(JSON.stringify([
      conversation('voice', 'voice'), conversation('typed', 'chat'), conversation('legacy'),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const client = loadClient();
  assert.deepEqual((await client.getConversations('voice')).map(row => row.id), ['typed', 'legacy']);
  assert.equal(requests[0].searchParams.get('exclude_source'), 'voice');
});

test('clearing chat history requests the same exclusion as the visible list', async (t) => {
  let request;
  t.mock.method(global, 'fetch', async (url, options) => {
    request = { url: new URL(url), method: options.method };
    return new Response(JSON.stringify({ deleted: 2 }), { status: 200 });
  });
  assert.deepEqual(await loadClient().deleteAllConversations(), { deleted: 2 });
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url.searchParams.get('exclude_source'), 'voice');
});

test('a voice transcript opened by ID does not return to chat history', async (t) => {
  const voice = conversation('voice', 'voice');
  const typed = conversation('typed', 'chat');
  const provider = loadTypeScript('../contexts/ConversationContext.tsx', {
    '@/lib/api-client': { getConversations: async () => [typed], getConversation: async () => voice },
    'expo-router': { usePathname: () => '/' },
    './AuthContext': { useAuth: () => ({ accessToken: 'token', user: { id: 'owner' }, isLoading: false }) },
  });
  let context;
  function Probe() { context = provider.useConversation(); return null; }
  let renderer;
  await act(async () => { renderer = create(React.createElement(provider.ConversationProvider, null, React.createElement(Probe))); });
  t.after(() => act(() => renderer.unmount()));
  await act(async () => context.openConversationById('voice'));
  assert.deepEqual(context.conversations.map(row => row.id), ['typed']);
});
