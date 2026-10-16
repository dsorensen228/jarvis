from __future__ import annotations

import pytest

from jarvis_api.config import Settings
from jarvis_api.integrations.gmail import GmailClient
from jarvis_api.integrations.knowledge import WEB_ANSWER_INSTRUCTION, KnowledgeClient


def test_gmail_plain_text_body_walks_nested_parts():
    payload = {
        "mimeType": "multipart/alternative",
        "parts": [
            {
                "mimeType": "text/plain",
                "body": {"data": "aGVsbG8gd29ybGQ"},
            }
        ],
    }
    assert GmailClient._plain_text(payload) == "hello world"


def test_weather_location_keys_are_bounded_coordinates():
    assert KnowledgeClient._coordinates("39.799,-89.644") == (39.799, -89.644)
    with pytest.raises(ValueError):
        KnowledgeClient._coordinates("not-a-location")
    with pytest.raises(ValueError):
        KnowledgeClient._coordinates("91,0")


def test_weather_geocoder_falls_back_to_city_name():
    assert KnowledgeClient._geocoding_queries("Springfield IL 62701") == [
        "Springfield IL 62701",
        "Springfield",
    ]
    assert KnowledgeClient._geocoding_queries("London") == ["London"]


@pytest.mark.asyncio
async def test_tavily_web_search_enforces_the_spoken_answer_limit(settings):
    class ResponseStub:
        def raise_for_status(self):
            return None

        def json(self):
            return {"answer": "A short answer.", "results": []}

    class ClientStub:
        def __init__(self):
            self.request = None

        async def post(self, url, **kwargs):
            self.request = (url, kwargs)
            return ResponseStub()

    client = ClientStub()
    configured = Settings(
        **{
            **settings.__dict__,
            "openai_api_key": "",
            "tavily_api_key": "tavily-test-key",
        }
    )
    result = await KnowledgeClient(configured, client).search_web("Who won?", limit=99)

    assert result["answer"] == "A short answer."
    assert result["provider"] == "tavily"
    assert client.request[0] == "https://api.tavily.com/search"
    assert client.request[1]["json"]["query"] == f"Who won?\n\n{WEB_ANSWER_INSTRUCTION}"
    assert client.request[1]["json"]["max_results"] == 10


@pytest.mark.asyncio
async def test_openai_web_search_returns_provider_text_without_rewriting(settings):
    class ResponseStub:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "First sentence. Second sentence.",
                                "annotations": [
                                    {"type": "url_citation", "url": "https://example.com/news"}
                                ],
                            }
                        ],
                    }
                ]
            }

    class ClientStub:
        def __init__(self):
            self.request = None

        async def post(self, url, **kwargs):
            self.request = (url, kwargs)
            return ResponseStub()

    client = ClientStub()
    configured = Settings(
        **{
            **settings.__dict__,
            "openai_api_key": "openai-test-key",
            "openai_web_model": "gpt-4o",
        }
    )
    result = await KnowledgeClient(configured, client).search_web("What's new?")

    assert result == {
        "answer": "First sentence. Second sentence.",
        "results": [{"title": "", "url": "https://example.com/news", "content": ""}],
        "provider": "openai",
    }
    assert client.request[0] == "https://api.openai.com/v1/responses"
    assert client.request[1]["json"]["tools"] == [{"type": "web_search"}]
    assert WEB_ANSWER_INSTRUCTION in client.request[1]["json"]["input"]
