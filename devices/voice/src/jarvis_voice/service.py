"""Single-mode voice-device runtime."""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import time
from collections import deque
from enum import Enum
from typing import Any
from urllib.parse import quote_plus

from jarvis_voice.api import JarvisApiClient
from jarvis_voice.audio import AudioInput, AudioPlayer, resolve_audio_devices, wake_chime
from jarvis_voice.browser import BrowserController
from jarvis_voice.coding_prompt import PromptRecorder
from jarvis_voice.config import Settings
from jarvis_voice.detector import (
    Analysis,
    BargeInDetector,
    UtteranceSegmenter,
    VoiceActivityDetector,
)
from jarvis_voice.hardware import HardwareProfile, detect_profile
from jarvis_voice.local_commands import exact_light_command
from jarvis_voice.protocol import VoiceProtocolClient
from jarvis_voice.respeaker import LedState, open_respeaker
from jarvis_voice.spotify import SpotifyClient
from jarvis_voice.ui import LocalUiServer, UiEventHub
from jarvis_voice.wakeword import WakeWordDetector

logger = logging.getLogger(__name__)


class VoicePhase(str, Enum):
    IDLE = "idle"
    CONNECTING = "connecting"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"
    ERROR = "error"


class VoiceDeviceService:
    def __init__(self, settings: Settings, profile: HardwareProfile | None = None) -> None:
        self.settings = settings
        self.profile = profile or detect_profile()
        self.respeaker, self.firmware_vad = open_respeaker(self.profile)
        try:
            devices = resolve_audio_devices(
                self.profile,
                settings.input_device,
                settings.output_device,
            )
            self.input = AudioInput(self.profile, devices.input_index)
            self.player = AudioPlayer(self.profile.playback_sample_rate, devices.output_index)
            self.vad = VoiceActivityDetector(min_rms=self.profile.speech_min_rms)
            self.segmenter = UtteranceSegmenter(
                settings.utterance_silence_ms,
                settings.utterance_max_seconds,
            )
            self.barge = BargeInDetector(self.profile, self.firmware_vad, self.player)
            self.wakeword = WakeWordDetector(
                settings.wake_model_dir,
                settings.wake_threshold,
                settings.wake_consecutive_hits,
            )
        except BaseException:
            player = getattr(self, "player", None)
            if player is not None:
                player.close()
            if self.firmware_vad is not None:
                self.firmware_vad.close()
            self.respeaker.set_led(LedState.ERROR)
            self.respeaker.close()
            raise
        self.api = JarvisApiClient(settings.api_url, settings.username, settings.password)
        self.spotify = SpotifyClient(settings)
        self.browser = BrowserController(ui_origin=f"http://127.0.0.1:{settings.ui_port}")
        self.events = UiEventHub()
        self.protocol = VoiceProtocolClient(
            self.api,
            settings.device_id,
            settings.room,
            self.profile.capture_sample_rate,
            settings.personality_level,
            self._on_backend_event,
            self._on_backend_audio,
            self._on_backend_connection,
        )
        self.ui = (
            LocalUiServer(settings, self.api, self.spotify, self, self.events)
            if settings.ui_enabled
            else None
        )
        self._phase = VoicePhase.IDLE
        self._session_active = False
        self._activating = False
        self._interactions_muted = False
        self._follow_up_deadline = 0.0
        self._last_conversation_activity = 0.0
        self._announcement_active = False
        self._scripted_speech_active = False
        self._scripted_speech_interrupted = False
        self._barge_audio: deque[tuple[bytes, Analysis]] = deque(maxlen=6)
        self._barge_trace_blocks = 0
        self._barge_trace_max_rms = 0.0
        self._barge_trace_max_ratio = 0.0
        self._coding_prompt = PromptRecorder(
            self.profile.capture_sample_rate * 2 * settings.coding_prompt_max_seconds
        )
        self._audio_task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def ui_state(self) -> dict[str, Any]:
        return {
            "active": self._session_active,
            "phase": self._phase.value,
            "connected": self.protocol.connected,
            "interactions_muted": self._interactions_muted,
        }

    async def run(self, stop: asyncio.Event) -> None:
        self.protocol.start()
        self.input.start()
        self._audio_task = asyncio.create_task(self._audio_loop(), name="voice-audio")
        if self.ui is not None:
            await self.ui.start()
        await self._publish_state()
        logger.info(
            "voice runtime ready: device=%s room=%s hardware=%s",
            self.settings.device_id,
            self.settings.room or "(unassigned)",
            self.profile.display_name,
        )
        try:
            await stop.wait()
        finally:
            await self.close()

    async def toggle_session(self) -> None:
        if self._session_active:
            await self._stop_session(cancel_backend=True)
        elif self._interactions_muted:
            return
        else:
            await self._activate("touchscreen")

    async def set_interactions_muted(self, muted: bool) -> None:
        muted = bool(muted)
        if self._interactions_muted == muted:
            await self._publish_state()
            return
        self._interactions_muted = muted
        if muted and (self._session_active or self._activating):
            await self._stop_session(cancel_backend=True)
        else:
            await self._publish_state()

    async def start_coding_prompt_recording(self) -> None:
        if not self.settings.coding_tasks_enabled:
            raise PermissionError("coding tasks are disabled on this device")
        if self._coding_prompt.active:
            raise RuntimeError("a coding prompt is already being recorded")
        if self._session_active or self._activating:
            await self._stop_session(cancel_backend=True)
        self.player.clear()
        self.segmenter.reset()
        self.barge.reset()
        self.wakeword.reset()
        self._coding_prompt.start()
        await asyncio.to_thread(self.respeaker.set_led, LedState.LISTENING)

    async def stop_coding_prompt_recording(self) -> tuple[bytes, int]:
        pcm = self._coding_prompt.stop()
        self.wakeword.reset()
        await asyncio.to_thread(self.respeaker.set_led, LedState.IDLE)
        sample_rate = self.profile.capture_sample_rate
        if len(pcm) < sample_rate // 2:
            raise ValueError("record at least a quarter second of audio")
        return pcm, sample_rate

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._coding_prompt.cancel()
        if self._audio_task is not None:
            self._audio_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._audio_task
            self._audio_task = None
        if self.ui is not None:
            await self.ui.close()
        await self.protocol.close()
        await self.spotify.close()
        await self.browser.close()
        await self.api.close()
        self.input.close()
        self.player.close()
        if self.firmware_vad is not None:
            self.firmware_vad.close()
        self.respeaker.set_led(LedState.IDLE)
        self.respeaker.close()

    async def _audio_loop(self) -> None:
        while True:
            pcm = await self.input.read()
            if self._coding_prompt.active:
                self._coding_prompt.push(pcm)
                continue
            try:
                analysis = self.vad.analyze(pcm)
            except ValueError as exc:
                logger.warning("discarding malformed audio block: %s", exc)
                continue

            if not self._session_active:
                if self._interactions_muted:
                    continue
                if self.wakeword.process(pcm):
                    asyncio.create_task(self._activate("wakeword"))
                continue

            if self._phase in {VoicePhase.SPEAKING, VoicePhase.THINKING}:
                self._barge_audio.append((pcm, analysis))
                if self.barge.process(pcm, analysis):
                    buffered = tuple(self._barge_audio)
                    await self._barge_in(analysis)
                    for buffered_pcm, buffered_analysis in buffered:
                        await self._process_listening_block(buffered_pcm, buffered_analysis)
                else:
                    self._trace_barge_block(analysis)
                    continue
                continue

            if self._phase != VoicePhase.LISTENING:
                continue

            if (
                not self.segmenter.active
                and self._follow_up_deadline
                and time.monotonic() >= self._follow_up_deadline
            ):
                await self._stop_session(cancel_backend=False)
                continue

            await self._process_listening_block(pcm, analysis)

    async def _process_listening_block(self, pcm: bytes, analysis: Analysis) -> None:
        if self._phase != VoicePhase.LISTENING:
            return

        # The acoustic echo tail of our own response is still in flight when we
        # return to LISTENING; without this guard it opens a phantom utterance and
        # the device converses with itself. 0.5 mirrors the segmenter onset ratio.
        if (
            not self.segmenter.active
            and analysis.speech_ratio >= 0.5
            and self.barge.is_own_playback_echo(pcm)
        ):
            return

        update = self.segmenter.process(pcm, analysis)
        try:
            if update.started:
                if not self.protocol.connected:
                    raise ConnectionError("voice WebSocket disconnected during onset")
                self._follow_up_deadline = 0.0
                for block in update.started:
                    await self.protocol.send_audio(block)
            elif update.audio is not None:
                await self.protocol.send_audio(update.audio)
            if update.ended:
                self.segmenter.reset()
                await self.protocol.end_turn()
                await self._transition(VoicePhase.THINKING)
        except ConnectionError:
            self.segmenter.reset()
            await self._transition(VoicePhase.CONNECTING)

    async def _activate(self, source: str) -> None:
        if self._interactions_muted:
            return
        if self._session_active or self._activating:
            return
        if getattr(self, "_scripted_speech_active", False):
            self._scripted_speech_interrupted = True
            self.player.clear()
        self._activating = True
        self._session_active = True
        self.segmenter.reset()
        self.barge.reset()
        self.wakeword.reset()
        await self._transition(VoicePhase.CONNECTING)
        try:
            await self.protocol.wait_connected(timeout=20.0)
            now = time.monotonic()
            if (
                self._last_conversation_activity
                and now - self._last_conversation_activity
                >= self.settings.conversation_idle_seconds
            ):
                await self.protocol.configure_conversation(None)
            self.player.play_clip(wake_chime(self.profile.playback_sample_rate))
            await asyncio.sleep(0.16)
            self._follow_up_deadline = time.monotonic() + self.settings.follow_up_seconds
            await self._transition(VoicePhase.LISTENING)
            logger.info("voice session activated by %s", source)
        except (TimeoutError, ConnectionError) as exc:
            logger.error("could not activate voice session: %s", exc)
            self._session_active = False
            await self._transition(VoicePhase.ERROR)
            await asyncio.sleep(0.8)
            await self._transition(VoicePhase.IDLE)
        finally:
            self._activating = False

    async def _stop_session(self, *, cancel_backend: bool) -> None:
        if getattr(self, "_scripted_speech_active", False):
            self._scripted_speech_interrupted = True
        self._session_active = False
        self._activating = False
        self._follow_up_deadline = 0.0
        self.segmenter.reset()
        self.barge.reset()
        self.wakeword.reset()
        self.player.clear()
        if cancel_backend and self.protocol.connected:
            with contextlib.suppress(ConnectionError):
                await self.protocol.cancel_response()
        await self._transition(VoicePhase.IDLE)

    def _trace_barge_block(self, analysis: Analysis) -> None:
        """Debug-log a ~2 s summary of what the barge-in detector is seeing."""
        if not logger.isEnabledFor(logging.DEBUG):
            return
        self._barge_trace_blocks += 1
        self._barge_trace_max_rms = max(self._barge_trace_max_rms, analysis.rms)
        self._barge_trace_max_ratio = max(self._barge_trace_max_ratio, analysis.speech_ratio)
        if self._barge_trace_blocks < 25:
            return
        logger.debug(
            "barge watch: max_rms=%.0f max_ratio=%.2f floor=%.0f min_ratio=%.2f "
            "firmware_vad=%s echo_corr=%.2f",
            self._barge_trace_max_rms,
            self._barge_trace_max_ratio,
            self.profile.barge_min_rms,
            self.profile.barge_min_ratio,
            self.firmware_vad.is_voice() if self.firmware_vad is not None else "n/a",
            self.barge.last_echo_correlation,
        )
        self._barge_trace_blocks = 0
        self._barge_trace_max_rms = 0.0
        self._barge_trace_max_ratio = 0.0

    async def _barge_in(self, analysis: Analysis) -> None:
        logger.info(
            "barge-in detected (rms=%.0f speech_ratio=%.2f firmware_vad=%s echo_corr=%.2f)",
            analysis.rms,
            analysis.speech_ratio,
            self.firmware_vad.is_voice() if self.firmware_vad is not None else "n/a",
            self.barge.last_echo_correlation,
        )
        self.player.clear()
        self.segmenter.reset()
        self.barge.reset()
        if self.protocol.connected:
            with contextlib.suppress(ConnectionError):
                await self.protocol.cancel_response()
        self._follow_up_deadline = time.monotonic() + self.settings.follow_up_seconds
        await self._transition(VoicePhase.LISTENING)

    async def _on_backend_connection(self, connected: bool) -> None:
        if not connected:
            self._announcement_active = False
            self.player.clear()
            self.segmenter.reset()
            if self._session_active:
                await self._transition(VoicePhase.CONNECTING)
            else:
                await self._publish_state()
            return
        if self._session_active and not self._activating:
            self._follow_up_deadline = time.monotonic() + self.settings.follow_up_seconds
            await self._transition(VoicePhase.LISTENING)
        else:
            await self._publish_state()

    async def _on_backend_audio(self, pcm: bytes) -> None:
        if self._session_active or self._announcement_active:
            self.player.enqueue(pcm)

    async def _on_backend_event(self, event: str, data: dict[str, Any]) -> None:
        if event == "device.action":
            await self._handle_device_action(data)
            return
        if event == "announcement.started":
            self._session_active = False
            self._activating = False
            self._follow_up_deadline = 0.0
            self.segmenter.reset()
            self.barge.reset()
            self.player.clear()
            self._announcement_active = True
            self.player.start_response(int(data.get("sample_rate") or 24000))
            await self._transition(VoicePhase.SPEAKING)
            return
        if event == "announcement.done":
            self.player.finish_response()
            await self._wait_for_playback()
            self._announcement_active = False
            self._last_conversation_activity = 0.0
            if self.protocol.connected:
                with contextlib.suppress(ConnectionError):
                    await self.protocol.configure_conversation(None)
            await self._transition(VoicePhase.IDLE)
            return
        if event == "session.ended":
            await self._wait_for_playback()
            await self._stop_session(cancel_backend=False)
            self._last_conversation_activity = 0.0
            if self.protocol.connected:
                with contextlib.suppress(ConnectionError):
                    await self.protocol.configure_conversation(None)
            return
        if event == "response.audio.started":
            if not self._session_active:
                return
            self.player.start_response(int(data.get("sample_rate") or 24000))
            # Never barge in on the first ~240 ms of our own utterance: that window
            # holds trailing user syllables and echo-path onset transients.
            self.barge.reset(holdoff_blocks=3)
            await self._transition(VoicePhase.SPEAKING)
            return
        if event == "response.audio.done":
            self.player.finish_response()
            return
        if event == "turn.done":
            await self._wait_for_playback()
            self.segmenter.reset()
            self.barge.reset()
            self._last_conversation_activity = time.monotonic()
            if self._session_active:
                self._follow_up_deadline = time.monotonic() + self.settings.follow_up_seconds
                await self._transition(VoicePhase.LISTENING)
            return
        if event == "transcription.final":
            transcript = str(data.get("text") or "")
            await self.events.set_voice_state(transcript=transcript)
            command = exact_light_command(transcript)
            if command is not None and self._session_active and self.settings.room:
                await self._handle_local_light_command(command)
            return
        if event == "tool.finished":
            await self._mirror_tool_result(data)
            return
        if event == "error":
            code = str(data.get("code") or "voice_error")
            logger.warning("backend voice error: %s", code)
            if self._session_active:
                await self._transition(VoicePhase.ERROR)

    async def _handle_local_light_command(self, command: str) -> None:
        """Cancel the remote agent turn and switch this room's lights immediately."""
        logger.info("local light short-circuit: lights %s", command)
        if self.protocol.connected:
            with contextlib.suppress(ConnectionError):
                await self.protocol.cancel_response()
        try:
            await self._control_room_lights(command)
        except Exception:
            logger.exception("local light command failed")
            await self._transition(VoicePhase.ERROR)
            await asyncio.sleep(0.5)
            await self._stop_session(cancel_backend=False)
            self._last_conversation_activity = 0.0
            if self.protocol.connected:
                with contextlib.suppress(ConnectionError):
                    await self.protocol.configure_conversation(None)
            return
        await self._stop_session(cancel_backend=False)
        self._last_conversation_activity = 0.0
        if self.protocol.connected:
            with contextlib.suppress(ConnectionError):
                await self.protocol.configure_conversation(None)

    async def _control_room_lights(self, command: str) -> None:
        room = self.settings.room
        if not room:
            raise RuntimeError("room is not configured")
        action = "turn_on" if command == "on" else "turn_off"
        await self.api.json(
            "POST",
            "/v1/smart-devices/control",
            body={
                "scope": "room",
                "selector": room,
                "action": action,
                "parameters": {},
            },
        )

    async def _wait_for_playback(self, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while self.player.is_playing and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

    async def _handle_device_action(self, data: dict[str, Any]) -> None:
        request_id = str(data.get("request_id") or "")
        action = str(data.get("action") or "")
        arguments = data.get("arguments")
        if not request_id:
            logger.warning("backend device action omitted request_id")
            return
        if not isinstance(arguments, dict):
            arguments = {}
        try:
            result = await self._execute_device_action(action, arguments)
            await self.protocol.send_device_action_result(request_id, result=result)
        except Exception as exc:
            logger.exception("device action %s failed", action)
            with contextlib.suppress(ConnectionError):
                await self.protocol.send_device_action_result(request_id, error=str(exc)[:500])

    def _idle_for_scripted_speech(self) -> bool:
        return (
            self._phase == VoicePhase.IDLE
            and not self._session_active
            and not self._activating
            and not self._announcement_active
            and not self._scripted_speech_active
            and not self._coding_prompt.active
            and not self.player.is_playing
            and not self.player.playback_failed
        )

    async def _play_scripted_speech(self, arguments: dict[str, Any]) -> dict[str, Any]:
        if not self._idle_for_scripted_speech():
            return {"status": "busy"}
        rate = arguments.get("sample_rate")
        encoded = arguments.get("pcm_base64")
        if type(rate) is not int or not 8000 <= rate <= 48000:
            raise ValueError("invalid scripted speech sample rate")
        if not isinstance(encoded, str) or len(encoded) > 2_560_000:
            raise ValueError("invalid scripted speech size")
        try:
            pcm = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("invalid scripted speech PCM") from exc
        if not pcm or len(pcm) % 2 or len(pcm) > rate * 2 * 20:
            raise ValueError("scripted speech must be at most 20 seconds of mono PCM16")
        self._scripted_speech_active = True
        self._scripted_speech_interrupted = False
        try:
            self.player.start_response(rate)
            # One bounded buffer avoids overflowing the chunk queue.
            self.player.enqueue(pcm)
            self.player.finish_response()
            await self._transition(VoicePhase.SPEAKING)
            await self._wait_for_playback(timeout=22.0)
            # PortAudio write completion can precede the final sample at the DAC.
            await asyncio.sleep(min(1.0, self.player.output_latency_seconds + 0.05))
            if self._scripted_speech_interrupted:
                return {"status": "interrupted"}
            if self.player.is_playing or self.player.playback_failed:
                return {"status": "failed"}
            return {"status": "played"}
        finally:
            self._scripted_speech_active = False
            # A wake/tap may already have opened a user conversation. Leave it alone.
            if not self._scripted_speech_interrupted:
                self.player.clear()
                self.wakeword.reset()
                await self._transition(VoicePhase.IDLE)

    async def _execute_device_action(
        self, action: str, arguments: dict[str, Any]
    ) -> dict[str, Any] | list[dict[str, Any]]:
        if action == "speech_status":
            return {"idle": self._idle_for_scripted_speech()}
        if action == "play_scripted_speech":
            return await self._play_scripted_speech(arguments)
        if action == "navigate_device_ui":
            destination = str(arguments.get("destination") or "").strip()
            allowed = {"standby", "spotify", "timer", "timer_alarms", "tv", "cameras"}
            if destination not in allowed:
                raise ValueError(f"unknown touchscreen destination {destination!r}")
            await self.events.client_action("navigate_device_ui", arguments)
            return {"ok": True, "destination": destination}

        if action == "spotify_search":
            query = str(arguments.get("query") or "").strip()
            if not query:
                raise ValueError("Spotify query is required")
            limit = max(1, min(10, int(arguments.get("limit", 10))))
            types = str(arguments.get("types") or "track,album,artist,playlist")
            rows = await self.spotify.search(query, types, limit)
            # This result becomes model context for the next turn: cover-art
            # URLs and overflow rows are pure prompt-token latency, so return
            # only what the model needs to choose a URI.
            return [
                {key: value for key, value in row.items() if key != "image"} for row in rows[:limit]
            ]

        if action == "spotify_play_best_match":
            query = str(arguments.get("query") or "").strip()
            if not query:
                raise ValueError("Spotify query is required")
            types = str(arguments.get("types") or "track,album,artist,playlist")
            rows = await self.spotify.search(query, types, 5)
            if not rows:
                raise ValueError(f"Spotify found nothing for {query!r}")
            # The caller lists the most likely result kind first in types.
            preferred = types.replace(" ", "").split(",")[0]
            chosen = next((row for row in rows if row.get("kind") == preferred), rows[0])
            await self.spotify.play(
                spotify_uri=str(chosen["uri"]),
                track_uris=None,
                device_name=str(arguments.get("device_name") or ""),
            )
            return {
                "ok": True,
                "status": "playing",
                "played": {key: chosen.get(key) for key in ("uri", "name", "subtitle", "kind")},
            }

        if action == "spotify_start_playback":
            track_uris = arguments.get("track_uris")
            await self.spotify.play(
                spotify_uri=str(arguments.get("spotify_uri") or ""),
                track_uris=[str(uri) for uri in track_uris]
                if isinstance(track_uris, list)
                else None,
                device_name=str(arguments.get("device_name") or ""),
            )
            return {"ok": True, "status": "playing"}

        spotify_transport = {
            "spotify_resume_playback": self.spotify.resume,
            "spotify_pause": self.spotify.pause,
            "spotify_skip_next": self.spotify.skip_next,
            "spotify_skip_previous": self.spotify.skip_previous,
        }
        if action in spotify_transport:
            await spotify_transport[action](str(arguments.get("device_name") or ""))
            return {"ok": True}

        if action == "set_system_volume":
            from jarvis_voice.volume import set_volume

            state = await set_volume(
                percent=_optional_int(arguments.get("percent")),
                delta_percent=_optional_int(arguments.get("delta_percent")),
                muted=arguments.get("muted") if isinstance(arguments.get("muted"), bool) else None,
            )
            return {"ok": True, "percent": state.percent, "muted": state.muted}

        if action == "control_device_clock":
            operation = str(arguments.get("operation") or "")
            client_actions = {
                "stop_timer": "stop_timer",
                "show_timer": "navigate_timer",
                "show_alarms": "navigate_alarms",
                "add_alarm": "alarm_add",
                "remove_alarm": "alarm_remove_at",
                "set_alarm_enabled": "alarm_set_enabled",
            }
            client_action = client_actions.get(operation)
            if client_action is None:
                raise ValueError(f"unknown clock operation {operation!r}")
            await self.events.client_action(client_action, arguments)
            return {"ok": True, "operation": operation}

        if action == "show_wikipedia":
            query = str(arguments.get("query") or "").strip()
            if not query:
                raise ValueError("Wikipedia query is required")
            url = "https://en.wikipedia.org/wiki/Special:Search?search=" + quote_plus(query)
            await self.events.client_action("browser_open", {"url": url})
            return {"ok": True, "url": url}

        if action == "open_patreon":
            url = "https://www.patreon.com"
            await self.events.client_action("browser_open", {"url": url})
            return {"ok": True, "url": url}

        if action == "close_browser":
            await self.events.client_action("browser_close", {})
            closed = await self.browser.close_external_tabs()
            return {"ok": True, "closed_tabs": closed}

        if action == "put_on_title":
            return await self._put_on_title(str(arguments.get("query") or ""))

        raise ValueError(f"unknown device action {action!r}")

    async def _put_on_title(self, query: str) -> dict[str, Any]:
        from jarvis_voice.watchmode import resolve_streaming_url

        result = await resolve_streaming_url(
            self.settings.watchmode_api_key,
            query,
            region=self.settings.watchmode_region,
            preferred_sources=self.settings.watchmode_preferred_sources,
        )
        await self.events.client_action("browser_open", {"url": result["url"]})
        return {"ok": True, **result}

    async def _mirror_tool_result(self, data: dict[str, Any]) -> None:
        if data.get("name") != "create_timer":
            return
        result = data.get("result")
        if not isinstance(result, dict) or result.get("error"):
            return
        seconds = result.get("remaining_seconds", result.get("duration_seconds"))
        try:
            duration = int(seconds)
        except (TypeError, ValueError):
            return
        if duration > 0:
            await self.events.client_action(
                "start_timer",
                {"seconds": duration, "label": str(result.get("label") or "")},
            )

    async def _transition(self, phase: VoicePhase) -> None:
        if self._phase == phase:
            await self._publish_state()
            return
        self._phase = phase
        if phase == VoicePhase.THINKING:
            self._barge_audio.clear()
            self.barge.reset()
        led = {
            VoicePhase.IDLE: LedState.IDLE,
            VoicePhase.CONNECTING: LedState.THINKING,
            VoicePhase.LISTENING: LedState.LISTENING,
            VoicePhase.THINKING: LedState.THINKING,
            VoicePhase.SPEAKING: LedState.SPEAKING,
            VoicePhase.ERROR: LedState.ERROR,
        }[phase]
        await asyncio.to_thread(self.respeaker.set_led, led)
        await self._publish_state()

    async def _publish_state(self) -> None:
        await self.events.set_voice_state(**self.ui_state)


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)
