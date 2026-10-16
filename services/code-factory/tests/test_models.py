from __future__ import annotations

import pytest
from pydantic import ValidationError

from code_factory.models import AGENT_MODELS, CreateTaskRequest


def test_supported_agent_models_are_the_three_ui_choices() -> None:
    assert AGENT_MODELS == (
        "gpt-5.6-sol-medium",
        "claude-opus-5-thinking-high",
        "claude-fable-5-thinking-high",
    )


@pytest.mark.parametrize("model", AGENT_MODELS)
def test_create_request_accepts_each_supported_model(model: str) -> None:
    request = CreateTaskRequest(prompt="Ship it", model=model)
    assert request.model == model


def test_create_request_defaults_to_no_model_pin() -> None:
    assert CreateTaskRequest(prompt="Ship it").model is None


def test_create_request_rejects_unknown_models() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(prompt="Ship it", model="gpt-2")
