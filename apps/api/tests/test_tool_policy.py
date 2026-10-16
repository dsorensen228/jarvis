from jarvis_api.tool_policy import ROUTED_TOOL_NAMES, select_tool_policy
from jarvis_api.tools import ToolRegistry


def _voice_policy(text: str, room: str = "Office", previous: str = ""):
    return select_tool_policy(
        text,
        voice_session=True,
        device_id="voice-three",
        device_room=room,
        previous_user_text=previous,
    )


def test_simple_room_light_commands_force_one_zero_argument_tool():
    assert _voice_policy("Lights on.").names == ("room_lights_on",)
    assert _voice_policy("Turn the office lights on, please.").names == ("room_lights_on",)
    assert _voice_policy("Could you switch the lights off?").names == ("room_lights_off",)
    assert _voice_policy("Lights on.").requires_tool is True


def test_smart_home_inventory_requests_require_only_the_read_tool():
    phrases = (
        "List smart devices in the Office.",
        "Which smart plugs do I have?",
        "Show me the lights in the office.",
        "What smart-home devices are assigned to Office?",
        "List my TVs.",
        "Use list_smart_devices and tell me only the names of smart-home devices assigned "
        "to Office. Do not change any device or setting.",
    )
    for text in phrases:
        for voice in (False, True):
            policy = select_tool_policy(text, voice_session=voice, device_id=None, device_room="")
            assert policy.names == ("list_smart_devices",), text
            assert policy.requires_tool is True
            assert policy.completion_tools == frozenset({"list_smart_devices"})


def test_inventory_routing_does_not_remove_requested_controls():
    for text in ("List the lights, then turn them off.", "List smart plugs and switch one off."):
        assert _voice_policy(text).reason != "smart-home-inventory"


def test_named_other_room_and_complex_light_commands_use_general_light_tool():
    named_room = _voice_policy("Turn the bedroom lights on.")
    color = _voice_policy("Make all the lights blue.")
    assert named_room.names == ("control_lights",)
    assert color.names == ("control_lights",)
    assert named_room.requires_tool is True
    assert color.requires_tool is True


def test_referential_followup_inherits_device_ui_domain():
    policy = _voice_policy("Close it.", previous="Open Patreon.")
    assert "close_browser" in policy.names
    assert policy.requires_tool is True


def test_play_request_requires_a_playback_tool_and_offers_one_shot_play():
    policy = _voice_policy("Play some music by the Beatles.")
    assert "spotify_play_best_match" in policy.names
    assert policy.requires_tool is True
    # One playback tool call must satisfy the turn without a second model turn.
    assert "spotify_play_best_match" in policy.completion_tools
    assert "spotify_search" not in policy.completion_tools


def test_stop_forces_end_session_but_general_chat_has_only_web_search():
    stop = _voice_policy("Stop.")
    chat = _voice_policy("Tell me a joke.")
    assert stop.names == ("end_voice_session",)
    assert stop.requires_tool is True
    assert chat.names == ("search_web", "end_voice_session")
    assert chat.requires_tool is False
    assert chat.reason == "conversation"


def test_conversational_dismissals_force_the_end_session_tool():
    phrases = (
        "We're done.",
        "We are done here.",
        "That's all.",
        "That's all, thanks.",
        "That will be all, Jarvis.",
        "That's it.",
        "I'm done.",
        "All done.",
        "Nothing else.",
        "Never mind.",
        "Forget it.",
        "Thank you, Jarvis.",
        "Thanks.",
        "Good night.",
        "That's everything.",
    )
    for phrase in phrases:
        policy = _voice_policy(phrase)
        assert policy.names == ("end_voice_session",), phrase
        assert policy.requires_tool is True, phrase
        assert policy.reason == "end-session", phrase


def test_dismissal_wording_inside_a_real_request_does_not_end_the_session():
    assert _voice_policy("What's the weather tonight, thanks?").reason == "weather"
    assert _voice_policy("Are we done with the laundry timer?").reason == "clock"
    assert _voice_policy("Tell me about the Battle of Hastings.").reason == "conversation"


def test_a_dismissal_phrase_only_ends_a_session_as_the_whole_utterance():
    # A dismissal is how a request ends, not a substring of one; routing these to the
    # exit tool hangs up on a question the owner is still asking.
    requests = (
        "I'm done with work, what should I make for dinner?",
        "There is nothing else I need to worry about, right?",
        "Tell the dog to go away.",
        "Never mind that, tell me about the Battle of Hastings.",
        "How do you say goodbye in Portuguese?",
    )
    for phrase in requests:
        policy = _voice_policy(phrase)
        assert policy.reason != "end-session", phrase
        assert policy.names != ("end_voice_session",), phrase


def test_stacked_dismissals_still_end_the_session():
    for phrase in ("That's all, thank you.", "Okay thanks, goodbye.", "All done, good night."):
        assert _voice_policy(phrase).reason == "end-session", phrase


def test_closing_a_browser_page_pins_the_close_tool():
    # The model reliably mistakes "close the <site> tab" for a touchscreen tab change,
    # which silently returns to standby and leaves the page open.
    for phrase in (
        "Close the Netflix tab.",
        "close the Netflix tab.",
        "Close the Patreon tab.",
        "Close the Wikipedia tab.",
        "Close the browser.",
        "Close this page.",
        "Exit Netflix.",
        "Get rid of the Hulu tab.",
    ):
        policy = _voice_policy(phrase)
        assert policy.names == ("close_browser",), phrase
        assert policy.requires_tool is True, phrase
        assert policy.reason == "browser-close", phrase


def test_navigating_to_a_touchscreen_screen_pins_the_navigation_tool():
    # A named device screen must win over the domain keyword it shares, or the
    # navigation tool never reaches the model.
    for phrase in (
        "Open the Spotify tab.",
        "Show me the cameras screen.",
        "Go to the timer tab.",
        "Take me to the TV screen.",
        "Go back to standby.",
        "Close the Spotify tab.",
    ):
        policy = _voice_policy(phrase)
        assert policy.names == ("navigate_device_ui",), phrase
        assert policy.requires_tool is True, phrase
        assert policy.reason == "device-navigation", phrase


def test_closing_a_device_feature_is_not_treated_as_a_screen_change():
    # "Dismiss the alarm" operates the clock; only an explicit screen word navigates.
    assert _voice_policy("Dismiss the alarm.").reason == "clock"
    assert _voice_policy("Turn off the alarm.").reason == "clock"
    assert _voice_policy("Quit playing music.").reason == "spotify"
    assert _voice_policy("Quit playing music.").requires_tool is True


def test_a_bare_play_request_reaches_spotify_playback():
    # Without a playback route the model answers with a Spotify URI instead of playing.
    policy = _voice_policy("Play Here Comes the Sun by the Beatles.")
    assert "spotify_play_best_match" in policy.names
    assert policy.requires_tool is True
    assert "spotify_play_best_match" in policy.completion_tools


def test_video_requests_still_reach_the_television_route():
    assert _voice_policy("Play the next episode.").reason == "television"
    assert _voice_policy("Put on Arrested Development.").reason == "television"


def test_tv_controls_do_not_change_jarvis_volume_or_open_its_browser():
    for phrase in (
        "Mute the TV.",
        "Turn the office television volume down.",
        "Make the Roku quieter.",
        "Open Netflix on the TV.",
        "Open Spotify on the office TV.",
        "Search for a movie on Roku.",
        "Type Wikipedia in the TV search field.",
        "Tune the TV to channel 7.1.",
        "Find the remote.",
    ):
        policy = _voice_policy(phrase)
        assert policy.reason == "television", phrase
        assert policy.requires_tool is True, phrase
        assert "control_smart_device" in policy.names
        assert "set_system_volume" not in policy.names
        assert "navigate_device_ui" not in policy.names
        assert "put_on_title" not in policy.names
    assert _voice_policy("Turn your volume down.").reason == "volume"
    assert _voice_policy("Open the Spotify tab.").reason == "device-navigation"
    assert _voice_policy("Put on some music.").reason == "spotify"
    for phrase in (
        "What's the TV volume?",
        "What are the search results on the TV?",
        "What is playing on the Roku?",
    ):
        assert _voice_policy(phrase).requires_tool is False, phrase


def test_voice_conversation_can_always_reach_the_end_session_tool():
    assert "end_voice_session" in _voice_policy("Tell me a joke.").names
    assert "end_voice_session" in _voice_policy("What do you think of jazz?").names
    # A forced action turn must not offer an escape hatch from the required tool.
    assert "end_voice_session" not in _voice_policy("Lights on.").names


def test_text_sessions_never_receive_the_end_session_tool():
    policy = select_tool_policy(
        "Tell me a joke.",
        voice_session=False,
        device_id=None,
        device_room="",
    )
    assert policy.names == ("search_web",)


def test_unrecognized_or_misheard_speech_stays_on_the_bounded_search_path():
    policy = _voice_policy("Purple monkey dishwasher, apparently.")
    assert policy.names == ("search_web", "end_voice_session")
    assert policy.requires_tool is False


def test_non_conversational_capabilities_have_explicit_routes():
    class CapabilitiesStub:
        pass

    registry = ToolRegistry(CapabilitiesStub(), integrations=object())
    registered = {schema["function"]["name"] for schema in registry.schemas()}
    assert ROUTED_TOOL_NAMES == registered


def test_previously_general_domains_get_bounded_tool_surfaces():
    assert _voice_policy("What time is it?").reason == "datetime"
    assert _voice_policy("What do you see on the side camera?").reason == "camera"
    assert _voice_policy("Remember that I prefer tea.").reason == "memory"
    assert _voice_policy("Search the web for the latest news.").names == ("search_web",)


def test_explicit_web_search_wins_over_device_and_media_keywords():
    for phrase in (
        "Hey Jarvis, this is not a smart device control command. I want you to search "
        "the web and tell me about the TV series called Lanterns.",
        "Search the web for smart lights.",
        "Search online for the movie Spotlight.",
    ):
        for voice in (False, True):
            policy = select_tool_policy(
                phrase,
                voice_session=voice,
                device_id="voice-three",
                device_room="Office",
                previous_user_text="Put on Lanterns.",
            )
            assert policy.names == ("search_web",), phrase
            assert policy.requires_tool is True


def test_media_questions_do_not_offer_device_controls():
    for phrase in (
        "Tell me about the TV series called Lanterns.",
        "What is the HBO series Lanterns about?",
        "Who stars in the movie Spotlight?",
        "When does the TV show Lanterns come out?",
        "Tell me about the series Friday Night Lights.",
    ):
        policy = _voice_policy(phrase, previous="Put on Lanterns.")
        assert "search_web" in policy.names, phrase
        assert "control_smart_device" not in policy.names, phrase
        assert "control_lights" not in policy.names, phrase
        assert "put_on_title" not in policy.names, phrase


def test_title_playback_cannot_be_mistaken_for_smart_device_control():
    for phrase in (
        "Put on Lanterns.",
        "Please put on Lanterns on HBO Max.",
        "Play the TV series Lanterns.",
        "Put on the movie Spotlight.",
    ):
        policy = _voice_policy(phrase)
        assert policy.names == ("put_on_title",), phrase
        assert policy.requires_tool is True, phrase


def test_background_tasks_win_over_the_subject_they_are_researching_or_changing():
    for phrase in (
        "Create a Code Factory task to fix the lights UI.",
        "Start a coding task to update the music tab.",
    ):
        policy = _voice_policy(phrase)
        assert "create_code_task" in policy.names
        assert policy.requires_tool
    for phrase in (
        "Create a research task comparing smart lights.",
        "Start a research task about the TV series Lanterns.",
        "Create a research report: search the web for new OLED TVs.",
    ):
        policy = _voice_policy(phrase)
        assert "create_research_task" in policy.names
        assert policy.requires_tool
