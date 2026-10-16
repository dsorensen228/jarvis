const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');

const filename = resolve(__dirname, '../components/settings/DeviceStatus.ts');
const loaded = new Module(filename, module);
loaded._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { devicePurpose, deviceReportTime, deviceStatus, validateDeviceConnection } = loaded.exports;

test('device purpose preserves display and wearable records without calling them voice interfaces', () => {
  assert.equal(devicePurpose({ raw_kind: 'display', device_type: 'voice_interface' }), 'Display');
  assert.equal(devicePurpose({ raw_kind: 'wearable', device_type: 'voice_interface' }), 'Wearable');
  assert.equal(devicePurpose({ raw_kind: null, device_type: 'voice_interface' }), 'Device');
});

test('last report uses the newer reconnect or heartbeat and ignores invalid timestamps', () => {
  const recent = '2026-10-14T12:02:00Z';
  assert.equal(deviceReportTime({ last_seen_at: recent, last_heartbeat_at: '2026-10-14T12:01:00Z' }), new Date(recent).toLocaleString());
  assert.equal(deviceReportTime({ last_seen_at: recent, last_heartbeat_at: 'invalid' }), new Date(recent).toLocaleString());
  assert.equal(deviceReportTime({ last_seen_at: null, last_heartbeat_at: 'invalid' }), null);
});

test('reported connectivity stays distinct from camera readiness and unknown state', () => {
  const camera = { raw_kind: 'camera', device_type: 'camera', health: { ready: false } };
  assert.equal(deviceStatus({ ...camera, reported_connected: false }), 'Reported disconnected');
  assert.equal(deviceStatus({ ...camera, reported_connected: true }), 'Reported connected');
  assert.equal(deviceStatus({ ...camera, reported_connected: null }), 'Reported camera not ready');
  assert.equal(deviceStatus({ raw_kind: 'voice', reported_connected: null }), 'No connection report');
});

test('callback validation supports optional voice endpoints and complete camera URLs', () => {
  assert.equal(validateDeviceConnection('', false, ''), null);
  assert.equal(validateDeviceConnection('https://camera.local:8443/gateway/', true, ''), null);
  assert.match(validateDeviceConnection('', true, ''), /Enter the camera/);
  assert.match(validateDeviceConnection('ftp://camera.local', true, ''), /HTTP or HTTPS/);
  assert.match(validateDeviceConnection('https://user:password@camera.local', true, ''), /without a username or password/);
  assert.match(validateDeviceConnection('http://camera.local', true, 'short'), /16 characters/);
});
