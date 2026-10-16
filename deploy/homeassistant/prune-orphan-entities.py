#!/usr/bin/env python3
"""Remove Home Assistant entity-registry rows our integration no longer provides.

Home Assistant keeps a registry row forever once an entity has existed. When the
set of entities an integration creates shrinks, the leftovers stay behind as
``restored`` rows that read ``unavailable`` for good, which is indistinguishable
from a broken device to anything reading state.

Only rows belonging to ``--platform`` that are currently restored are removed, so
a device that is merely switched off or temporarily offline is never touched.
Prints what it would do unless ``--apply`` is given.

    HA_TOKEN=$(cat ~/.config/jarvis/homeassistant-token) \
        python3 prune-orphan-entities.py --platform govee_openapi --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

try:
    import websockets
except ImportError:  # pragma: no cover - operator feedback
    sys.exit("websockets is required: pip install websockets")


class HomeAssistantWs:
    """Just enough of the Home Assistant WebSocket API to read and prune entities."""

    def __init__(self, base_url: str, token: str) -> None:
        self._url = base_url.rstrip("/").replace("http://", "ws://").replace(
            "https://", "wss://"
        ) + "/api/websocket"
        self._token = token
        self._id = 0
        self._socket: Any = None

    async def __aenter__(self) -> HomeAssistantWs:
        self._socket = await websockets.connect(self._url, max_size=8 * 1024 * 1024)
        greeting = json.loads(await self._socket.recv())
        if greeting.get("type") != "auth_required":
            raise RuntimeError(f"unexpected greeting: {greeting}")
        await self._socket.send(json.dumps({"type": "auth", "access_token": self._token}))
        result = json.loads(await self._socket.recv())
        if result.get("type") != "auth_ok":
            raise RuntimeError("Home Assistant rejected the token")
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._socket is not None:
            await self._socket.close()

    async def command(self, **payload: Any) -> Any:
        self._id += 1
        message_id = self._id
        await self._socket.send(json.dumps({"id": message_id, **payload}))
        while True:
            message = json.loads(await self._socket.recv())
            if message.get("id") != message_id or message.get("type") != "result":
                continue
            if not message.get("success"):
                raise RuntimeError(message.get("error", {}).get("message", "command failed"))
            return message.get("result")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("HA_URL", "http://192.0.2.35:8123"))
    parser.add_argument("--platform", required=True)
    parser.add_argument("--apply", action="store_true", help="actually remove the rows")
    args = parser.parse_args()

    token = os.environ.get("HA_TOKEN", "")
    if not token:
        return int(bool(sys.stderr.write("HA_TOKEN is required\n"))) or 2

    async with HomeAssistantWs(args.url, token) as client:
        entities = await client.command(type="config/entity_registry/list")
        states = {row["entity_id"]: row for row in await client.command(type="get_states")}

        orphans = []
        for entity in entities:
            if entity.get("platform") != args.platform:
                continue
            state = states.get(entity["entity_id"])
            # A restored row is one Home Assistant is replaying from the registry
            # because nothing is providing it any more.
            if state is not None and state.get("attributes", {}).get("restored"):
                orphans.append(entity["entity_id"])

        if not orphans:
            print(f"no orphaned {args.platform} entities")
            return 0

        for entity_id in sorted(orphans):
            if args.apply:
                await client.command(
                    type="config/entity_registry/remove", entity_id=entity_id
                )
                print(f"removed {entity_id}")
            else:
                print(f"would remove {entity_id}")

        if not args.apply:
            print(f"\n{len(orphans)} orphaned entities; re-run with --apply to remove them")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
