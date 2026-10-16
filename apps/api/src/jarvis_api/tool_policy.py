"""Select a small, task-relevant tool surface for each model turn.

The model remains responsible for choosing and filling tools.  This policy keeps
unrelated schemas out of its context and requires an actual tool call for clear
action requests, which prevents a prose-only acknowledgement from masquerading
as completed work.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import FrozenSet, Optional, Tuple


@dataclass(frozen=True)
class ToolPolicy:
    # Callers select a bounded schema set so llama.cpp never ingests the entire
    # catalog for a single turn.
    names: Tuple[str, ...] = ()
    requires_tool: bool = False
    completion_tools: FrozenSet[str] = frozenset()
    temperature: float = 0.6
    reason: str = "conversation"


_ACTION = re.compile(
    r"\b(add|cancel|change|close|create|delete|dim|dismiss|exit|hang up|kill|make|mute|"
    r"navigate|open|pause|play|power|put on|quit|remove|resume|schedule|set|show|skip|"
    r"start|stop|switch|turn|unmute|update)\b"
)
_REFERENCE = re.compile(
    r"^(?:please\s+)?(?:do|close|open|stop|start|turn|switch)\s+"
    r"(?:it|that)(?:\s+now)?(?:\s+please)?$"
)
_CLOSE_VERB = re.compile(r"\b(close|exit|quit|dismiss|get rid of|hide)\b")
_NAVIGATE_VERB = re.compile(
    r"\b(go back to|go to|open|show|switch to|bring up|take me to|navigate to)\b"
)
_SCREEN_WORDS = ("page", "screen", "tab", "view")

LIGHT_TOOLS = ("room_lights_off", "room_lights_on", "control_lights")
SPOTIFY_TOOLS = (
    "spotify_play_best_match",
    "spotify_search",
    "spotify_start_playback",
    "spotify_resume_playback",
    "spotify_pause",
    "spotify_skip_next",
    "spotify_skip_previous",
)
BROWSER_TOOLS = (
    "navigate_device_ui",
    "show_wikipedia",
    "search_wikipedia",
    "open_patreon",
    "close_browser",
)
# Touchscreen destinations navigate_device_ui accepts, in the words owners actually use.
DEVICE_UI_DESTINATIONS = (
    "alarm",
    "alarms",
    "camera",
    "cameras",
    "home screen",
    "spotify",
    "standby",
    "television",
    "timer",
    "timers",
    "tv",
)
# Pages Jarvis opens in the device browser.  close_browser is the only tool that
# closes them; navigate_device_ui only swaps the touchscreen tab underneath.
BROWSER_PAGE_TARGETS = (
    "apple tv",
    "browser",
    "disney",
    "disney plus",
    "hbo",
    "hbo max",
    "hulu",
    "max",
    "netflix",
    "page",
    "paramount",
    "patreon",
    "peacock",
    "prime",
    "prime video",
    "tab",
    "wikipedia",
    "window",
)
CLOCK_TOOLS = ("create_timer", "list_timers", "control_device_clock")
TV_TOOLS = ("put_on_title",)
SMART_DEVICE_TOOLS = ("list_smart_devices", "control_smart_device")
TODO_TOOLS = ("list_todos", "create_todo", "get_todo", "update_todo", "delete_todo")
CODE_TASK_TOOLS = ("create_code_task", "list_code_tasks", "get_code_task", "cancel_code_task")
RESEARCH_TASK_TOOLS = (
    "create_research_task",
    "list_research_tasks",
    "get_research_task",
    "cancel_research_task",
)
SHOPPING_TOOLS = (
    "list_shopping_lists",
    "create_shopping_list",
    "add_shopping_items",
    "update_shopping_list",
    "delete_shopping_list",
)
PROJECT_TOOLS = (
    "list_projects",
    "create_project",
    "update_project",
    "search_assets",
    "create_text_asset",
    "get_text_asset",
    "update_text_asset",
    "get_conversation_transcript",
    "search_past_conversations",
)
MEMORY_TOOLS = ("remember", "search_memories")
SCHEDULE_TOOLS = (
    "schedule_tool_call",
    "list_scheduled_tool_calls",
    "cancel_scheduled_tool_calls",
)
DATETIME_TOOLS = (
    "get_current_datetime",
    "parse_datetime",
    "diff_datetimes",
    "add_duration",
    "next_weekday",
    "convert_timezone",
)
KNOWLEDGE_TOOLS = (
    "search_web",
    "search_wikipedia",
    "search_stackoverflow",
    "search_wookieepedia",
    "search_star_wars",
)
CAMERA_TOOLS = ("list_jarvis_devices", "describe_scene")
CONVERSATION_TOOLS = ("search_web",)

# Dismissals that end a voice session wherever they appear in the utterance.
END_SESSION_PHRASES = (
    "all done",
    "bye",
    "dismissed",
    "end the session",
    "end this session",
    "forget it",
    "go away",
    "good night",
    "goodbye",
    "goodnight",
    "hang up",
    "i am done",
    "i m done",
    "leave me alone",
    "never mind",
    "nevermind",
    "nothing else",
    "shut up",
    "silence",
    "stop listening",
    "stop talking",
    "that is all",
    "that is enough",
    "that is everything",
    "that ll be all",
    "that s all",
    "that s enough",
    "that s everything",
    "that will be all",
    "we are done",
    "we re done",
)
# Dismissals that are only unambiguous as the whole utterance.
END_SESSION_UTTERANCES = frozenset(
    {
        "cancel",
        "done",
        "enough",
        "no thanks",
        "quiet",
        "shush",
        "stop",
        "thank you",
        "thanks",
        "that is it",
        "that s it",
    }
)
# Filler that must not stop a bare dismissal from matching the whole utterance.
_UTTERANCE_FILLER = frozenset(
    {
        "for",
        "here",
        "jarvis",
        "no",
        "now",
        "ok",
        "okay",
        "please",
        "then",
        "well",
        "yeah",
        "yes",
    }
)
# Longest first so "that s all" wins over the bare "that s it" style utterances.
_DISMISSAL_SEQUENCES = tuple(
    sorted(
        (
            tuple(phrase.split())
            for phrase in END_SESSION_PHRASES + tuple(sorted(END_SESSION_UTTERANCES))
        ),
        key=len,
        reverse=True,
    )
)

# Kept public for the parity test: bounding the conversational default must not
# accidentally make any registered capability unreachable.
ROUTED_TOOL_NAMES = frozenset(
    LIGHT_TOOLS
    + SPOTIFY_TOOLS
    + BROWSER_TOOLS
    + CLOCK_TOOLS
    + TV_TOOLS
    + SMART_DEVICE_TOOLS
    + TODO_TOOLS
    + CODE_TASK_TOOLS
    + RESEARCH_TASK_TOOLS
    + SHOPPING_TOOLS
    + PROJECT_TOOLS
    + MEMORY_TOOLS
    + SCHEDULE_TOOLS
    + DATETIME_TOOLS
    + KNOWLEDGE_TOOLS
    + CAMERA_TOOLS
    + (
        "end_voice_session",
        "set_system_volume",
        "weather_search_locations",
        "weather_current",
        "weather_forecast",
        "search_gmail",
        "read_gmail",
    )
)


def _clean(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _is_action(text: str) -> bool:
    return bool(_ACTION.search(text))


def _simple_room_light_action(text: str, device_room: str) -> Optional[str]:
    """Recognize only unambiguous power commands for the calling room."""
    words = _clean(text).split()
    if not words or not ({"light", "lights"} & set(words)):
        return None
    states = [word for word in words if word in {"on", "off"}]
    if len(states) != 1:
        return None
    allowed = {
        "can",
        "could",
        "jarvis",
        "light",
        "lights",
        "please",
        "room",
        "switch",
        "the",
        "turn",
        "would",
        "you",
    }
    allowed.update(_clean(device_room).split())
    if any(word not in allowed | {states[0]} for word in words):
        return None
    if not ({"turn", "switch"} & set(words)) and len(words) > 2:
        return None
    return states[0]


def _domain_inherited(text: str, previous_user_text: str, markers: Tuple[str, ...]) -> bool:
    return bool(_REFERENCE.match(text)) and any(marker in previous_user_text for marker in markers)


def _has_phrase(text: str, *phrases: str) -> bool:
    padded = f" {text} "
    return any(f" {phrase} " in padded for phrase in phrases)


def _is_dismissal(text: str) -> bool:
    """Recognize an utterance that is nothing but the owner signalling they are done.

    The dismissal has to account for the whole utterance.  Matching these phrases
    anywhere hangs up on requests that merely contain one, such as "I'm done with
    work, what should I make for dinner?".
    """
    words = [word for word in text.split() if word not in _UTTERANCE_FILLER]
    index = 0
    while index < len(words):
        for phrase in _DISMISSAL_SEQUENCES:
            if tuple(words[index : index + len(phrase)]) == phrase:
                index += len(phrase)
                break
        else:
            return False
    return index > 0


def _is_video_request(text: str) -> bool:
    return (
        any(marker in text for marker in ("television", "roku", "movie", "episode", "series"))
        or "tv" in text.split()
        or bool(re.search(r"\bput on\b", text))
    )


def _television_policy(text: str, *, physical_target: bool = False) -> ToolPolicy:
    required = _is_action(text) or bool(
        re.search(
            r"^(?:(?:please|can you|could you|would you|will you)\s+)?"
            r"(?:search|type|enter|press|tune|find|ring|rewind|replay)\b"
            r"|\b(?:volume (?:up|down)|louder|quieter)\b",
            text,
        )
    )
    return ToolPolicy(
        names=SMART_DEVICE_TOOLS if physical_target else TV_TOOLS,
        requires_tool=required,
        completion_tools=frozenset(
            {"control_smart_device"} if physical_target else {"put_on_title"}
        ),
        temperature=0.15 if required else 0.4,
        reason="television",
    )


def _screen_request(text: str) -> Optional[str]:
    """Pin the single device-UI tool an explicit screen or browser-page request needs.

    Left to a five-tool surface the model reads "close the Netflix tab" as a
    touchscreen tab change, silently returns to standby, and leaves the page open.
    """
    if re.search(r"\b(?:on|of)\s+(?:\w+\s+){0,4}(?:tv|television|roku)\b", text):
        # "Open Netflix on the office TV" targets that TV, not a Jarvis tab.
        return None
    destination = _has_phrase(text, *DEVICE_UI_DESTINATIONS)
    closing = bool(_CLOSE_VERB.search(text))
    if closing:
        if destination:
            # "Close the Spotify tab" leaves a screen; "dismiss the alarm" operates
            # the clock, so only an explicit screen word means navigation here.
            return "navigate_device_ui" if _has_phrase(text, *_SCREEN_WORDS) else None
        return "close_browser" if _has_phrase(text, *BROWSER_PAGE_TARGETS) else None
    if destination and _NAVIGATE_VERB.search(text):
        return "navigate_device_ui"
    return None


def _is_smart_home_inventory(text: str) -> bool:
    inventory = re.search(
        r"\b(list|which|what|names of|show me)\b.*\b"
        r"(smart devices?|smart home devices?|lights?|lamps?|outlets?|plugs?|televisions|tvs)\b",
        text,
    )
    if not inventory:
        return False
    # A negative instruction is not an action request. In particular, "list ...
    # do not change anything" must not require a control call after the listing.
    positive = re.split(r"\b(?:do not|don t|without)\b", text, maxsplit=1)[0]
    return not re.search(
        r"\b(turn|switch|set|dim|change|control|mute|unmute|play|pause|open|close)\b",
        positive,
    )


def select_tool_policy(
    text: str,
    *,
    voice_session: bool,
    device_id: Optional[str],
    device_room: str,
    previous_user_text: str = "",
) -> ToolPolicy:
    policy = _route(
        text,
        voice_session=voice_session,
        device_id=device_id,
        device_room=device_room,
        previous_user_text=previous_user_text,
    )
    # A voice turn that is not pinned to a required action must still be able to
    # hang up; without the schema the model narrates the tool name instead.
    if voice_session and not policy.requires_tool and "end_voice_session" not in policy.names:
        return replace(policy, names=policy.names + ("end_voice_session",))
    return policy


def _route(
    text: str,
    *,
    voice_session: bool,
    device_id: Optional[str],
    device_room: str,
    previous_user_text: str = "",
) -> ToolPolicy:
    current = _clean(text)
    previous = _clean(previous_user_text)

    for markers, names, reason in (
        (("code factory", "code task", "coding task"), CODE_TASK_TOOLS, "code-tasks"),
        (
            ("research task", "research report", "deep research"),
            RESEARCH_TASK_TOOLS,
            "research-tasks",
        ),
    ):
        if any(marker in current for marker in markers) or _domain_inherited(
            current, previous, markers
        ):
            return ToolPolicy(
                names=names,
                requires_tool=_is_action(current),
                completion_tools=frozenset(names),
                temperature=0.2,
                reason=reason,
            )

    # Explicit research is not device control, even when the subject names a
    # device or the owner is correcting an earlier control interpretation.
    if _has_phrase(current, "search the web", "search online", "look up online"):
        return ToolPolicy(
            names=("search_web",),
            requires_tool=True,
            completion_tools=frozenset({"search_web"}),
            temperature=0.2,
            reason="web-search",
        )

    media_subject = _has_phrase(current, "movie", "film", "series", "episode", "tv show")
    if media_subject and re.search(
        r"\b(?:tell me about|information about|what|who|when|where|why|how)\b", current
    ):
        return ToolPolicy(
            names=CONVERSATION_TOOLS,
            completion_tools=frozenset(CONVERSATION_TOOLS),
            reason="media-information",
        )

    # A TV series/show is content, not a physical television. Keep explicit
    # targets such as "on the office TV" available to the Roku control route.
    target_text = re.sub(r"\b(?:tv|television) (?:series|show)\b", "", current)
    physical_tv = _has_phrase(
        target_text,
        "tv",
        "television",
        "roku",
        "find the remote",
        "find my remote",
        "find remote",
        "ring the remote",
    )
    if media_subject and re.search(r"\b(?:play|put on|start)\b", current) and not physical_tv:
        return _television_policy(current)

    if _is_smart_home_inventory(current):
        return ToolPolicy(
            names=("list_smart_devices",),
            requires_tool=True,
            completion_tools=frozenset({"list_smart_devices"}),
            temperature=0.1,
            reason="smart-home-inventory",
        )

    if voice_session and _has_phrase(
        current,
        "scheduled action",
        "scheduled actions",
        "schedule an action",
        "schedule this",
    ):
        required = _is_action(current)
        return ToolPolicy(
            names=SCHEDULE_TOOLS,
            requires_tool=required,
            completion_tools=frozenset(SCHEDULE_TOOLS),
            temperature=0.15,
            reason="scheduled-actions",
        )

    if voice_session and device_id:
        light_state = _simple_room_light_action(current, device_room)
        if light_state is not None:
            name = "room_lights_on" if light_state == "on" else "room_lights_off"
            return ToolPolicy(
                names=(name,),
                requires_tool=True,
                completion_tools=frozenset({name}),
                temperature=0.1,
                reason="room-light-power",
            )

    screen_tool = _screen_request(current)
    if screen_tool is not None:
        return ToolPolicy(
            names=(screen_tool,),
            requires_tool=True,
            completion_tools=frozenset({screen_tool}),
            temperature=0.1,
            reason="browser-close" if screen_tool == "close_browser" else "device-navigation",
        )

    light_markers = ("light", "lights", "lamp", "lamps")
    if _has_phrase(current, *light_markers) or _domain_inherited(current, previous, light_markers):
        required = _is_action(current) or current.endswith((" on", " off"))
        return ToolPolicy(
            names=LIGHT_TOOLS if not required else ("control_lights",),
            requires_tool=required,
            completion_tools=frozenset({"control_lights"}),
            temperature=0.15 if required else 0.4,
            reason="lighting",
        )

    if physical_tv:
        # An explicit TV target takes priority over local system volume, Spotify,
        # and browser keywords within a TV search/type request.
        return _television_policy(current, physical_target=True)

    spotify_markers = ("spotify", "music", "song", "album", "artist", "playback", "playlist")
    if (
        any(marker in current for marker in spotify_markers)
        or _domain_inherited(current, previous, spotify_markers)
        # "Play <title> by <artist>" names no domain word, and without a playback
        # route the model answers with a Spotify URI instead of playing anything.
        or (current.startswith("play ") and not _is_video_request(current))
    ):
        required = _is_action(current)
        play_request = bool(re.search(r"\b(play|put on|start)\b", current))
        completion = (
            frozenset(
                {"spotify_play_best_match", "spotify_start_playback", "spotify_resume_playback"}
            )
            if play_request
            else frozenset(SPOTIFY_TOOLS)
        )
        return ToolPolicy(
            names=SPOTIFY_TOOLS,
            requires_tool=required,
            completion_tools=completion,
            temperature=0.15 if required else 0.4,
            reason="spotify",
        )

    browser_markers = ("browser", "patreon", "screen", "tab", "wikipedia")
    if any(marker in current for marker in browser_markers) or _domain_inherited(
        current, previous, browser_markers
    ):
        required = _is_action(current)
        return ToolPolicy(
            names=BROWSER_TOOLS,
            requires_tool=required,
            completion_tools=frozenset(BROWSER_TOOLS),
            temperature=0.15 if required else 0.4,
            reason="device-ui",
        )

    if any(marker in current for marker in ("volume", "louder", "quieter", "mute", "unmute")):
        return ToolPolicy(
            names=("set_system_volume",),
            requires_tool=True,
            completion_tools=frozenset({"set_system_volume"}),
            temperature=0.1,
            reason="volume",
        )

    if any(marker in current for marker in ("timer", "alarm", "clock", "countdown")):
        return ToolPolicy(
            names=CLOCK_TOOLS,
            requires_tool=True,
            completion_tools=frozenset(CLOCK_TOOLS),
            temperature=0.15,
            reason="clock",
        )

    if _is_video_request(current):
        return _television_policy(current)

    if _has_phrase(
        current,
        "smart device",
        "smart devices",
        "smart plug",
        "smart plugs",
        "outlet",
        "outlets",
    ):
        return ToolPolicy(
            names=SMART_DEVICE_TOOLS,
            requires_tool=_is_action(current),
            completion_tools=frozenset({"control_smart_device"}),
            temperature=0.2,
            reason="smart-device",
        )

    if any(marker in current for marker in ("todo", "to do", "task", "remind me")):
        return ToolPolicy(
            names=TODO_TOOLS,
            requires_tool=_is_action(current) or "remind me" in current,
            completion_tools=frozenset(TODO_TOOLS),
            temperature=0.2,
            reason="todos",
        )

    if "shopping" in current or "grocery" in current:
        return ToolPolicy(
            names=SHOPPING_TOOLS,
            requires_tool=True,
            completion_tools=frozenset(SHOPPING_TOOLS),
            temperature=0.2,
            reason="shopping",
        )

    if _has_phrase(
        current,
        "project",
        "projects",
        "text asset",
        "text assets",
        "saved document",
        "saved documents",
        "past conversation",
        "past conversations",
        "conversation transcript",
    ):
        return ToolPolicy(
            names=PROJECT_TOOLS,
            requires_tool=_is_action(current),
            completion_tools=frozenset(PROJECT_TOOLS),
            temperature=0.3,
            reason="projects-and-history",
        )

    if _has_phrase(current, "remember", "memory", "memories", "recall"):
        required = current.startswith("remember ") or "remember that" in current
        return ToolPolicy(
            names=MEMORY_TOOLS,
            requires_tool=required,
            completion_tools=frozenset(MEMORY_TOOLS),
            temperature=0.2,
            reason="memory",
        )

    if _has_phrase(
        current,
        "camera",
        "cameras",
        "doorbell",
        "front door",
        "side door",
        "what do you see",
        "who is at the door",
    ):
        return ToolPolicy(
            names=CAMERA_TOOLS,
            requires_tool=_is_action(current) or "what do you see" in current,
            completion_tools=frozenset({"describe_scene"}),
            temperature=0.2,
            reason="camera",
        )

    if _has_phrase(
        current,
        "what time",
        "what date",
        "what day",
        "time is it",
        "date is it",
        "day is it",
        "time zone",
        "timezone",
        "how long until",
        "days until",
        "weeks until",
        "next monday",
        "next tuesday",
        "next wednesday",
        "next thursday",
        "next friday",
        "next saturday",
        "next sunday",
    ):
        return ToolPolicy(
            names=DATETIME_TOOLS,
            requires_tool=True,
            completion_tools=frozenset(DATETIME_TOOLS),
            temperature=0.1,
            reason="datetime",
        )

    if any(marker in current for marker in ("weather", "forecast", "temperature outside")):
        tools = ("weather_search_locations", "weather_current", "weather_forecast")
        return ToolPolicy(
            names=tools,
            requires_tool=True,
            completion_tools=frozenset({"weather_current", "weather_forecast"}),
            temperature=0.2,
            reason="weather",
        )

    if any(marker in current for marker in ("gmail", "email", "inbox")):
        tools = ("search_gmail", "read_gmail")
        return ToolPolicy(
            names=tools,
            requires_tool=True,
            completion_tools=frozenset(tools),
            temperature=0.2,
            reason="gmail",
        )

    if _has_phrase(current, "stack overflow", "stackoverflow"):
        return ToolPolicy(
            names=("search_stackoverflow",),
            requires_tool=True,
            completion_tools=frozenset({"search_stackoverflow"}),
            temperature=0.2,
            reason="stackoverflow",
        )

    if _has_phrase(current, "star wars", "wookieepedia", "swapi"):
        names = ("search_wookieepedia", "search_star_wars")
        return ToolPolicy(
            names=names,
            requires_tool=True,
            completion_tools=frozenset(names),
            temperature=0.2,
            reason="star-wars",
        )

    if _has_phrase(
        current,
        "search the web",
        "search online",
        "look up online",
        "latest news",
        "breaking news",
        "up to date",
        "most recent",
    ):
        return ToolPolicy(
            names=("search_web",),
            requires_tool=True,
            completion_tools=frozenset({"search_web"}),
            temperature=0.2,
            reason="web-search",
        )

    if _has_phrase(current, "jarvis device", "jarvis devices", "voice device", "voice devices"):
        return ToolPolicy(
            names=("list_jarvis_devices",),
            requires_tool=True,
            completion_tools=frozenset({"list_jarvis_devices"}),
            temperature=0.2,
            reason="jarvis-devices",
        )

    if voice_session and _is_dismissal(current):
        return ToolPolicy(
            names=("end_voice_session",),
            requires_tool=True,
            completion_tools=frozenset({"end_voice_session"}),
            temperature=0.1,
            reason="end-session",
        )

    return ToolPolicy(
        names=CONVERSATION_TOOLS,
        completion_tools=frozenset(CONVERSATION_TOOLS),
    )
