from __future__ import annotations

from functools import partial

from test_api import authenticated_client


def test_conversation_source_tracks_creation_and_survives_later_turns(settings):
    with authenticated_client(settings) as client:
        owner = client.get("/v1/users/me").json()["id"]
        agent = client.app.state.agent
        voice = client.portal.call(partial(agent.run, owner, "hello", voice_session=True))
        chat = client.portal.call(partial(agent.run, owner, "hello"))
        client.portal.call(
            partial(agent.run, owner, "again", conversation_id=voice.conversation_id)
        )
        client.portal.call(
            partial(
                agent.run, owner, "again", conversation_id=chat.conversation_id, voice_session=True
            )
        )

        saved_voice = client.get("/v1/conversations/" + voice.conversation_id).json()
        saved_chat = client.get("/v1/conversations/" + chat.conversation_id).json()
        assert saved_voice["source"] == "voice"
        assert saved_chat["source"] == "chat"
        assert len(saved_voice["messages"]) == len(saved_chat["messages"]) == 4
        assert client.post("/v1/conversations", json={}).json()["source"] == "chat"


def seed_history(client):
    owner = client.get("/v1/users/me").json()["id"]
    store = client.app.state.store
    for identifier, account, source in [
        ("legacy", owner, None),
        ("typed", owner, "chat"),
        ("voice", owner, "voice"),
        ("other-account", "someone-else", "chat"),
    ]:
        data = {"title": "Voice chat", "message_count": 0}
        if source is not None:
            data["source"] = source
        client.portal.call(
            partial(store.create_entity, "conversation", account, data, entity_id=identifier)
        )
        client.portal.call(store.add_message, account, identifier, "user", "hello")
    return owner


def test_history_excludes_voice_before_limit_without_guessing_unmarked_origins(settings):
    with authenticated_client(settings) as client:
        seed_history(client)
        assert {row["id"] for row in client.get("/v1/conversations").json()} == {
            "typed",
            "legacy",
            "voice",
        }
        visible = client.get("/v1/conversations?exclude_source=voice&limit=1")
        assert visible.status_code == 200
        assert [row["id"] for row in visible.json()] == ["typed"]
        assert {
            row["id"] for row in client.get("/v1/conversations?exclude_source=voice").json()
        } == {"typed", "legacy"}
        assert len(client.get("/v1/conversations/voice").json()["messages"]) == 1


def test_clear_visible_history_preserves_voice_transcripts_and_other_accounts(settings):
    with authenticated_client(settings) as client:
        seed_history(client)
        response = client.delete("/v1/conversations?exclude_source=voice")
        assert response.status_code == 200
        assert response.json() == {"deleted": 2}
        assert [row["id"] for row in client.get("/v1/conversations").json()] == ["voice"]
        assert len(client.get("/v1/conversations/voice").json()["messages"]) == 1
        assert client.get("/v1/conversations/typed").status_code == 404
        assert (
            len(
                client.portal.call(
                    client.app.state.store.list_messages, "someone-else", "other-account"
                )
            )
            == 1
        )
        assert client.delete("/v1/conversations").json() == {"deleted": 1}
        assert client.get("/v1/conversations").json() == []
