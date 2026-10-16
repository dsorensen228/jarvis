/** postMessage payload from `app/gmail-oauth-complete` (must match that screen). */
export const JARVIS_GMAIL_OAUTH_MESSAGE_TYPE = 'jarvis-gmail-oauth';

export type JarvisGmailOAuthMessage = {
  type: typeof JARVIS_GMAIL_OAUTH_MESSAGE_TYPE;
  connected?: boolean;
  error?: string;
};

export function isJarvisGmailOAuthMessage(data: unknown): data is JarvisGmailOAuthMessage {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return o.type === JARVIS_GMAIL_OAUTH_MESSAGE_TYPE;
}
