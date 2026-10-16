from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from jarvis_api.smarthome.client import HomeAssistantClient
from jarvis_api.smarthome.commands import (
    ServiceCall,
    plan,
    resolve_app_source,
    select_component,
)
from jarvis_api.smarthome.discovery import group_by_device, retain_component_keys, stable_device_id
from jarvis_api.smarthome.migration import migrate_row, needs_migration
from jarvis_api.smarthome.model import SmartHomeError, SmartHomeUnavailable
from jarvis_api.smarthome.service import SmartHomeService, select_lights
from jarvis_api.store import SqliteStore

OWNER = "owner"
OTHER_OWNER = "intruder"

# Synthetic fixture ids, with the vendor-derived identity invariant preserved.
OFFICE_1_ID = "3817ba5ef25ab74edce3fd28af496ef7"
OFFICE_ROKU_ID = "5a092da7b89346030b6b18388b949116"
DUAL_PLUG_ID = "713eedf705d2be9b4bcd858410bce5e6"
DESK_LIGHT_ID = "f47a8734877faebfaca6f1589b20efdf"
KITCHEN_1_ID = "07458c36eaa06d7aae70985b09baf2f2"


@pytest.fixture
async def store(tmp_path):
    store = SqliteStore(str(tmp_path / "smart-home.sqlite3"))
    await store.start()
    yield store
    await store.close()


@pytest.fixture
async def service(store, home_assistant):
    return SmartHomeService(store, home_assistant)


# --------------------------------------------------------------- identity


def test_imported_ids_match_the_ids_vendor_imports_already_produced():
    """Room assignments and scheduled references hang off these ids."""
    assert stable_device_id("govee_openapi", "02:00:00:00:00:00:00:01") == OFFICE_1_ID
    assert stable_device_id("roku", "EXAMPLETV001") == OFFICE_ROKU_ID
    # The legacy derivation, spelled out.
    assert OFFICE_1_ID == hashlib.sha256(b"govee:02:00:00:00:00:00:00:01").hexdigest()[:32]
    assert OFFICE_ROKU_ID == hashlib.sha256(b"roku:EXAMPLETV001").hexdigest()[:32]


def test_an_unmapped_integration_gets_its_own_id_namespace():
    assert stable_device_id("hue", "abc") == hashlib.sha256(b"hue:abc").hexdigest()[:32]


# -------------------------------------------------------------- discovery


@pytest.mark.asyncio
async def test_one_device_collects_every_entity_that_belongs_to_it(home_assistant):
    devices = group_by_device(await home_assistant.registry(), await home_assistant.states())
    by_id = {device["id"]: device for device in devices}

    # A Roku is one device with a media_player and a remote, not two devices.
    roku = by_id[OFFICE_ROKU_ID]
    assert [component["domain"] for component in roku["components"]] == [
        "media_player",
        "remote",
    ]
    assert roku["capabilities"] == [
        "app_launch",
        "channel_tune",
        "mute",
        "playback",
        "power",
        "remote_keys",
        "search",
        "text_input",
        "volume",
    ]

    # A dual plug is one device whose sockets are addressable components.
    plug = by_id[DUAL_PLUG_ID]
    assert [component["key"] for component in plug["components"]] == [
        "main",
        "socket_1",
        "socket_2",
    ]
    assert [component["name"] for component in plug["components"]] == [
        "",
        "Socket 1",
        "Socket 2",
    ]


@pytest.mark.asyncio
async def test_capabilities_are_read_from_home_assistant_not_assumed(home_assistant):
    devices = group_by_device(await home_assistant.registry(), await home_assistant.states())
    by_id = {device["id"]: device for device in devices}

    light = by_id[OFFICE_1_ID]["components"][0]
    assert light["capabilities"] == ["power", "brightness", "color", "color_temperature"]
    # Kelvin bounds differ per model and must come from the device.
    assert (light["min_kelvin"], light["max_kelvin"]) == (2700, 6500)

    # A plug advertises power and nothing more, whatever its name suggests.
    assert by_id[DESK_LIGHT_ID]["capabilities"] == ["power"]


# --------------------------------------------------------- capability guards


def test_an_action_a_device_cannot_perform_is_refused_before_home_assistant_sees_it():
    plug = {
        "name": "Desk light",
        "components": [
            {
                "key": "main",
                "entity_id": "switch.desk_light",
                "domain": "switch",
                "capabilities": ["power"],
            }
        ],
    }
    assert select_component(plug, "turn_on")["entity_id"] == "switch.desk_light"
    with pytest.raises(SmartHomeError, match="cannot brightness"):
        select_component(plug, "brightness")
    with pytest.raises(SmartHomeError, match="unsupported smart-home action"):
        select_component(plug, "explode")


def test_power_prefers_the_media_player_over_the_remote_on_a_television():
    roku = {
        "name": "Demo TV",
        "components": [
            {
                "key": "main",
                "entity_id": "media_player.office",
                "domain": "media_player",
                "capabilities": ["power", "volume", "playback"],
            },
            {
                "key": "remote",
                "entity_id": "remote.office",
                "domain": "remote",
                "capabilities": ["power", "remote_keys"],
            },
        ],
    }
    assert select_component(roku, "turn_on")["domain"] == "media_player"
    assert select_component(roku, "key")["domain"] == "remote"


def test_addressing_a_socket_by_name_targets_only_that_socket():
    plug = {
        "name": "Office Dual Smart Plug",
        "components": [
            {
                "key": "main",
                "entity_id": "switch.plug",
                "domain": "switch",
                "capabilities": ["power"],
            },
            {
                "key": "socket_2",
                "entity_id": "switch.plug_socket_2",
                "domain": "switch",
                "capabilities": ["power"],
            },
        ],
    }
    assert select_component(plug, "turn_on", "socket_2")["entity_id"] == "switch.plug_socket_2"
    with pytest.raises(SmartHomeError, match="no component named"):
        select_component(plug, "turn_on", "socket_9")


# ------------------------------------------------------ capability conversion


@pytest.mark.parametrize(
    ("action", "parameters", "expected"),
    [
        ("turn_on", {}, ServiceCall("light", "turn_on", {"entity_id": "light.x"})),
        ("turn_off", {}, ServiceCall("light", "turn_off", {"entity_id": "light.x"})),
        (
            "brightness",
            {"percent": 50},
            ServiceCall("light", "turn_on", {"entity_id": "light.x", "brightness": 128}),
        ),
        (
            "brightness",
            {"percent": 100},
            ServiceCall("light", "turn_on", {"entity_id": "light.x", "brightness": 255}),
        ),
        (
            "color",
            {"red": 10, "green": 20, "blue": 30},
            ServiceCall("light", "turn_on", {"entity_id": "light.x", "rgb_color": [10, 20, 30]}),
        ),
        (
            "color_temperature",
            {"kelvin": 4000},
            ServiceCall("light", "turn_on", {"entity_id": "light.x", "color_temp_kelvin": 4000}),
        ),
    ],
)
def test_light_actions_become_home_assistant_service_calls(action, parameters, expected):
    component = {
        "key": "main",
        "entity_id": "light.x",
        "domain": "light",
        "capabilities": ["power", "brightness", "color", "color_temperature"],
        "min_kelvin": 2700,
        "max_kelvin": 6500,
    }
    call, _ = plan(component, action, parameters)
    assert call == expected


def test_out_of_range_values_are_clamped_to_what_the_device_accepts():
    component = {
        "key": "main",
        "entity_id": "light.x",
        "domain": "light",
        "capabilities": ["brightness", "color", "color_temperature"],
        "min_kelvin": 2700,
        "max_kelvin": 6500,
    }
    # Brightness is a percentage on the Jarvis side and 0-255 inside Home Assistant.
    assert plan(component, "brightness", {"percent": 999})[0].data["brightness"] == 255
    assert plan(component, "brightness", {"percent": 0})[0].data["brightness"] == 3

    # A model that stops at 6500K must not be asked for 9000K.
    def kelvin(requested):
        return plan(component, "color_temperature", {"kelvin": requested})[0].data[
            "color_temp_kelvin"
        ]

    assert kelvin(9000) == 6500
    assert kelvin(1000) == 2700
    assert plan(component, "color", {"red": 999, "green": -5, "blue": 20})[0].data["rgb_color"] == [
        255,
        0,
        20,
    ]


def test_a_missing_required_parameter_is_reported_rather_than_guessed():
    component = {
        "key": "main",
        "entity_id": "light.x",
        "domain": "light",
        "capabilities": ["brightness", "color"],
    }
    with pytest.raises(SmartHomeError, match="brightness percent is required"):
        plan(component, "brightness", {})
    with pytest.raises(SmartHomeError, match="color requires red, green, and blue"):
        plan(component, "color", {"red": 1})


@pytest.mark.parametrize(
    ("action", "expected"),
    [
        ("turn_on", ServiceCall("media_player", "turn_on", {"entity_id": "media_player.x"})),
        ("turn_off", ServiceCall("media_player", "turn_off", {"entity_id": "media_player.x"})),
        ("volume_up", ServiceCall("media_player", "volume_up", {"entity_id": "media_player.x"})),
        (
            "volume_down",
            ServiceCall("media_player", "volume_down", {"entity_id": "media_player.x"}),
        ),
        ("play", ServiceCall("media_player", "media_play", {"entity_id": "media_player.x"})),
        ("pause", ServiceCall("media_player", "media_pause", {"entity_id": "media_player.x"})),
        (
            "play_pause",
            ServiceCall("media_player", "media_play_pause", {"entity_id": "media_player.x"}),
        ),
        (
            "mute",
            ServiceCall(
                "media_player",
                "volume_mute",
                {"entity_id": "media_player.x", "is_volume_muted": True},
            ),
        ),
        (
            "unmute",
            ServiceCall(
                "media_player",
                "volume_mute",
                {"entity_id": "media_player.x", "is_volume_muted": False},
            ),
        ),
    ],
)
def test_media_actions_become_home_assistant_service_calls(action, expected):
    component = {
        "key": "main",
        "entity_id": "media_player.x",
        "domain": "media_player",
        "capabilities": ["power", "volume", "mute", "playback"],
    }
    call, _ = plan(component, action, {})
    assert call == expected


@pytest.mark.parametrize(
    ("neutral", "command"),
    [
        ("home", "home"),
        ("back", "back"),
        ("up", "up"),
        ("down", "down"),
        ("left", "left"),
        ("right", "right"),
        ("select", "select"),
        ("rewind", "reverse"),
        ("fast_forward", "forward"),
        ("replay", "replay"),
        ("info", "info"),
        ("channel_up", "channel_up"),
        ("channel_down", "channel_down"),
    ],
)
def test_every_remote_key_maps_to_a_command_home_assistant_accepts(neutral, command):
    component = {
        "key": "remote",
        "entity_id": "remote.x",
        "domain": "remote",
        "capabilities": ["power", "remote_keys"],
    }
    call, outcome = plan(component, "key", {"key": neutral})
    assert call == ServiceCall(
        "remote", "send_command", {"entity_id": "remote.x", "command": command}
    )
    assert outcome == {"key": neutral}


def test_an_unknown_remote_key_is_refused_with_the_supported_set():
    component = {
        "key": "remote",
        "entity_id": "remote.x",
        "domain": "remote",
        "capabilities": ["remote_keys"],
    }
    with pytest.raises(SmartHomeError, match="unsupported remote key"):
        plan(component, "key", {"key": "eject"})


# ------------------------------------------------------------- app launching


def test_app_matching_keeps_the_shortest_case_insensitive_substring():
    sources = ["Netflix", "Netflix Kids", "Work MBP", "Hulu"]
    assert resolve_app_source("netflix", sources) == "Netflix"
    assert resolve_app_source("NETFLIX KIDS", sources) == "Netflix Kids"
    assert resolve_app_source("hul", sources) == "Hulu"
    assert resolve_app_source("disney", sources) is None
    assert resolve_app_source("", sources) is None


def test_an_exact_source_wins_over_a_shorter_substring_match():
    assert resolve_app_source("Netflix Kids", ["Netflix", "Netflix Kids"]) == "Netflix Kids"


def test_an_app_id_is_passed_straight_through():
    component = {
        "key": "main",
        "entity_id": "media_player.x",
        "domain": "media_player",
        "capabilities": ["app_launch"],
    }
    call, outcome = plan(
        component, "launch_app", {"app_id": "tvinput.hdmi1"}, {"source_list": ["Netflix"]}
    )
    assert call.data["source"] == "tvinput.hdmi1"
    assert outcome == {"app": "tvinput.hdmi1"}


def test_an_app_name_that_matches_nothing_lists_what_is_installed():
    component = {
        "key": "main",
        "entity_id": "media_player.x",
        "domain": "media_player",
        "capabilities": ["app_launch"],
    }
    with pytest.raises(SmartHomeError, match="Hulu, Netflix"):
        plan(component, "launch_app", {"app": "disney"}, {"source_list": ["Netflix", "Hulu"]})


# ------------------------------------------------------------ light scoping


def test_light_scopes_resolve_the_same_way_they_always_have():
    lights = [
        {"id": "one", "name": "Desk light", "room": "Office"},
        {"id": "two", "name": "Floor lamp", "room": "Office"},
        {"id": "three", "name": "Sink light", "room": "Kitchen"},
    ]
    assert [row["id"] for row in select_lights(lights, "room", "office")] == ["one", "two"]
    assert select_lights(lights, "device", "desk")[0]["id"] == "one"
    assert len(select_lights(lights, "all", "")) == 3
    with pytest.raises(SmartHomeError, match="ambiguous"):
        select_lights(lights, "device", "l")
    with pytest.raises(SmartHomeError, match="scope must be"):
        select_lights(lights, "floor", "")


# ------------------------------------------------------------------- sync


@pytest.mark.asyncio
async def test_sync_imports_every_device_and_is_idempotent(service, home_assistant):
    # Eight entities, five devices: the plug's sockets and the Roku's remote are
    # components rather than devices of their own.
    first = await service.sync(OWNER)
    assert len(first) == 5
    assert {device["id"] for device in first} == {
        OFFICE_1_ID,
        KITCHEN_1_ID,
        OFFICE_ROKU_ID,
        DUAL_PLUG_ID,
        DESK_LIGHT_ID,
    }

    second = await service.sync(OWNER)
    assert sorted(device["id"] for device in first) == sorted(device["id"] for device in second)
    assert [device["components"] for device in sorted(first, key=lambda d: d["id"])] == [
        device["components"] for device in sorted(second, key=lambda d: d["id"])
    ]


@pytest.mark.asyncio
async def test_sync_never_overwrites_what_the_owner_set(service, store):
    await service.sync(OWNER)
    await store.update_entity(
        "smart_device",
        OFFICE_1_ID,
        OWNER,
        {"name": "Reading lamp", "room": "Study", "component_labels": {"main": "Bulb"}},
    )

    await service.sync(OWNER)

    device = await store.get_entity("smart_device", OFFICE_1_ID, OWNER)
    assert device["name"] == "Reading lamp"
    assert device["room"] == "Study"
    assert device["component_labels"] == {"main": "Bulb"}
    # Discovery still refreshes what it owns.
    assert device["source_name"] == "Office 1"


@pytest.mark.asyncio
async def test_sync_preserves_explicit_light_membership_after_initial_reconciliation(
    service, store
):
    await service.sync(OWNER)
    await store.update_entity("smart_device", OFFICE_1_ID, OWNER, {"is_light": False})
    await store.update_entity("smart_device", DUAL_PLUG_ID, OWNER, {"is_light": True})
    await service.sync(OWNER)
    assert (await store.get_entity("smart_device", OFFICE_1_ID, OWNER))["is_light"] is False
    assert (await store.get_entity("smart_device", DUAL_PLUG_ID, OWNER))["is_light"] is True


def test_multiple_generic_components_have_unique_order_independent_control_keys():
    rows = [
        {"entity_id": entity, "device_id": "multi", "identifiers": [["mqtt", "multi"]]}
        for entity in ["switch.outlet_b", "switch.outlet_a", "remote.outlet"]
    ]
    first = group_by_device(rows, {})[0]
    second = group_by_device(list(reversed(rows)), {})[0]
    keys = {item["entity_id"]: item["key"] for item in first["components"]}
    assert len(set(keys.values())) == 3
    assert keys == {item["entity_id"]: item["key"] for item in second["components"]}
    for entity_id, key in keys.items():
        assert select_component(first, "turn_on", key)["entity_id"] == entity_id


def test_adding_an_entity_does_not_retarget_the_existing_main_component():
    def row(entity):
        return {"entity_id": entity, "device_id": "multi", "identifiers": [["mqtt", "multi"]]}

    original = group_by_device([row("switch.outlet_b")], {})[0]
    updated = group_by_device([row("switch.outlet_a"), row("switch.outlet_b")], {})[0]
    retain_component_keys(original["components"], updated["components"])
    assert select_component(updated, "turn_on", "main")["entity_id"] == "switch.outlet_b"
    assert len({item["key"] for item in updated["components"]}) == 2


@pytest.mark.asyncio
async def test_virtual_entity_without_a_device_registry_entry_can_be_imported_and_removed(
    service, home_assistant
):
    home_assistant._registry.append({"entity_id": "switch.virtual", "identifiers": []})
    home_assistant._states["switch.virtual"] = {"state": "off", "attributes": {}}
    await service.sync(OWNER)
    status = await service.status(OWNER)
    assert status["imported_count"] == status["device_count"]
    virtual_id = stable_device_id("home_assistant", "switch.virtual")
    await service.control_device(OWNER, virtual_id, "turn_on")
    home_assistant._registry.pop()
    del home_assistant._states["switch.virtual"]
    await service.sync(OWNER)
    row = await service.get_device(OWNER, virtual_id)
    assert row["components"] == []
    assert (await service.status(OWNER))["orphaned_count"] == 1


@pytest.mark.parametrize("key", ["enter", "backspace", "search", "input_hdmi1", "volume_mute"])
def test_remote_keys_preserve_supported_television_controls(key):
    call, _ = plan({"entity_id": "remote.tv", "domain": "remote"}, "key", {"key": key})
    assert call.data["command"] == key


def test_remote_text_preserves_case_and_spaces():
    call, _ = plan(
        {"entity_id": "remote.tv", "domain": "remote"}, "key", {"key": "Lit_Hello World"}
    )
    assert call.data["command"] == "Lit_Hello World"


@pytest.mark.asyncio
async def test_a_device_home_assistant_stops_reporting_is_kept_and_marked_unavailable(
    service, store, home_assistant
):
    await service.sync(OWNER)
    await store.update_entity("smart_device", OFFICE_ROKU_ID, OWNER, {"room": "Office"})

    home_assistant.drop("media_player.demo_tv")
    home_assistant.drop("remote.demo_tv")
    devices = {device["id"]: device for device in await service.sync(OWNER)}

    retained = devices[OFFICE_ROKU_ID]
    assert retained["room"] == "Office"
    assert retained["available"] is False
    assert retained["components"] == []
    # Still addressable as a record, just not controllable.
    with pytest.raises(SmartHomeUnavailable, match="not currently provided"):
        await service.control_device(OWNER, OFFICE_ROKU_ID, "turn_on")


@pytest.mark.asyncio
async def test_a_newly_discovered_switch_is_not_swept_into_light_control(service, store):
    await service.sync(OWNER)
    plug = await store.get_entity("smart_device", DUAL_PLUG_ID, OWNER)
    light = await store.get_entity("smart_device", OFFICE_1_ID, OWNER)
    assert plug["is_light"] is False
    assert light["is_light"] is True


# -------------------------------------------------------------- state read


@pytest.mark.asyncio
async def test_state_reports_brightness_colour_and_per_socket_power(service):
    devices = {device["id"]: device for device in await service.sync(OWNER)}

    light = devices[OFFICE_1_ID]["components"][0]
    assert light["power"] is True
    assert light["brightness_percent"] == 100
    assert light["color"] == [255, 180, 120]
    assert light["kelvin"] == 3000

    sockets = {c["key"]: c for c in devices[DUAL_PLUG_ID]["components"]}
    assert sockets["socket_1"]["power"] is True
    assert sockets["socket_2"]["power"] is False


@pytest.mark.asyncio
async def test_an_unreachable_entity_reports_unknown_power_rather_than_off(service, home_assistant):
    await service.sync(OWNER)
    home_assistant.set_state("light.office_1", "unavailable")

    device = await service.device_state(OWNER, OFFICE_1_ID)
    assert device["available"] is False
    assert device["power"] is None
    assert device["components"][0]["power"] is None
    assert "brightness_percent" not in device["components"][0]


@pytest.mark.asyncio
async def test_a_listing_still_renders_when_home_assistant_is_down(service, home_assistant):
    await service.sync(OWNER)
    home_assistant.fail_states = SmartHomeUnavailable("Home Assistant is unreachable")

    devices = {device["id"]: device for device in await service.list_devices(OWNER)}
    assert devices[OFFICE_1_ID]["name"] == "Office 1"
    assert devices[OFFICE_1_ID]["available"] is False
    assert devices[OFFICE_1_ID]["power"] is None


@pytest.mark.asyncio
async def test_status_reports_the_platform_and_never_the_token(service):
    await service.sync(OWNER)
    status = await service.status(OWNER)
    assert status["platform"] == "home_assistant"
    assert status["configured"] is True
    assert status["connected"] is True
    assert status["version"] == "2026.9.3"
    assert status["device_count"] == 5
    assert status["imported_count"] == 5
    assert status["orphaned_count"] == 0
    assert status["error"] == ""
    assert "token" not in repr(status).lower()


@pytest.mark.asyncio
async def test_status_reports_the_reason_when_home_assistant_cannot_be_reached(
    service, home_assistant
):
    async def unreachable():
        raise SmartHomeUnavailable("Home Assistant at http://uno-q:8123 is unreachable")

    home_assistant.version = unreachable
    status = await service.status(OWNER)
    assert status["connected"] is False
    assert "unreachable" in status["error"]


@pytest.mark.asyncio
async def test_status_says_so_when_no_home_assistant_is_configured(service, home_assistant):
    home_assistant.configured = False
    status = await service.status(OWNER)
    assert status["connected"] is False
    assert status["error"] == "Home Assistant is not configured"


# ---------------------------------------------------------------- control


@pytest.mark.asyncio
async def test_controlling_a_light_calls_the_light_domain(service, home_assistant):
    await service.sync(OWNER)
    result = await service.control_device(OWNER, OFFICE_1_ID, "brightness", {"percent": 40})

    assert home_assistant.calls == [
        ("light", "turn_on", {"entity_id": "light.office_1", "brightness": 102})
    ]
    assert result["brightness_percent"] == 40
    assert result["entity_id"] == "light.office_1"


@pytest.mark.asyncio
async def test_controlling_one_socket_leaves_the_other_alone(service, home_assistant):
    await service.sync(OWNER)
    await service.control_device(OWNER, DUAL_PLUG_ID, "turn_off", {"component": "socket_2"})
    assert home_assistant.calls == [
        ("switch", "turn_off", {"entity_id": "switch.office_dual_smart_plug_socket_2"})
    ]


@pytest.mark.asyncio
async def test_unavailable_entity_is_not_reported_as_success(service, home_assistant):
    await service.sync(OWNER)
    home_assistant.set_state("light.office_1", "unavailable")
    with pytest.raises(SmartHomeUnavailable, match="unavailable in Home Assistant"):
        await service.control_device(OWNER, OFFICE_1_ID, "turn_on")
    assert home_assistant.calls == []


@pytest.mark.asyncio
async def test_unknown_power_can_still_be_controlled(service, home_assistant):
    await service.sync(OWNER)
    home_assistant.set_state("light.office_1", "unknown")
    await service.control_device(OWNER, OFFICE_1_ID, "turn_on")
    assert home_assistant.calls == [("light", "turn_on", {"entity_id": "light.office_1"})]


@pytest.mark.asyncio
async def test_bulk_lights_reports_unavailable_targets_as_failures(service, store, home_assistant):
    await service.sync(OWNER)
    for device_id in (OFFICE_1_ID, DESK_LIGHT_ID):
        await store.update_entity(
            "smart_device", device_id, OWNER, {"room": "Office", "is_light": True}
        )
    home_assistant.set_state("light.office_1", "unavailable")
    result = await service.control_lights(OWNER, "room", "Office", "turn_on", {})
    assert (result["succeeded"], result["failed"]) == (1, 1)
    assert home_assistant.calls == [("switch", "turn_on", {"entity_id": "switch.desk_light"})]


@pytest.mark.asyncio
async def test_launching_an_app_by_name_resolves_against_the_live_source_list(
    service, home_assistant
):
    await service.sync(OWNER)
    await service.control_device(OWNER, OFFICE_ROKU_ID, "launch_app", {"app": "netflix"})
    assert home_assistant.calls == [
        (
            "media_player",
            "select_source",
            {"entity_id": "media_player.demo_tv", "source": "Netflix"},
        )
    ]


@pytest.mark.asyncio
async def test_tv_state_uses_media_power_and_preserves_real_source_names(service, home_assistant):
    attributes = home_assistant._states["media_player.demo_tv"]["attributes"]
    attributes.update(
        {
            "source": "HDMI\u00a04\u00a0(eARC)",
            "source_list": ["Home", "Work MBP", "HDMI\u00a04\u00a0(eARC)", "Live\u00a0TV"],
            "app_id": "tvinput.hdmi4",
            "media_title": "Evening News",
            "media_channel": "7.1 - Local",
        }
    )
    await service.sync(OWNER)
    home_assistant.set_state("media_player.demo_tv", "off")
    # A remote's last state must not overrule authoritative TV power.
    home_assistant.set_state("remote.demo_tv", "on")
    device = await service.device_state(OWNER, OFFICE_ROKU_ID)
    assert device["power"] is False
    media = device["components"][0]
    assert media["apps"] == attributes["source_list"]
    assert media["app"] == attributes["source"]
    assert media["app_id"] == "tvinput.hdmi4"
    assert media["media_title"] == "Evening News"
    assert media["media_channel"] == "7.1 - Local"
    assert "muted" not in media and "volume_percent" not in media
    await service.control_device(
        OWNER, OFFICE_ROKU_ID, "select_source", {"source": "HDMI\u00a04\u00a0(eARC)"}
    )
    assert home_assistant.calls[-1][2]["source"] == "HDMI\u00a04\u00a0(eARC)"
    with pytest.raises(SmartHomeError, match="not available"):
        await service.control_device(OWNER, OFFICE_ROKU_ID, "select_source", {"source": "HDMI 5"})
    home_assistant.set_state("media_player.demo_tv", "unavailable")
    assert (await service.device_state(OWNER, OFFICE_ROKU_ID))["power"] is None


def test_exact_source_selection_does_not_normalize_the_owners_input_label():
    call, _ = plan(
        {"entity_id": "media_player.tv", "domain": "media_player"},
        "select_source",
        {"source": " Work MBP "},
        {"source_list": [" Work MBP "]},
    )
    assert call.data["source"] == " Work MBP "


@pytest.mark.asyncio
async def test_other_receivers_keep_their_own_volume_features_and_reported_state(
    service, home_assistant
):
    for row in home_assistant._registry:
        if row.get("device_id") == "ha-roku-office":
            row["identifiers"] = [["other_integration", "receiver"]]
    attrs = home_assistant._states["media_player.demo_tv"]["attributes"]
    attrs.update({"device_class": "receiver", "volume_level": 0.375, "is_volume_muted": False})
    device_id = stable_device_id("other_integration", "receiver")
    device = next(item for item in await service.sync(OWNER) if item["id"] == device_id)
    assert {"volume", "mute"} <= set(device["capabilities"])
    assert "channel_tune" not in device["capabilities"]
    media = device["components"][0]
    assert media["volume_percent"] == 38 and media["muted"] is False
    await service.control_device(OWNER, device_id, "mute_toggle")
    assert home_assistant.calls[-1][2]["is_volume_muted"] is True


@pytest.mark.asyncio
async def test_streaming_player_does_not_advertise_tv_controls_from_roku_feature_mask(
    service, home_assistant
):
    home_assistant._states["media_player.demo_tv"]["attributes"]["device_class"] = (
        "receiver"
    )
    device = next(item for item in await service.sync(OWNER) if item["id"] == OFFICE_ROKU_ID)
    assert not {"volume", "mute", "channel_tune"} & set(device["capabilities"])
    assert {"text_input", "search", "playback", "app_launch"} <= set(device["capabilities"])
    assert {"home", "back", "replay", "info", "play"} <= set(device["supported_keys"])
    assert not {"channel_up", "input_hdmi1", "volume_mute"} & set(device["supported_keys"])
    for action, params in [
        ("volume_up", {}),
        ("channel", {"channel": "7.1"}),
        ("key", {"key": "input_hdmi1"}),
    ]:
        with pytest.raises(SmartHomeError):
            await service.control_device(OWNER, OFFICE_ROKU_ID, action, params)
    assert home_assistant.calls == []


@pytest.mark.asyncio
async def test_new_tv_actions_route_to_the_correct_ha_entities_without_reimport(
    service, store, home_assistant
):
    await service.sync(OWNER)
    old = await service.get_device(OWNER, OFFICE_ROKU_ID)
    for component in old["components"]:
        component["capabilities"] = ["power", "remote_keys"]
    await store.update_entity(
        "smart_device", OFFICE_ROKU_ID, OWNER, {"components": old["components"]}
    )
    result = await service.control_device(OWNER, OFFICE_ROKU_ID, "text", {"text": "  Café & TV  "})
    assert result["text_length"] == len("  Café & TV  ") and "text" not in result
    await service.control_device(OWNER, OFFICE_ROKU_ID, "search", {"query": "Space Jam"})
    await service.control_device(OWNER, OFFICE_ROKU_ID, "channel", {"channel": "7.1"})
    assert home_assistant.calls == [
        (
            "remote",
            "send_command",
            {"entity_id": "remote.demo_tv", "command": "Lit_  Café & TV  "},
        ),
        (
            "roku",
            "search",
            {"entity_id": "media_player.demo_tv", "keyword": "Space Jam"},
        ),
        (
            "media_player",
            "play_media",
            {
                "entity_id": "media_player.demo_tv",
                "media_content_type": "channel",
                "media_content_id": "7.1",
            },
        ),
    ]


@pytest.mark.asyncio
async def test_find_remote_is_derived_from_its_live_diagnostic_not_its_name(
    service, home_assistant
):
    for row in home_assistant._registry:
        if row["entity_id"].startswith("remote."):
            row["find_remote_entity_id"] = "binary_sensor.renamed_by_owner"
    home_assistant._states["binary_sensor.renamed_by_owner"] = {"state": "on"}
    device = next(item for item in await service.sync(OWNER) if item["id"] == OFFICE_ROKU_ID)
    assert "find_remote" in device["capabilities"]
    assert "find_remote" in device["supported_keys"]
    await service.control_device(OWNER, OFFICE_ROKU_ID, "find_remote")
    assert home_assistant.calls[-1] == (
        "remote",
        "send_command",
        {"entity_id": "remote.demo_tv", "command": "find_remote"},
    )
    home_assistant.set_state("binary_sensor.renamed_by_owner", "unavailable")
    device = await service.device_state(OWNER, OFFICE_ROKU_ID)
    assert "find_remote" not in device["capabilities"]
    assert "find_remote" not in device["supported_keys"]
    for action, parameters in [("find_remote", {}), ("key", {"key": "find_remote"})]:
        with pytest.raises(SmartHomeError):
            await service.control_device(OWNER, OFFICE_ROKU_ID, action, parameters)
    assert len(home_assistant.calls) == 1


@pytest.mark.asyncio
async def test_roku_mute_is_an_explicit_toggle_when_state_is_unknown(service, home_assistant):
    await service.sync(OWNER)
    for action in ("mute", "unmute"):
        with pytest.raises(SmartHomeError, match="does not report mute state"):
            await service.control_device(OWNER, OFFICE_ROKU_ID, action)
    assert home_assistant.calls == []
    outcome = await service.control_device(OWNER, OFFICE_ROKU_ID, "mute_toggle")
    assert outcome["mute_toggled"] is True and "muted" not in outcome
    assert home_assistant.calls == [
        (
            "media_player",
            "volume_mute",
            {"entity_id": "media_player.demo_tv", "is_volume_muted": True},
        )
    ]


@pytest.mark.asyncio
async def test_roku_does_not_invert_an_already_satisfied_mute_request(service, home_assistant):
    home_assistant._states["media_player.demo_tv"]["attributes"]["is_volume_muted"] = (
        True
    )
    await service.sync(OWNER)
    outcome = await service.control_device(OWNER, OFFICE_ROKU_ID, "mute")
    assert outcome["muted"] is True
    assert home_assistant.calls == []


@pytest.mark.parametrize("text", ["", "x" * 257, "one\ntwo", "\x00", 42])
def test_text_entry_rejects_oversized_or_control_character_input(text):
    with pytest.raises(SmartHomeError):
        plan({"entity_id": "remote.tv", "domain": "remote"}, "text", {"text": text})


@pytest.mark.asyncio
async def test_registry_resolves_renamed_roku_diagnostics_without_exposing_them_as_devices(
    home_assistant, monkeypatch
):
    async def entity_registry(self):
        return [
            {
                "entity_id": "binary_sensor.custom_name",
                "platform": "roku",
                "device_id": "ha-roku-office",
                "unique_id": "EXAMPLETV001_supports_find_remote",
                "disabled_by": None,
            }
        ]

    monkeypatch.setattr(HomeAssistantClient, "_entity_registry", entity_registry)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, text=json.dumps(home_assistant._registry))
        )
    ) as http:
        client = HomeAssistantClient("http://ha.test:8123", "not-a-real-token", http)
        rows = await client.registry()
    assert len(rows) == len(home_assistant._registry)
    remote = next(row for row in rows if row["entity_id"].startswith("remote."))
    assert remote["find_remote_entity_id"] == "binary_sensor.custom_name"


@pytest.mark.asyncio
async def test_optional_roku_diagnostics_failure_does_not_block_device_sync(
    home_assistant, monkeypatch
):
    async def entity_registry(self):
        raise SmartHomeUnavailable("registry not accessible")

    monkeypatch.setattr(HomeAssistantClient, "_entity_registry", entity_registry)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, text=json.dumps(home_assistant._registry))
        )
    ) as http:
        client = HomeAssistantClient("http://ha.test:8123", "not-a-real-token", http)
        rows = await client.registry()
    assert rows == home_assistant._registry


@pytest.mark.asyncio
async def test_room_lights_only_touch_devices_marked_as_lights(service, store, home_assistant):
    await service.sync(OWNER)
    for device_id in (OFFICE_1_ID, DESK_LIGHT_ID, DUAL_PLUG_ID):
        await store.update_entity("smart_device", device_id, OWNER, {"room": "Office"})
    # The lamp on a plug counts as a light; the dual outlet does not.
    await store.update_entity("smart_device", DESK_LIGHT_ID, OWNER, {"is_light": True})

    result = await service.control_lights(OWNER, "room", "Office", "turn_off", {})

    assert result["succeeded"] == 2
    assert sorted(result["devices"]) == ["Desk light", "Office 1"]
    assert sorted(entity["entity_id"] for _, _, entity in home_assistant.calls) == [
        "light.office_1",
        "switch.desk_light",
    ]


@pytest.mark.asyncio
async def test_a_room_with_no_lights_fails_loudly(service):
    await service.sync(OWNER)
    with pytest.raises(SmartHomeError, match="no lights matched"):
        await service.control_lights(OWNER, "room", "Cellar", "turn_off", {})


@pytest.mark.asyncio
async def test_one_failing_light_does_not_abort_the_rest_of_the_room(
    service, store, home_assistant
):
    await service.sync(OWNER)
    for device_id in (OFFICE_1_ID, DESK_LIGHT_ID):
        await store.update_entity(
            "smart_device", device_id, OWNER, {"room": "Office", "is_light": True}
        )

    async def flaky(domain, service_name, data):
        if data.get("entity_id") == "light.office_1":
            raise SmartHomeUnavailable("bulb did not answer")
        home_assistant.calls.append((domain, service_name, data))

    home_assistant.call_service = flaky
    result = await service.control_lights(OWNER, "room", "Office", "turn_on", {})

    assert result["succeeded"] == 1
    assert result["failed"] == 1
    assert result["devices"] == ["Desk light"]
    assert "bulb did not answer" in result["errors"][0]


@pytest.mark.asyncio
async def test_a_room_where_every_light_fails_raises(service, store, home_assistant):
    await service.sync(OWNER)
    await store.update_entity(
        "smart_device", OFFICE_1_ID, OWNER, {"room": "Office", "is_light": True}
    )

    async def always_fails(domain, service_name, data):
        raise SmartHomeUnavailable("Home Assistant is unreachable")

    home_assistant.call_service = always_fails
    with pytest.raises(SmartHomeUnavailable, match="none of the selected lights responded"):
        await service.control_lights(OWNER, "room", "Office", "turn_on", {})


@pytest.mark.asyncio
async def test_room_light_power_distinguishes_unknown_from_off(service, store, home_assistant):
    await service.sync(OWNER)
    for device_id in (OFFICE_1_ID, DESK_LIGHT_ID):
        await store.update_entity(
            "smart_device", device_id, OWNER, {"room": "Office", "is_light": True}
        )

    assert await service.room_lights_power(OWNER, "office") == {
        "room": "office",
        "count": 2,
        "is_on": True,
        "unknown": 0,
    }

    home_assistant.set_state("light.office_1", "unavailable")
    home_assistant.set_state("switch.desk_light", "unavailable")
    assert await service.room_lights_power(OWNER, "Office") == {
        "room": "Office",
        "count": 2,
        "is_on": None,
        "unknown": 2,
    }


# ------------------------------------------------------- calling-room lights


@pytest.mark.asyncio
async def test_the_calling_device_room_is_resolved_on_the_server(service, store, home_assistant):
    await service.sync(OWNER)
    await store.update_entity(
        "smart_device", OFFICE_1_ID, OWNER, {"room": "Office", "is_light": True}
    )
    await store.create_entity(
        "device",
        OWNER,
        {"name": "voice-three", "kind": "voice", "room": "Office"},
        entity_id="voice-three",
    )

    result = await service.control_room_lights_for_device(OWNER, "voice-three", "turn_off")

    assert result["succeeded"] == 1
    assert home_assistant.calls == [("light", "turn_off", {"entity_id": "light.office_1"})]


@pytest.mark.asyncio
async def test_a_voice_device_without_a_room_cannot_control_room_lights(service, store):
    await store.create_entity(
        "device", OWNER, {"name": "probe", "kind": "voice", "room": ""}, entity_id="probe"
    )
    with pytest.raises(SmartHomeError, match="no room assigned"):
        await service.control_room_lights_for_device(OWNER, "probe", "turn_on")


@pytest.mark.asyncio
async def test_an_unregistered_voice_device_is_rejected(service):
    with pytest.raises(KeyError):
        await service.control_room_lights_for_device(OWNER, "ghost", "turn_on")
    with pytest.raises(SmartHomeError, match="device id is required"):
        await service.control_room_lights_for_device(OWNER, "", "turn_on")


# --------------------------------------------------------- display routing


@pytest.mark.asyncio
async def test_a_rooms_display_is_resolved_case_insensitively(service, store):
    await service.sync(OWNER)
    await store.update_entity("smart_device", OFFICE_ROKU_ID, OWNER, {"room": "Office"})

    for spelling in ("Office", "office", " OFFICE "):
        display = await service.resolve_room_display(OWNER, spelling)
        assert display is not None and display["id"] == OFFICE_ROKU_ID
    assert await service.resolve_room_display(OWNER, "Cellar") is None
    assert await service.resolve_room_display(OWNER, "") is None


@pytest.mark.asyncio
async def test_an_explicit_primary_display_wins_over_name_order(service, store):
    await service.sync(OWNER)
    await store.update_entity(
        "smart_device", OFFICE_ROKU_ID, OWNER, {"room": "Lounge", "primary_for_room": True}
    )
    # Alphabetically first, so it would win if the primary flag were ignored.
    await store.create_entity(
        "smart_device",
        OWNER,
        {
            "platform": "home_assistant",
            "name": "Apple TV",
            "room": "Lounge",
            "components": [
                {
                    "key": "main",
                    "entity_id": "media_player.apple_tv",
                    "domain": "media_player",
                    "capabilities": ["power"],
                }
            ],
        },
    )

    display = await service.resolve_room_display(OWNER, "Lounge")
    assert display["id"] == OFFICE_ROKU_ID


# ------------------------------------------------------------- ownership


@pytest.mark.asyncio
async def test_one_owners_devices_are_invisible_to_another(service, store):
    await service.sync(OWNER)
    assert await service.list_devices(OTHER_OWNER) == []
    with pytest.raises(KeyError):
        await service.get_device(OTHER_OWNER, OFFICE_1_ID)
    with pytest.raises(KeyError):
        await service.control_device(OTHER_OWNER, OFFICE_1_ID, "turn_on")


@pytest.mark.asyncio
async def test_a_device_another_account_imported_is_refused_not_a_constraint_error(service):
    """Imported ids are derived from the vendor id, so they are shared across accounts."""
    await service.sync(OWNER)
    with pytest.raises(SmartHomeError, match="already imported by another account"):
        await service.sync(OTHER_OWNER)


@pytest.mark.asyncio
async def test_a_patch_by_one_owner_cannot_reach_another_owners_device(service, store):
    await service.sync(OWNER)
    reached = await store.update_entity("smart_device", OFFICE_1_ID, OTHER_OWNER, {"name": "Mine"})
    assert reached is None
    assert (await store.get_entity("smart_device", OFFICE_1_ID, OWNER))["name"] == "Office 1"


# ------------------------------------------------------------- migration


def test_a_legacy_govee_row_keeps_its_identity_and_stays_a_light():
    legacy = {
        "id": OFFICE_1_ID,
        "provider": "govee",
        "name": "Office 1",
        "source_name": "Office 1",
        "room": "Office",
        "sku": "H600D",
        "external_id": "02:00:00:00:00:00:00:01",
        "capabilities": [
            {"type": "devices.capabilities.on_off", "instance": "powerSwitch"},
            {"type": "devices.capabilities.range", "instance": "brightness"},
        ],
    }
    assert needs_migration(legacy)
    migrated = migrate_row(legacy)

    assert migrated["id"] == OFFICE_1_ID
    assert (migrated["name"], migrated["room"]) == ("Office 1", "Office")
    assert migrated["external_id"] == "02:00:00:00:00:00:00:01"
    assert migrated["platform"] == "home_assistant"
    assert migrated["is_light"] is True
    # Vendor detail survives as migration metadata, not as the capability model.
    assert "provider" not in migrated
    assert "capabilities" in migrated and migrated["capabilities"] == []
    assert migrated["legacy_provider"] == "govee"
    assert migrated["legacy_sku"] == "H600D"
    assert len(migrated["legacy_capabilities"]) == 2


def test_a_legacy_dual_plug_is_not_treated_as_a_light():
    legacy = {
        "id": DUAL_PLUG_ID,
        "provider": "govee",
        "name": "Office Dual Smart Plug",
        "external_id": "02:00:00:00:00:00:00:04",
        "sku": "H5082",
        "capabilities": [
            {"instance": "powerSwitch", "type": "devices.capabilities.on_off", "parameters": {}},
            {"instance": "socketToggle1", "type": "devices.capabilities.toggle", "parameters": {}},
            {"instance": "socketToggle2", "type": "devices.capabilities.toggle", "parameters": {}},
        ],
    }
    assert migrate_row(legacy)["is_light"] is False


def test_a_legacy_roku_row_is_not_treated_as_a_light():
    legacy = {
        "id": OFFICE_ROKU_ID,
        "provider": "roku",
        "name": "Demo TV",
        "source_name": "Demo TV",
        "room": "Office",
        "external_id": "EXAMPLETV001",
        "host": "192.0.2.12",
        "port": 8060,
        "model": "TCL\u2022Roku TV",
        "wifi_mac": "02:00:00:00:00:05",
    }
    migrated = migrate_row(legacy)
    assert migrated["is_light"] is False
    assert migrated["legacy_host"] == "192.0.2.12"
    assert migrated["legacy_wifi_mac"] == "02:00:00:00:00:05"
    assert migrated["room"] == "Office"


def test_migration_is_idempotent():
    legacy = {
        "id": "x",
        "provider": "govee",
        "name": "Lamp",
        "room": "Den",
        "external_id": "AA",
        "capabilities": [
            {
                "instance": "brightness",
                "type": "devices.capabilities.range",
                "parameters": {"dataType": "INTEGER"},
            }
        ],
    }
    once = migrate_row(legacy)
    assert not needs_migration(once)

    # A second pass must not reset light membership or lose the recorded origin.
    twice = migrate_row(once)
    assert twice == once
    assert twice["is_light"] is True
    assert twice["legacy_provider"] == "govee"
    assert (twice["name"], twice["room"]) == ("Lamp", "Den")


def test_a_row_that_was_never_a_vendor_row_is_left_alone():
    row = {"id": "x", "platform": "home_assistant", "name": "Lamp", "is_light": False}
    assert not needs_migration(row)
    assert migrate_row(row) == row


@pytest.mark.asyncio
async def test_sync_clears_bulk_light_membership_for_switch_only_plugs(service, store):
    await store.create_entity(
        "smart_device",
        OWNER,
        {
            "id": DUAL_PLUG_ID,
            "platform": "home_assistant",
            "name": "Office Dual Smart Plug",
            "is_light": True,
            "legacy_provider": "govee",
            "legacy_sku": "H5082",
            "legacy_capabilities": [],
            "ha_device_id": "ha-dual",
            "components": [],
        },
        entity_id=DUAL_PLUG_ID,
    )
    await service.sync(OWNER)
    row = await store.get_entity("smart_device", DUAL_PLUG_ID, OWNER)
    assert row["is_light"] is False


@pytest.mark.asyncio
async def test_migrating_then_syncing_reunites_a_legacy_row_with_its_entities(service, store):
    """The end-to-end property the whole cutover depends on."""
    from jarvis_api.smarthome.migration import migrate_user

    await store.create_entity(
        "smart_device",
        OWNER,
        {
            "provider": "govee",
            "name": "Reading lamp",
            "source_name": "Office 1",
            "room": "Study",
            "sku": "H600D",
            "external_id": "02:00:00:00:00:00:00:01",
            "capabilities": [{"type": "devices.capabilities.on_off", "instance": "powerSwitch"}],
        },
        entity_id=OFFICE_1_ID,
    )

    report = await migrate_user(store, OWNER)
    assert report == {"examined": 1, "migrated": 1, "already_migrated": 0}

    devices = {device["id"]: device for device in await service.sync(OWNER)}
    reunited = devices[OFFICE_1_ID]

    # The owner's label and room survived, and the device is controllable again.
    assert reunited["name"] == "Reading lamp"
    assert reunited["room"] == "Study"
    assert reunited["is_light"] is True
    assert reunited["components"][0]["entity_id"] == "light.office_1"
    assert reunited["capabilities"] == ["brightness", "color", "color_temperature", "power"]


@pytest.mark.asyncio
async def test_migration_leaves_an_already_migrated_row_untouched(service, store):
    from jarvis_api.smarthome.migration import migrate_user

    await service.sync(OWNER)
    assert (await migrate_user(store, OWNER))["migrated"] == 0
