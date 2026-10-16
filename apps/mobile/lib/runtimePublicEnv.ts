/**
 * Hosted web can inject the API URL via /runtime-env.js (see docker-entrypoint-web.sh).
 */

export type RuntimeExpoPublicKey =
  | 'EXPO_PUBLIC_API_URL'
  | 'EXPO_PUBLIC_GOOGLE_CLIENT_ID'
  | 'EXPO_PUBLIC_APK_DOWNLOAD_URL';

declare global {
  interface Window {
    __RUNTIME_EXPO_PUBLIC__?: Partial<Record<RuntimeExpoPublicKey, string>>;
  }
}

export function getRuntimeExpoValue(key: RuntimeExpoPublicKey): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const v = window.__RUNTIME_EXPO_PUBLIC__?.[key];
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

export function getApiBaseUrl(): string {
  return (
    getRuntimeExpoValue('EXPO_PUBLIC_API_URL') ||
    (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_URL) ||
    'http://localhost:8000'
  );
}

export function getGoogleWebClientId(): string {
  return (
    getRuntimeExpoValue('EXPO_PUBLIC_GOOGLE_CLIENT_ID') ||
    (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID) ||
    ''
  );
}

export function getApkDownloadUrl(): string {
  return (
    getRuntimeExpoValue('EXPO_PUBLIC_APK_DOWNLOAD_URL') ||
    (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_APK_DOWNLOAD_URL) ||
    ''
  );
}

/** True when the configured API host is ngrok (free tier interstitial bypass). */
export function isNgrokApiHost(): boolean {
  try {
    return new URL(getApiBaseUrl()).hostname.includes('ngrok');
  } catch {
    return false;
  }
}

/** Extra HTTP headers for requests to ngrok tunnels (browser warning HTML bypass). */
export function ngrokSkipBrowserWarningHeaders(): Record<string, string> {
  return isNgrokApiHost() ? { 'ngrok-skip-browser-warning': 'true' } : {};
}
