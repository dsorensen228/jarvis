import { test, expect } from '@playwright/test';
import { setupSpotify, item } from './spotify-fixture';

test('now playing shows artwork, live progress, and working pause/seek controls', async ({ page }) => {
  await setupSpotify(page);
  await page.goto('/#/spotify');
  await expect(page.getByText('Night Drive', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const seek = page.getByRole('slider', { name: /Playback position/i });
  await seek.focus();
  await seek.press('ArrowRight');
  await seek.press('Tab');
  await expect.poll(() => page.evaluate(() => (window as any).__sdkCalls.filter((c: any) => Array.isArray(c) && c[0] === 'seek').length)).toBeGreaterThan(0);
  const nav = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  for (const label of ['Play', 'Previous track', 'Next track']) {
    const box = await page.getByRole('button', { name: label, exact: true }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('search survives navigation and plays on the exact local SDK device', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify/search');
  const search = page.getByRole('searchbox');
  await search.fill('Night Drive');
  await search.press('Enter');
  await expect(page.getByRole('button', { name: /Play track Night Drive by/ })).toBeVisible();
  await page.getByRole('button', { name: /Play track Night Drive by/ }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/player/play')).length).toBe(1);
  expect(requests.find(r => r.path.endsWith('/player/play'))!.body).toMatchObject({ spotify_uri: item().uri, device_id: 'office-sdk-id' });
  await page.getByRole('link', { name: 'Music', exact: true }).click();
  await page.getByRole('link', { name: /Search|Find music/ }).first().click();
  await expect(search).toHaveValue('Night Drive');
  await expect(page.getByRole('button', { name: /Play track Night Drive by/ })).toBeVisible();
});

test('newer searches win when a previous request finishes late', async ({ page }) => {
  await setupSpotify(page);
  let releaseFirst!: () => void;
  const firstWait = new Promise<void>((r) => { releaseFirst = r; });
  await page.route('**/api/spotify/search?**', async route => {
    const q = new URL(route.request().url()).searchParams.get('q')!;
    if (q === 'First') await firstWait;
    await route.fulfill({ json: { items: [item(q)] } }).catch(() => {});
  });
  await page.goto('/#/spotify/search');
  const search = page.getByRole('searchbox');
  await search.fill('First'); await search.press('Enter');
  await search.fill('Second'); await search.press('Enter');
  await expect(page.getByRole('button', { name: /Play track Second by/ })).toBeVisible();
  releaseFirst();
  await expect(page.getByRole('button', { name: /Play track First by/ })).toHaveCount(0);
});

test('clearing an in-flight search cannot restore stale results', async ({ page }) => {
  await setupSpotify(page);
  let release!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  await page.route('**/api/spotify/search?**', async route => {
    await waiting;
    await route.fulfill({ json: { items: [item('Obsolete')] } }).catch(() => {});
  });
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Obsolete');
  await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: /Clear search/i }).click();
  release();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByRole('button', { name: /Play track Obsolete by/ })).toHaveCount(0);
});

test('type filters search artists and empty/error states are actionable', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Midnight');
  await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: 'Artists', exact: true }).click();
  await expect(page.getByRole('button', { name: /Play (track|artist) Midnight by/ })).toBeVisible();
  await page.route('**/api/spotify/search?**', route => route.fulfill({ json: { items: [] } }));
  await page.getByRole('searchbox').fill('Nothing'); await page.getByRole('searchbox').press('Enter');
  await expect(page.getByText(/No (results|matches)/i)).toBeVisible();
  await page.route('**/api/spotify/search?**', route => route.fulfill({ status: 502, json: { detail: 'Spotify is unavailable. Try again shortly.' } }));
  await page.getByRole('searchbox').fill('Failure'); await page.getByRole('searchbox').press('Enter');
  await expect(page.getByText('Spotify is unavailable. Try again shortly.')).toBeVisible();
  expect(requests.some(r => r.path === '/api/spotify/disconnect')).toBe(false);
});

test('play requests are serialized across tiles and transport', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.route('**/api/spotify/search?**', route => route.fulfill({ json: { items: [item('First'), item('Second')] } }));
  let release!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  let count = 0;
  await page.route('**/api/spotify/player/play', async route => { count++; await waiting; await route.fulfill({ json: { ok: true } }); });
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Songs'); await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: /Play track First by/ }).click();
  await expect(page.getByRole('button', { name: /Play track Second by/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  expect(count).toBe(1);
  release();
  await expect(page.getByRole('button', { name: /Play track Second by/ })).toBeEnabled();
  expect(requests.some(r => r.path === '/api/spotify/disconnect')).toBe(false);
});

test('temporary SDK failure preserves sign-in and reconnects with Retry', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__emitSpotify('not_ready', { device_id: 'office-sdk-id' }));
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /Retry/ }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  expect(requests.some(r => r.path === '/api/spotify/disconnect')).toBe(false);
});

test('SDK script failure is recoverable without signing the device out', async ({ page }) => {
  const requests = await setupSpotify(page, { scriptFailure: true });
  await page.goto('/#/spotify');
  await expect(page.getByRole('button', { name: /Retry/ })).toBeVisible();
  expect(requests.some(r => r.path === '/api/spotify/disconnect')).toBe(false);
  await page.evaluate(() => { const w = window as any; w.Spotify = { Player: w.__SpotifyPlayer }; });
  await page.getByRole('button', { name: /Retry/ }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
});

test('startup timeout preserves credentials and recovers', async ({ page }) => {
  const requests = await setupSpotify(page, { delayed: true });
  await page.clock.install();
  await page.goto('/#/spotify');
  await expect.poll(() => page.evaluate(() => (window as any).__players.length)).toBeGreaterThan(0);
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('button', { name: /Retry/ })).toBeVisible();
  expect(requests.some(r => r.path === '/api/spotify/disconnect')).toBe(false);
  await page.evaluate(() => { (window as any).__delayReady = false; });
  await page.getByRole('button', { name: /Retry/ }).click();
  await page.clock.runFor(100);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
});

test('transport restrictions are respected', async ({ page }) => {
  await setupSpotify(page);
  await page.goto('/#/spotify');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.evaluate(() => { const w = window as any; w.__emitSpotify('player_state_changed', { ...w.__state, disallows: { seeking: true, skipping_next: true, skipping_prev: true, pausing: true, toggling_shuffle: true, toggling_repeat_track: true, toggling_repeat_context: true } }); });
  for (const name of ['Pause', 'Next track', 'Previous track']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('slider', { name: /Playback position/i })).toBeDisabled();
});

test('favorites persist across reload and can start playback from Now Playing', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Saved Song'); await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: /Save Saved Song to favorites/ }).click();
  await page.reload();
  await page.getByRole('link', { name: 'Music', exact: true }).click();
  await expect(page.getByRole('button', { name: /Play Saved Song/ })).toBeVisible();
  await page.getByRole('button', { name: /Play Saved Song/ }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/player/play')).length).toBe(1);
});

test('queue addition keeps playback and Up Next displays track order', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Queued Song'); await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: /Add Queued Song to queue/ }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/player/queue') && r.method === 'POST').length).toBe(1);
  expect(requests.find(r => r.path.endsWith('/player/queue') && r.method === 'POST')!.body).toMatchObject({ uri: item('Queued Song').uri, device_id: 'office-sdk-id' });
  expect(requests.filter(r => r.path.endsWith('/player/play'))).toHaveLength(0);
  await page.goto('/#/spotify/queue');
  await expect(page.getByRole('list', { name: 'Upcoming tracks' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Upcoming tracks' }).getByRole('listitem').first()).toContainText('Next Song');
});

test('queue does not display another active Spotify device', async ({ page }) => {
  await setupSpotify(page);
  await page.route('**/api/spotify/player/queue?**', route => route.fulfill({ json: { active: false, currently_playing: null, items: [] } }));
  await page.goto('/#/spotify/queue');
  await expect(page.getByText('Start something here')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Upcoming tracks' })).toHaveCount(0);
});

test('shuffle and repeat changes target only this player', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify');
  await page.getByRole('button', { name: /shuffle/i }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/player/options')).length).toBe(1);
  await page.getByRole('button', { name: /repeat/i }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/player/options')).length).toBe(2);
  const bodies = requests.filter(r => r.path.endsWith('/player/options')).map(r => r.body);
  expect(bodies[0]).toMatchObject({ device_id: 'office-sdk-id', shuffle: true });
  expect(bodies[1]).toMatchObject({ device_id: 'office-sdk-id', repeat: 'context' });
});

test('empty player has a clear way to find music', async ({ page }) => {
  await setupSpotify(page, { empty: true });
  await page.goto('/#/spotify');
  await expect(page.getByRole('link', { name: /Find something to play|Search/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
});

test('explicit sign-out clears local history and ignores late SDK callbacks', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.getByLabel('Spotify account menu').click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect.poll(() => requests.filter(r => r.path === '/api/spotify/disconnect').length).toBe(1);
  await page.evaluate(() => { const w = window as any; w.__players.forEach((p: any) => { p.emit('ready', { device_id: 'stale' }); p.emit('player_state_changed', w.__state); }); });
  await expect(page.getByRole('button', { name: 'Connect Spotify', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
});

test('all saved favorites are reachable and removable without covering playback', async ({ page }) => {
  await setupSpotify(page);
  await page.addInitScript(() => localStorage.setItem('jarvis.spotify.favorites.v1', JSON.stringify(
    Array.from({ length: 9 }, (_, i) => ({ uri: `spotify:track:saved${i}`, name: `Saved ${i}`, subtitle: 'Artist', kind: 'track', image: null }))
  )));
  await page.goto('/#/spotify');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  const pauseBox = await page.getByRole('button', { name: 'Pause', exact: true }).boundingBox();
  const navBox = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  expect(pauseBox!.y + pauseBox!.height).toBeLessThanOrEqual(navBox!.y);
  await page.getByRole('button', { name: 'View 9 device favorites', exact: true }).click();
  await page.getByRole('button', { name: /Show all 9/ }).click();
  await expect(page.getByRole('button', { name: 'Play Saved 8', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Remove Saved 8 from device favorites/ }).click();
  await expect(page.getByRole('button', { name: 'Play Saved 8', exact: true })).toHaveCount(0);
});

test('a failed queue refresh retains the last queue with a retry', async ({ page }) => {
  await setupSpotify(page);
  await page.goto('/#/spotify/queue');
  await expect(page.getByText('Next Song', { exact: true })).toBeVisible();
  await page.route('**/api/spotify/player/queue?**', route => route.fulfill({ status: 502, json: { detail: 'Spotify is temporarily unavailable.' } }));
  await page.getByRole('button', { name: 'Refresh queue', exact: true }).click();
  await expect(page.getByText('Couldn’t refresh. Showing the last queue.')).toBeVisible();
  await expect(page.getByText('Next Song', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});

test('failed playback reports an error, unlocks controls, and never signs out', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.route('**/api/spotify/player/play', route => route.fulfill({ status: 502, json: { detail: 'This item cannot be played. Choose another.' } }));
  await page.goto('/#/spotify/search');
  await page.getByRole('searchbox').fill('Unavailable'); await page.getByRole('searchbox').press('Enter');
  await page.getByRole('button', { name: /Play track Unavailable by/ }).click();
  await expect(page.getByText('This item cannot be played. Choose another.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Play track Unavailable by/ })).toBeEnabled();
  await expect(page.getByText('✓ Playing Unavailable')).toHaveCount(0);
  expect(requests.some(r => r.path === '/api/spotify/disconnect')).toBe(false);
});

test('broken artwork recovers when Spotify switches to a different track', async ({ page }) => {
  await setupSpotify(page);
  await page.route('**/broken-cover.jpg', route => route.fulfill({ status: 404 }));
  await page.goto('/#/spotify');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.evaluate(() => { const w = window as any; const track = w.__state.track_window.current_track; w.__emitSpotify('player_state_changed', { ...w.__state, track_window: { current_track: { ...track, album: { ...track.album, images: [{ url: '/broken-cover.jpg' }] } } } }); });
  await expect(page.locator('.sp-now-art .spotify-disk-placeholder')).toBeVisible();
  await page.evaluate(() => { const w = window as any; const track = w.__state.track_window.current_track; w.__emitSpotify('player_state_changed', { ...w.__state, track_window: { current_track: { ...track, uri: 'spotify:track:Recovered', name: 'Recovered', album: { ...track.album, images: [{ url: '/test-cover.svg' }] } } } }); });
  await expect(page.locator('.sp-now-art img')).toBeVisible();
  await expect.poll(() => page.locator('.sp-now-art img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});

test('a full favorites list never silently discards an older saved item', async ({ page }) => {
  await setupSpotify(page);
  await page.addInitScript(() => localStorage.setItem('jarvis.spotify.favorites.v1', JSON.stringify(
    Array.from({ length: 24 }, (_, i) => ({ uri: `spotify:track:saved${i}`, name: `Saved ${i}`, subtitle: 'Artist', kind: 'track', image: null }))
  )));
  await page.goto('/#/spotify');
  await page.getByRole('button', { name: 'Save to device favorites', exact: true }).click();
  await expect(page.getByText('Your 24 favorites are full. Remove one before saving another.')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.spotify.favorites.v1')!));
  expect(saved).toHaveLength(24);
  expect(saved[23].name).toBe('Saved 23');
  await expect(page.getByRole('button', { name: 'Save to device favorites', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('late SDK option snapshots cannot undo successful rapid shuffle/repeat changes', async ({ page }) => {
  const requests = await setupSpotify(page);
  await page.goto('/#/spotify');
  const shuffle = page.getByRole('button', { name: /Turn shuffle/ });
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { const w = window as any; w.__emitSpotify('player_state_changed', { ...w.__state, shuffle: false }); });
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  const repeat = page.getByRole('button', { name: /^Repeat/ });
  for (const [mode, expectedLabel] of [['context', 'Repeat all'], ['track', 'Repeat one'], ['off', 'Repeat off']]) {
    await repeat.click();
    await expect(repeat).toHaveAttribute('aria-label', new RegExp(`^${expectedLabel}`));
    await page.evaluate(() => { const w = window as any; w.__emitSpotify('player_state_changed', { ...w.__state, repeat_mode: 0 }); });
    await expect(repeat).toHaveAttribute('aria-label', new RegExp(`^${expectedLabel}`));
    expect(requests.filter(r => r.path.endsWith('/player/options')).at(-1)!.body.repeat).toBe(mode);
  }
  await page.evaluate(() => { const w = window as any; w.__emitSpotify('player_state_changed', { ...w.__state, repeat_mode: 2 }); });
  await expect(repeat).toHaveAttribute('aria-label', /^Repeat off/);
});

test('option reconciliation expires so later external playback changes remain visible', async ({ page }) => {
  await setupSpotify(page);
  await page.clock.install();
  await page.goto('/#/spotify');
  const shuffle = page.getByRole('button', { name: /Turn shuffle/ });
  await expect(shuffle).toBeEnabled();
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { const w = window as any; w.__emitSpotify('player_state_changed', { ...w.__state, shuffle: false }); });
  await page.clock.runFor(6000);
  await expect(shuffle).toHaveAttribute('aria-pressed', 'false');
  await expect(shuffle).toBeEnabled();
});
