import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPlaybackTime, playbackPosition, readPlaybackState } from '../src/spotify/playerState.ts';
const playing = {
  paused: false, position: 12_000, duration: 180_000, repeat_mode: 2, shuffle: true,
  disallows: { seeking: true, skipping_next: false },
  track_window: { current_track: {
    uri: 'spotify:track:test', name: ' Song ', artists: [{ name: ' First ' }, { name: 'Second' }],
    album: { name: ' Album ', images: [{ url: '' }, { url: 'https://example.com/cover.jpg' }] },
  } },
};
test('SDK track metadata is normalized independently of transport state', () => {
  const state = readPlaybackState(playing);
  assert.deepEqual(state.track, { uri: 'spotify:track:test', title: 'Song', artist: 'First, Second', album: 'Album', image: 'https://example.com/cover.jpg' });
  assert.equal(state.repeat, 'track'); assert.equal(state.shuffle, true);
  assert.deepEqual(state.disallows, { seeking: true });
});
test('idle and incomplete SDK states remain safe for disabled controls', () => {
  assert.equal(readPlaybackState(null).track, null);
  assert.equal(readPlaybackState(null).paused, true);
  assert.equal(readPlaybackState({ position: NaN, duration: Infinity }).duration, 0);
  assert.equal(readPlaybackState({ duration: 1000, position: 9000 }).position, 1000);
  assert.equal(readPlaybackState({ duration: 1000, position: -30 }).position, 0);
  assert.equal(readPlaybackState({ track_window: { current_track: {} } }).track, null);
});
test('progress advances between SDK events and clamps at the end of a track', () => {
  const state = readPlaybackState(playing);
  assert.equal(playbackPosition(state, 100_000, 103_450), 15_450);
  assert.equal(playbackPosition(state, 100_000, 900_000), 180_000);
  assert.equal(playbackPosition(state, 100_000, 99_000), 12_000);
  assert.equal(playbackPosition({ ...state, paused: true }, 100_000, 103_450), 12_000);
  assert.equal(playbackPosition(state, 0, 103_450), 12_000);
});
test('time labels are readable and never expose invalid SDK numbers', () => {
  assert.equal(formatPlaybackTime(83_900), '1:23');
  assert.equal(formatPlaybackTime(3_600_000), '60:00');
  assert.equal(formatPlaybackTime(-1), '0:00');
  assert.equal(formatPlaybackTime(NaN), '0:00');
});
