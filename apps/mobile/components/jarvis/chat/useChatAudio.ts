import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import { fetchMessageTtsWav, type Message } from "@/lib/api-client";
import { useAuth } from "../../../contexts/AuthContext";

type Playback = {
  id: string;
  account: string | null;
  generation: number;
  phase: "loading" | "playing";
  sound: Audio.Sound | null;
  audio: HTMLAudioElement | null;
  resource: string | null;
};

async function dispose(playback: Playback | null) {
  if (!playback) return;
  // Capture only this playback's resources before awaiting cleanup of a native player.
  const { sound, audio, resource } = playback;
  playback.sound = null;
  playback.audio = null;
  playback.resource = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
  }
  if (sound) {
    sound.setOnPlaybackStatusUpdate(null);
    await sound.stopAsync().catch(() => {});
    await sound.unloadAsync().catch(() => {});
  }
  if (resource) {
    if (Platform.OS === "web") URL.revokeObjectURL(resource);
    else
      await FileSystem.deleteAsync(resource, { idempotent: true }).catch(
        () => {},
      );
  }
}

export function useChatAudio(onError: (error: string) => void) {
  const { accessToken, user } = useAuth();
  const account = accessToken ? (user?.id ?? accessToken) : null;
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const active = useRef<Playback | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const latest = useRef({ account, onError });
  latest.current = { account, onError };
  const owns = (playback: Playback) =>
    alive.current &&
    active.current === playback &&
    latest.current.account === playback.account;

  const stop = useCallback(async () => {
    generation.current += 1;
    const previous = active.current;
    active.current = null;
    if (alive.current) {
      setPlaying(null);
      setLoading(null);
    }
    await dispose(previous);
  }, []);

  const speak = async (message: Message) => {
    const id = message.id || message.created_at;
    if (active.current?.id === id && active.current.phase === "loading") return;
    const wasPlaying =
      active.current?.id === id && active.current.phase === "playing";
    const cleanup = stop();
    if (wasPlaying || !alive.current || !latest.current.account) {
      await cleanup;
      return;
    }
    // Reserve ownership before awaiting old-player cleanup; another click may supersede it.
    const playback: Playback = {
      id,
      account: latest.current.account,
      generation: generation.current,
      phase: "loading",
      sound: null,
      audio: null,
      resource: null,
    };
    active.current = playback;
    setLoading(id);
    try {
      await cleanup;
      if (!owns(playback)) return;
      const buffer = await fetchMessageTtsWav(message.content);
      if (!owns(playback)) return;
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(
          new Blob([buffer], { type: "audio/wav" }),
        );
        playback.resource = url;
        const audio = new globalThis.Audio(url);
        playback.audio = audio;
        audio.onended = () => {
          if (owns(playback)) void stop();
        };
        audio.onerror = () => {
          if (owns(playback)) {
            latest.current.onError("Unable to play this response.");
            void stop();
          }
        };
        await audio.play();
        if (!owns(playback)) {
          audio.pause();
          return;
        }
      } else {
        if (!FileSystem.cacheDirectory)
          throw new Error("Audio storage is unavailable.");
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let start = 0; start < bytes.length; start += 0x8000) {
          binary += String.fromCharCode(
            ...bytes.subarray(start, start + 0x8000),
          );
        }
        const uri = `${FileSystem.cacheDirectory}chat-speech-${Date.now()}-${playback.generation}.wav`;
        playback.resource = uri;
        await FileSystem.writeAsStringAsync(uri, btoa(binary), {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (!owns(playback)) {
          // A write completing after stop may have recreated a file already deleted by cleanup.
          await FileSystem.deleteAsync(uri, { idempotent: true }).catch(
            () => {},
          );
          return;
        }
        const result = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: false },
        );
        playback.sound = result.sound;
        if (!owns(playback)) {
          await dispose(playback);
          return;
        }
        result.sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish && owns(playback))
            void stop();
        });
        await result.sound.playAsync();
        if (!owns(playback)) return;
      }
      playback.phase = "playing";
      setPlaying(id);
    } catch (error) {
      if (owns(playback)) {
        latest.current.onError(
          error instanceof Error ? error.message : "Unable to play audio.",
        );
        void stop();
      }
    } finally {
      if (owns(playback)) setLoading(null);
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void stop();
    };
  }, [stop]);
  useEffect(() => {
    void stop();
  }, [account, stop]);
  return { playing, loading, speak, stop };
}
