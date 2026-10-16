import { expect, test, type Page } from '@playwright/test';

const conversations = [
  { id: 'plans', title: 'Weekend plans', source: 'chat', message_count: 2, updated_at: '2026-10-14T12:00:00Z' },
  { id: 'shopping', title: 'Shopping list', source: 'chat', message_count: 2, updated_at: '2026-10-13T12:00:00Z' },
  { id: 'legacy', title: 'Older conversation', message_count: 2, updated_at: '2026-10-12T12:00:00Z' },
  { id: 'voice-call', title: 'Voice conversation', source: 'voice', message_count: 2, updated_at: '2026-10-14T13:00:00Z' },
];

async function mockChatApi(page: Page, history = conversations) {
  await page.addInitScript(() => {
    localStorage.setItem('@jarvis_app/refreshToken', 'test-only');
    window.__RUNTIME_EXPO_PUBLIC__ = { EXPO_PUBLIC_API_URL: location.origin };
  });
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/refresh') return route.fulfill({ json: { access_token: token, refresh_token: 'test-only' } });
    if (path === '/v1/users/me') return route.fulfill({ json: { id: 'test', name: 'Test', settings: {} } });
    if (path === '/v1/conversations') return route.fulfill({ json: history });
    const conversation = history.find(item => path === `/v1/conversations/${item.id}`);
    if (conversation) return route.fulfill({ json: {
      ...conversation,
      messages: [{ id: `${conversation.id}-answer`, role: 'assistant', content: `Saved answer for ${conversation.title}`, created_at: conversation.updated_at }],
    } });
    if (path === '/v1/conversations/stream-test') return route.fulfill({ json: { id: 'stream-test', title: 'test', messages: [{ id: 'user-test', role: 'user', content: 'test', created_at: '2026-10-14T12:00:00Z' }] } });
    return route.fulfill({ json: [] });
  });
}

async function openChat(page: Page) {
  await page.goto('/');
  if (page.viewportSize()!.width < 1180) await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByText('Chat', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Jarvis' })).toBeVisible();
}

async function mockChatStream(page: Page, initialText = '') {
  await page.addInitScript(initialText => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (!String(input).endsWith('/v1/chat/stream')) return original(input, init);
      const encoder = new TextEncoder();
      const { message } = JSON.parse(String(init?.body));
      const conversation = { id: 'stream-test', title: 'test', message_count: 1, source: 'chat', updated_at: '2026-10-14T12:00:00Z' };
      return new Response(new ReadableStream({ start(controller) {
        const event = (type: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        event('conversation.updated', conversation);
        event('message.created', { id: 'user-test', conversation_id: conversation.id, role: 'user', content: message, created_at: conversation.updated_at });
        event('response.status', { status: 'thinking', label: 'Thinking' });
        if (initialText) event('response.text.delta', { text: initialText });
        (window as any).__emitChatEvent = event;
        (window as any).__appendChatText = (text: string) => event('response.text.delta', { text });
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
      }}), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, initialText);
}

test('conversation dropdown opens, switches history, dismisses, and starts a new chat', async ({ page }) => {
  await mockChatApi(page);
  await openChat(page);
  const choose = page.getByRole('button', { name: 'Choose conversation', exact: true, includeHidden: true });
  const plans = page.getByRole('button', { name: 'Open conversation: Weekend plans', exact: true });
  const shopping = page.getByRole('button', { name: 'Open conversation: Shopping list', exact: true });

  // History stays out of the thread until requested, including on desktop.
  await expect(choose).toBeVisible();
  await expect(choose).toHaveAttribute('aria-expanded', 'false');
  await expect(plans).toHaveCount(0);
  await choose.click();
  await expect(choose).toHaveAttribute('aria-expanded', 'true');
  await expect(plans).toBeVisible();
  await expect(shopping).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open conversation: Older conversation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open conversation: Voice conversation', exact: true })).toHaveCount(0);
  await plans.click();
  await expect(page.getByText('Saved answer for Weekend plans', { exact: true })).toBeVisible();
  await expect(choose).toContainText('Weekend plans');
  await expect(choose).toHaveAttribute('aria-expanded', 'false');
  await expect(plans).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Message Jarvis' }).fill('An unsent draft');
  await choose.click();
  await shopping.click();
  await expect(page.getByText('Saved answer for Shopping list', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved answer for Weekend plans', { exact: true })).toHaveCount(0);
  await expect(choose).toContainText('Shopping list');
  await expect(page.getByRole('textbox', { name: 'Message Jarvis' })).toHaveValue('');

  await choose.click();
  await expect(plans).toBeVisible();
  await page.getByRole('button', { name: 'Close conversations', exact: true }).click({ position: { x: 5, y: 5 } });
  await expect(plans).toHaveCount(0);
  await expect(page.getByText('Saved answer for Shopping list', { exact: true })).toBeVisible();

  await choose.click();
  await expect(plans).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(plans).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message Jarvis' }).fill('Another unsent draft');
  await page.getByRole('button', { name: 'Start new conversation', exact: true }).click();
  await expect(page.getByText('Saved answer for Shopping list', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Jarvis' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
});

test('long conversation history scrolls and remains searchable with a shorter viewport', async ({ page }) => {
  await mockChatApi(page, Array.from({ length: 30 }, (_, index) => ({
    id: `history-${index}`, title: `Conversation ${index}`, message_count: 2, updated_at: '2026-10-14T12:00:00Z',
  })));
  await openChat(page);
  await page.getByRole('button', { name: 'Choose conversation', exact: true }).click();
  const first = page.getByRole('button', { name: 'Open conversation: Conversation 0', exact: true });
  const last = page.getByRole('button', { name: 'Open conversation: Conversation 29', exact: true });
  await expect(first).toBeInViewport();
  await expect(last).not.toBeInViewport();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();

  const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
  await search.fill('Conversation 29');
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 550 });
  await expect(search).toBeVisible();
  await expect(last).toBeInViewport();
  await expect(first).toHaveCount(0);
  await last.click();
  await expect(page.getByText('Saved answer for Conversation 29', { exact: true })).toBeVisible();
});

test('live activity stays compact until tool details are requested', async ({ page }) => {
  await mockChatApi(page, []);
  await mockChatStream(page);
  await openChat(page);
  await page.getByRole('textbox', { name: 'Message Jarvis' }).fill('test');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Thinking…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Show activity/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose conversation', exact: true })).toBeDisabled();

  await page.evaluate(() => (window as any).__emitChatEvent('tool.started', { id: 'search', name: 'search_documents' }));
  const showActivity = page.getByRole('button', { name: /Show activity/ });
  await expect(showActivity).toContainText('Search documents');
  await expect(showActivity).toHaveAttribute('aria-expanded', 'false');
  await showActivity.click();
  const hideActivity = page.getByRole('button', { name: /Hide activity/ });
  await expect(hideActivity).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('running', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Search documents running/ })).toHaveCount(0);

  await page.evaluate(() => (window as any).__emitChatEvent('tool.finished', {
    id: 'search', name: 'search_documents', status: 'completed', result: 'Found the requested document', duration_ms: 25,
  }));
  await expect(page.getByText('Found the requested document', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Search documents completed.*Show result/ }).click();
  await expect(page.getByText('Found the requested document', { exact: true })).toBeVisible();
  await hideActivity.click();
  await expect(page.getByText('Found the requested document', { exact: true })).toHaveCount(0);
  await expect(showActivity).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});

test('quiet new chat renders partial text before completion and can stop', async ({ page }) => {
  await mockChatApi(page, []);
  await mockChatStream(page, 'First words arrive now');
  await openChat(page);
  await expect(page.getByRole('button', { name: 'Deep research', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: 'Message Jarvis' });
  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('Second line');
  await expect(composer).toHaveValue('First line\nSecond line');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await composer.press('Enter');
  await expect(page.getByText('First words arrive now', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  // Growth and a keyboard-sized viewport resize must keep the newest text visible.
  await page.evaluate(() => (window as any).__appendChatText('\n\n' + Array.from({ length: 60 }, (_, i) => `Streaming line ${i}`).join('\n\n') + '\n\nNewest streamed text'));
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 550 });
  await expect(page.getByText('Newest streamed text', { exact: true })).toBeInViewport();
  // Deliberately scrolling up suspends following until Latest is pressed.
  await page.getByText('Newest streamed text', { exact: true }).hover();
  await page.mouse.wheel(0, -1000);
  await expect(page.getByRole('button', { name: 'Jump to latest message' })).toBeVisible();
  await page.evaluate(() => (window as any).__appendChatText('\n\nArrived while reading history'));
  await expect(page.getByText('Arrived while reading history', { exact: true })).not.toBeInViewport();
  await page.getByRole('button', { name: 'Jump to latest message' }).click();
  await expect(page.getByText('Arrived while reading history', { exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(page.getByText(/Response interrupted/)).toBeVisible();
});
