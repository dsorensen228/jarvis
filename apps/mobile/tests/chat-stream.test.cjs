const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');

// Use the app's existing TypeScript compiler, without another test runtime dependency.
const filename = resolve(__dirname, '../lib/api-client/chat-stream.ts');
const loaded = new Module(filename, module);
loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { requestChatStream } = loaded.exports;

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1/chat/stream`;
}

function request(url, options = {}) {
  return { url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Hi' }),
    transport: 'fetch', timeoutMs: 2000, onEvent() {}, ...options };
}

test('streams split UTF-8 and CRLF frames before the response finishes, preserving message metadata', async (t) => {
  let finishResponse;
  const ready = new Promise((resolve) => { finishResponse = resolve; });
  const url = await serverFor(t, async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(': heartbeat\r\n\r\nevent: response.text.delta\r\ndata: {"text":"Hi ☀"}\r\n\r\n');
    const unicodeIndex = bytes.indexOf(Buffer.from('☀'));
    res.write(bytes.subarray(0, unicodeIndex + 1));
    setImmediate(() => res.write(bytes.subarray(unicodeIndex + 1)));
    await ready;
    res.end('event: message.created\ndata: {"id":"m2","role":"assistant","content":"Hi ☀","created_at":"now","metadata":{"sources":[{"url":"https://example.com"}],"tool_calls":[{"id":"tool-1","name":"web_search","status":"completed"}]}}\n\nevent: response.done\ndata: {"conversation_id":"c1","message_id":"m2"}\n\n');
  });
  const events = [];
  const result = await requestChatStream(request(url, { onEvent(event) {
    events.push(event);
    if (event.type === 'response.text.delta') finishResponse();
  } }));
  assert.equal(events[0].data.text, 'Hi ☀');
  assert.equal(result.response, 'Hi ☀');
  assert.equal(result.conversation_id, 'c1');
  assert.deepEqual(result.assistant_message.sources, [{ url: 'https://example.com' }]);
  assert.equal(result.assistant_message.tool_calls[0].name, 'web_search');
});

test('stopping after a partial response rejects with AbortError and never replays the POST', async (t) => {
  let posts = 0;
  const url = await serverFor(t, (_req, res) => {
    posts += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.text.delta\ndata: {"text":"Partial"}\n\n');
  });
  const controller = new AbortController();
  const received = [];
  await assert.rejects(requestChatStream(request(url, { signal: controller.signal, onEvent(event) {
    received.push(event.type);
    controller.abort();
  } })), { name: 'AbortError' });
  assert.deepEqual(received, ['response.text.delta']);
  assert.equal(posts, 1);
});

test('a pre-aborted request sends no POST', async (t) => {
  let posts = 0;
  const url = await serverFor(t, (_req, res) => { posts += 1; res.end(); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestChatStream(request(url, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(posts, 0);
});

test('a disconnected stream is an error rather than a successful truncated answer or replay', async (t) => {
  let posts = 0;
  const url = await serverFor(t, (_req, res) => {
    posts += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: response.text.delta\ndata: {"text":"Partial"}\n\n');
  });
  await assert.rejects(requestChatStream(request(url)), /ended before/i);
  assert.equal(posts, 1);
});

test('a server error event reaches the UI and rejects the request without replay', async (t) => {
  let posts = 0;
  const url = await serverFor(t, (_req, res) => {
    posts += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: error\ndata: {"detail":"Model unavailable"}\n\n');
  });
  const events = [];
  await assert.rejects(requestChatStream(request(url, { onEvent: (event) => events.push(event) })), /Model unavailable/);
  assert.equal(events[0].type, 'error');
  assert.equal(posts, 1);
});

test('non-success HTTP responses retain status for the authentication boundary', async (t) => {
  const url = await serverFor(t, (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"detail":"Session expired"}');
  });
  await assert.rejects(requestChatStream(request(url)), { name: 'ChatStreamHttpError', status: 401, message: 'API 401: Session expired' });
});

test('a stalled response times out while reading its body', async (t) => {
  const url = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': heartbeat\n\n');
  });
  await assert.rejects(requestChatStream(request(url, { timeoutMs: 30 })), /timed out/i);
});

// Native XHR is unavailable in Node. This boundary fixture exposes cumulative text and
// both progress callbacks, matching React Native's XMLHttpRequest event contract.
function installXhr(t, send) {
  const original = global.XMLHttpRequest;
  const calls = [];
  const instances = [];
  global.XMLHttpRequest = class {
    status = 200;
    readyState = 0;
    responseText = '';
    aborted = false;
    constructor() { instances.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send(body) { calls.push({ method: this.method, body }); queueMicrotask(() => send(this)); }
    abort() { this.aborted = true; this.onabort?.(); }
    chunk(text) {
      this.responseText += text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.onprogress?.();
    }
    finish() { this.readyState = 4; this.onload?.(); }
  };
  t.after(() => { global.XMLHttpRequest = original; });
  return { calls, instances };
}

test('native progress consumes cumulative response text once across split CRLF and multiline events', async (t) => {
  const { calls } = installXhr(t, (xhr) => {
    xhr.chunk('\uFEFF: heartbeat\r');
    xhr.chunk('\n\r\nevent: response.text.delta\r\ndata: {\r\ndata: "text":"Native"}\r');
    xhr.chunk('\n\r');
    xhr.chunk('\nevent: future.event\ndata: not JSON\n\nevent: response.done\ndata: {"conversation_id":"c-native"}\n\n');
    xhr.finish();
  });
  const events = [];
  const result = await requestChatStream(request('https://jarvis.test/v1/chat/stream', { transport: 'xhr', onEvent: (event) => events.push(event) }));
  assert.deepEqual(events.map((event) => event.type), ['response.text.delta', 'response.done']);
  assert.equal(result.response, 'Native');
  assert.equal(result.conversation_id, 'c-native');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

test('native stop aborts its request and prevents subsequent frames from reaching the UI', async (t) => {
  const controller = new AbortController();
  const { calls, instances } = installXhr(t, (xhr) => {
    xhr.chunk('event: response.text.delta\ndata: {"text":"First"}\n\n');
    xhr.chunk('event: response.text.delta\ndata: {"text":"Late"}\n\n');
    xhr.finish();
  });
  const received = [];
  await assert.rejects(requestChatStream(request('https://jarvis.test/v1/chat/stream', {
    transport: 'xhr', signal: controller.signal, onEvent(event) {
      received.push(event.data.text);
      controller.abort();
    },
  })), { name: 'AbortError' });
  assert.deepEqual(received, ['First']);
  assert.equal(instances[0].aborted, true);
  assert.equal(calls.length, 1);
});
