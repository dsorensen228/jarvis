import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { addRecentSearch } from '../src/spotify/SpotifyBrowseContext.tsx';
import { normalizeFavorites, validateFavorite } from '../src/spotify/SpotifyFavoritesContext.tsx';
import { editSearchText } from '../src/spotify/searchText.ts';
import { OnScreenKeyboard } from '../src/ui/OnScreenKeyboard.tsx';

const favorite = {
  uri: 'spotify:track:abc123', name: 'The Song', subtitle: 'Artist',
  image: 'https://i.scdn.co/image/abc123', kind: 'track',
};

test('touch keyboard inserts and removes text at the selection instead of the end', () => {
  assert.deepEqual(editSearchText('pink floyd', 4, 4, ' moon'), { value: 'pink moon floyd', caret: 9 });
  assert.deepEqual(editSearchText('pink floyd', 0, 4, 'nick'), { value: 'nick floyd', caret: 4 });
  assert.deepEqual(editSearchText('pink floyd', 0, 5, null), { value: 'floyd', caret: 0 });
  assert.deepEqual(editSearchText('pink floyd', 5, 5, null), { value: 'pinkfloyd', caret: 4 });
});

test('touch backspace preserves surrogate pairs and handles the start of text', () => {
  assert.deepEqual(editSearchText('a🎵b', 3, 3, null), { value: 'ab', caret: 1 });
  assert.deepEqual(editSearchText('music', 0, 0, null), { value: 'music', caret: 0 });
});

test('recent searches are trimmed, deduplicated ignoring case, most-recent-first and bounded', () => {
  assert.deepEqual(addRecentSearch(['Jazz', 'Rock'], '  jazz  '), ['jazz', 'Rock']);
  assert.deepEqual(addRecentSearch(['Jazz'], ' '), ['Jazz']);
  assert.deepEqual(addRecentSearch(['a', 'b', 'c', 'd', 'e', 'f'], 'new'), ['new', 'a', 'b', 'c', 'd', 'e']);
});

test('stored favorites reject unsupported URIs and malformed items', () => {
  for (const value of [null, 'song', {}, { ...favorite, uri: 'https://example.com' },
    { ...favorite, uri: 'spotify:episode:abc123' }, { ...favorite, name: '' }]) {
    assert.equal(validateFavorite(value), null);
  }
  assert.equal(validateFavorite({ ...favorite, image: 'javascript:alert(1)' })?.image, null);
  assert.equal(validateFavorite({ ...favorite, kind: 'playlist' })?.kind, 'track');
});

test('stored favorites are deduplicated and limited to 24 safe quick picks', () => {
  const stored = [favorite, favorite, null, ...Array.from({ length: 30 }, (_, index) => ({
    ...favorite, uri: `spotify:album:id${index}`, name: `Album ${index}`,
  }))];
  const normalized = normalizeFavorites(stored);
  assert.equal(normalized.length, 24);
  assert.equal(new Set(normalized.map((item) => item.uri)).size, 24);
  assert.equal(normalized[0].name, 'The Song');
  assert.equal(normalized[1].kind, 'album');
  assert.deepEqual(normalizeFavorites({ malicious: true }), []);
});

test('keyboard exposes optional search and dismiss actions without altering TV defaults', () => {
  const props = { open: true, onChar: () => undefined, onBackspace: () => undefined };
  const existing = renderToStaticMarkup(<OnScreenKeyboard {...props} />);
  assert.doesNotMatch(existing, /Hide keyboard|>Search</);
  const searchable = renderToStaticMarkup(<OnScreenKeyboard {...props} onSubmit={() => undefined} onDismiss={() => undefined} submitDisabled />);
  assert.match(searchable, /aria-label="Hide keyboard"/);
  assert.match(searchable, /aria-label="Search" disabled=""/);
});
