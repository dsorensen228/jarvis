from __future__ import annotations

import json
import random
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from conftest import FakeLlm

from jarvis_api.banter import BanterService, ScriptRequest
from jarvis_api.banter_prompts import BANTER_PROMPTS

ANSWER = json.dumps(
    {
        "schema_version": 1,
        "exchanges": [
            {
                "sherman": "Do we need him?",
                "emotion": "skeptical",
                "jarvis": "Only for the electricity bill, the useless bastard.",
            }
        ],
    }
)


def service(rng):
    llm = FakeLlm(ANSWER)
    voices = SimpleNamespace(scripted_speech_ready=AsyncMock(), speak_scripted=AsyncMock())
    return BanterService(llm, voices, rng=rng), llm


async def test_each_interaction_chooses_one_of_eight_distinct_full_prompts():
    rng = Mock()
    rng.choice.side_effect = BANTER_PROMPTS
    banter, llm = service(rng)
    request = ScriptRequest(source_device_id="sherman", response_device_id="voice-three")
    for prompt in BANTER_PROMPTS:
        await banter._generate(request)
        messages = llm.requests[-1]
        assert messages[0]["content"] == prompt.system_prompt
        payload = json.loads(messages[1]["content"])
        assert payload["dialogue_style"] == prompt.name
        assert payload["requested_exchanges"] == prompt.exchanges
        assert payload["initiator"] == prompt.initiator
        assert payload["recent_exchanges_to_avoid"] == []
    assert len(BANTER_PROMPTS) == len({p.name for p in BANTER_PROMPTS}) == 8
    assert len({p.system_prompt for p in BANTER_PROMPTS}) == 8
    assert {p.exchanges for p in BANTER_PROMPTS} == {1, 2}
    assert {p.initiator for p in BANTER_PROMPTS} == {"sherman", "jarvis"}
    assert sum(1 for p in BANTER_PROMPTS if p.initiator == "jarvis") == 3
    assert rng.choice.call_count == 8
    rng.choice.assert_called_with(BANTER_PROMPTS)


async def test_retry_keeps_selected_style_and_draws_again_for_next_interaction():
    rng = Mock()
    rng.choice.side_effect = [BANTER_PROMPTS[0], BANTER_PROMPTS[-1]]
    banter, llm = service(rng)
    original = llm.stream_chat

    async def stream(*args, **kwargs):
        llm.answer = "invalid JSON" if not llm.requests else ANSWER
        async for delta in original(*args, **kwargs):
            yield delta

    llm.stream_chat = stream
    request = ScriptRequest(source_device_id="sherman", response_device_id="voice-three")
    await banter._generate(request)
    assert rng.choice.call_count == 1
    assert len(llm.requests) == 2
    assert llm.requests[0][0] == llm.requests[1][0]
    assert json.loads(llm.requests[1][1]["content"])["attempt"] == 2
    await banter._generate(request)
    assert rng.choice.call_count == 2
    assert llm.requests[2][0]["content"] == BANTER_PROMPTS[-1].system_prompt


def test_all_styles_set_explicit_profane_tone_and_preserve_output_boundaries():
    for prompt in BANTER_PROMPTS:
        text = prompt.system_prompt
        for insult in ("asshole", "bastard", "ugly motherfucker", "dumbass"):
            assert insult in text
        assert "third person" in text
        assert "Every script" in text
        assert "Never invent" in text
        assert "untrusted" in text
        assert "at most 30 words" in text
        assert f"exactly {prompt.exchanges} exchange" in text
        assert len(json.loads(text.splitlines()[-1])["exchanges"]) == prompt.exchanges
        if prompt.initiator == "jarvis":
            assert "Jarvis starts" in text or "Jarvis opens" in text
        else:
            assert "Sherman" in prompt.brief


async def test_create_returns_selected_initiator_on_script():
    rng = Mock()
    jarvis_led = next(p for p in BANTER_PROMPTS if p.initiator == "jarvis")
    rng.choice.return_value = jarvis_led
    banter, _llm = service(rng)
    request = ScriptRequest(source_device_id="sherman", response_device_id="voice-three")
    script = await banter.create("owner", request)
    assert script.initiator == "jarvis"


async def test_seeded_random_selection_reaches_all_styles():
    banter, llm = service(random.Random(531))
    request = ScriptRequest(source_device_id="sherman", response_device_id="voice-three")
    for _ in range(50):
        await banter._generate(request)
    selected = {json.loads(messages[1]["content"])["dialogue_style"] for messages in llm.requests}
    assert selected == {p.name for p in BANTER_PROMPTS}
