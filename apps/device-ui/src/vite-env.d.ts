/// <reference types="vite/client" />

declare global {
  interface Window {
    Spotify?: typeof Spotify;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export {};
