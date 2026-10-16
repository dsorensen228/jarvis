/** PKCE helpers for Spotify authorize redirect only; token exchange and refresh run on the device server. */

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => ('0' + b.toString(16)).slice(-2)).join('');
}

async function sha256base64url(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generatePkcePairAsync(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(48);
  const challenge = await sha256base64url(verifier);
  return { verifier, challenge };
}

export function getRedirectUri(): string {
  return `${window.location.origin}/spotify-callback.html`;
}

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

export function spotifyAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string
): string {
  const u = new URL('https://accounts.spotify.com/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', codeChallenge);
  return u.toString();
}
