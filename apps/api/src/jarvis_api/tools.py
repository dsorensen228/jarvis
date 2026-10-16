"""Explicit tool registry for the single Jarvis agent."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional

import httpx

from jarvis_api import datetime_tools
from jarvis_api.capabilities import Capabilities
from jarvis_api.deferred import DeferredActionRegistry
from jarvis_api.integrations.service import IntegrationService
from jarvis_api.secrets import CredentialVault
from jarvis_api.smarthome.commands import ACTION_CAPABILITIES
from jarvis_api.vision import VisionClient

DeviceAction = Callable[[str, Dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class ToolContext:
    user_id: str
    conversation_id: str
    device_id: Optional[str] = None
    device_room: str = ""
    device_action: Optional[DeviceAction] = None
    voice_session: bool = False


ToolHandler = Callable[[ToolContext, Dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: Dict[str, Any]
    handler: ToolHandler

    def schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    def __init__(
        self,
        capabilities: Capabilities,
        integrations: Optional[IntegrationService] = None,
        timezone: str = "America/New_York",
        vision: Optional[VisionClient] = None,
        vault: Optional[CredentialVault] = None,
    ) -> None:
        self.capabilities = capabilities
        self.integrations = integrations
        self.vision = vision
        self.vault = vault
        self.deferred = DeferredActionRegistry(timezone)
        self._tools = {tool.name: tool for tool in self._build_tools()}

    async def close(self) -> None:
        await self.deferred.close()

    def schemas(self, names: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        if names is None:
            return [tool.schema() for tool in self._tools.values()]
        selected = set(names)
        return [tool.schema() for name, tool in self._tools.items() if name in selected]

    async def execute(self, name: str, context: ToolContext, raw_arguments: str) -> str:
        tool = self._tools.get(name)
        if tool is None:
            return json.dumps({"error": "unknown tool", "name": name})
        try:
            arguments = json.loads(raw_arguments or "{}")
            if not isinstance(arguments, dict):
                raise ValueError("arguments must be an object")
        except (json.JSONDecodeError, ValueError) as exc:
            return json.dumps({"error": "invalid arguments", "detail": str(exc)})
        try:
            result = await tool.handler(context, arguments)
            return json.dumps(result, ensure_ascii=False, default=str)
        except Exception as exc:  # tool failures become model-visible, not request-fatal
            return json.dumps({"error": type(exc).__name__, "detail": str(exc)})

    def _build_tools(self) -> List[Tool]:
        async def list_todos(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.list_todos(
                ctx.user_id, bool(args.get("include_completed", True))
            )

        async def create_todo(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.create_todo(
                ctx.user_id, str(args["title"]), str(args.get("category", ""))
            )

        async def get_todo(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            row = await self.capabilities.store.get_entity(
                "todo", str(args["todo_id"]), ctx.user_id
            )
            if row is None:
                raise KeyError("todo not found")
            return row

        async def update_todo(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            changes = {
                key: args[key]
                for key in ("title", "category", "completed")
                if key in args and args[key] is not None
            }
            row = await self.capabilities.store.update_entity(
                "todo", str(args["todo_id"]), ctx.user_id, changes
            )
            if row is None:
                raise KeyError("todo not found")
            return row

        async def delete_todo(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            deleted = await self.capabilities.store.delete_entity(
                "todo", str(args["todo_id"]), ctx.user_id
            )
            return {"deleted": deleted, "todo_id": str(args["todo_id"])}

        async def list_shopping_lists(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.list_shopping_lists(ctx.user_id)

        async def create_shopping_list(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.create_shopping_list(ctx.user_id, str(args["name"]))

        async def add_shopping_items(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.add_shopping_items(
                ctx.user_id, str(args["list_id"]), [str(item) for item in args["items"]]
            )

        async def update_shopping_list(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            def mutate(current: Dict[str, Any]) -> Dict[str, Any]:
                if args.get("name") is not None:
                    current["name"] = str(args["name"]).strip()
                remove = {str(value) for value in args.get("remove_item_ids", [])}
                toggle = {str(value) for value in args.get("toggle_item_ids", [])}
                items = [
                    item for item in current.get("items", []) if str(item.get("id")) not in remove
                ]
                for item in items:
                    if str(item.get("id")) in toggle:
                        item["checked"] = not bool(item.get("checked"))
                current["items"] = items
                return current

            row = await self.capabilities.store.mutate_entity(
                "shopping_list", str(args["list_id"]), ctx.user_id, mutate
            )
            if row is None:
                raise KeyError("shopping list not found")
            additions = [str(item) for item in args.get("add_items", [])]
            if additions:
                row = await self.capabilities.add_shopping_items(
                    ctx.user_id, str(args["list_id"]), additions
                )
            return row

        async def delete_shopping_list(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            deleted = await self.capabilities.store.delete_entity(
                "shopping_list", str(args["list_id"]), ctx.user_id
            )
            return {"deleted": deleted, "list_id": str(args["list_id"])}

        async def create_timer(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.create_timer(
                ctx.user_id,
                str(args.get("label", "")),
                int(args["duration_seconds"]),
            )

        async def list_timers(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.list_timers(ctx.user_id)

        async def list_projects(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.list_projects(ctx.user_id)

        async def create_project(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.create_project(
                ctx.user_id, str(args["title"]), str(args.get("description", ""))
            )

        async def update_project(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            changes = {
                key: args[key]
                for key in ("title", "description", "status")
                if key in args and args[key] is not None
            }
            row = await self.capabilities.store.update_entity(
                "project", str(args["project_id"]), ctx.user_id, changes
            )
            if row is None:
                raise KeyError("project not found")
            return row

        async def search_assets(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.search_assets(
                ctx.user_id, str(args["query"]), args.get("project_id")
            )

        async def create_text_asset(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.store.create_entity(
                "asset",
                ctx.user_id,
                {
                    "kind": "text",
                    "title": str(args["title"]).strip(),
                    "body": str(args["body"]),
                    "mime_type": "text/markdown",
                    "project_id": args.get("project_id"),
                    "conversation_id": ctx.conversation_id,
                    "keywords": [str(value) for value in args.get("keywords", [])],
                },
            )

        async def get_text_asset(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            row = await self.capabilities.store.get_entity(
                "asset", str(args["asset_id"]), ctx.user_id
            )
            if row is None:
                raise KeyError("asset not found")
            return row

        async def update_text_asset(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            current = await self.capabilities.store.get_entity(
                "asset", str(args["asset_id"]), ctx.user_id
            )
            if current is None:
                raise KeyError("asset not found")
            if current.get("kind") != "text":
                raise ValueError("only text assets can be edited by this tool")
            changes = {
                key: args[key]
                for key in ("title", "body", "project_id", "keywords")
                if key in args and args[key] is not None
            }
            return await self.capabilities.store.update_entity(
                "asset", str(args["asset_id"]), ctx.user_id, changes
            )

        async def get_conversation_transcript(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.store.list_messages(
                ctx.user_id,
                ctx.conversation_id,
                limit=max(1, min(100, int(args.get("limit", 30)))),
            )

        async def search_past_conversations(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            query = str(args["query"]).strip().casefold()
            rows = await self.capabilities.store.list_entities(
                "conversation", ctx.user_id, limit=1000
            )
            return [
                row
                for row in rows
                if query
                in " ".join(
                    [
                        str(row.get("title") or ""),
                        str(row.get("last_message") or ""),
                    ]
                ).casefold()
            ][:15]

        async def list_jarvis_devices(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del args
            return await self.capabilities.store.list_entities("device", ctx.user_id, limit=1000)

        async def remember(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.create_memory(
                ctx.user_id, str(args["content"]), str(args.get("category", "general"))
            )

        async def search_memories(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.capabilities.search_memories(ctx.user_id, str(args["query"]))

        async def invoke_device(ctx: ToolContext, action: str, arguments: Dict[str, Any]) -> Any:
            if ctx.device_action is None or not ctx.device_id:
                raise RuntimeError("this tool requires an active Jarvis voice device")
            return await ctx.device_action(action, arguments)

        async def end_voice_session(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del args
            if not ctx.voice_session:
                return {"ended": False, "reason": "no active voice session"}
            return {"ended": True}

        async def navigate_device_ui(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "navigate_device_ui", args)

        async def spotify_play_best_match(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_play_best_match", args)

        async def spotify_search(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_search", args)

        async def spotify_start_playback(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_start_playback", args)

        async def spotify_resume_playback(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_resume_playback", args)

        async def spotify_pause(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_pause", args)

        async def spotify_skip_next(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_skip_next", args)

        async def spotify_skip_previous(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "spotify_skip_previous", args)

        async def set_system_volume(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "set_system_volume", args)

        async def control_device_clock(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "control_device_clock", args)

        async def show_wikipedia(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "show_wikipedia", args)

        async def open_patreon(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "open_patreon", args)

        async def close_browser(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "close_browser", args)

        async def put_on_title(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await invoke_device(ctx, "put_on_title", args)

        async def describe_scene(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            if self.vision is None:
                raise RuntimeError("the local vision service is unavailable")
            asset_id = str(args.get("image_asset_id") or "").strip()
            camera_id = str(args.get("camera_device_id") or "").strip()
            camera_name = str(args.get("camera_name_contains") or "").strip().casefold()
            if asset_id and (camera_id or camera_name):
                raise ValueError("choose an image asset or a live camera, not both")

            source: Dict[str, Any]
            if asset_id:
                asset = await self.capabilities.store.get_entity("asset", asset_id, ctx.user_id)
                if asset is None or asset.get("kind") != "file":
                    raise ValueError("image asset not found")
                media_type = str(asset.get("mime_type") or "")
                if not media_type.startswith("image/"):
                    raise ValueError("asset is not an image")
                path = (self.vision.settings.asset_dir / str(asset.get("path") or "")).resolve()
                if self.vision.settings.asset_dir not in path.parents or not path.is_file():
                    raise ValueError("image asset content is missing")
                image = path.read_bytes()
                source = {"kind": "asset", "id": asset_id, "title": asset.get("title")}
                device_prompt = ""
            else:
                cameras = [
                    row
                    for row in await self.capabilities.store.list_entities(
                        "device", ctx.user_id, limit=1000
                    )
                    if row.get("kind") == "camera"
                ]
                if camera_id:
                    matches = [row for row in cameras if row.get("id") == camera_id]
                elif camera_name:
                    matches = [
                        row
                        for row in cameras
                        if camera_name in str(row.get("name") or "").casefold()
                    ]
                else:
                    defaults = [
                        row
                        for row in cameras
                        if isinstance(row.get("metadata"), dict)
                        and row["metadata"].get("is_main_describe_camera") is True
                    ]
                    matches = defaults or (cameras if len(cameras) == 1 else [])
                if not matches:
                    names = [str(row.get("name") or row.get("id")) for row in cameras]
                    raise ValueError(
                        "could not resolve a camera; available cameras: "
                        + (", ".join(names) if names else "none")
                    )
                if len(matches) > 1:
                    raise ValueError("camera name is ambiguous; use the exact device id")
                camera = matches[0]
                base_url = str(camera.get("base_url") or "").rstrip("/")
                if not base_url:
                    raise ValueError("camera has no callback URL")
                if self.vault is None:
                    raise RuntimeError("camera credentials are unavailable")
                credential = await self.vault.get("device_callback", str(camera["id"]), ctx.user_id)
                callback_token = str((credential or {}).get("token") or "")
                if not callback_token:
                    raise RuntimeError("camera callback credential is missing")
                async with httpx.AsyncClient(timeout=20.0) as client:
                    response = await client.get(
                        base_url + "/v1/camera/snapshot",
                        headers={"Authorization": f"Bearer {callback_token}"},
                    )
                    response.raise_for_status()
                image = response.content
                media_type = response.headers.get("content-type", "image/jpeg").split(";", 1)[0]
                source = {
                    "kind": "camera",
                    "id": camera["id"],
                    "name": camera.get("name"),
                }
                metadata = camera.get("metadata")
                device_prompt = (
                    str(metadata.get("describe_scene_prompt") or "").strip()
                    if isinstance(metadata, dict)
                    else ""
                )

            prompt = (
                "Briefly and factually describe this image for the homeowner. "
                "Do not invent people, objects, text, or events; state uncertainty plainly."
            )
            if device_prompt:
                prompt += " Pay particular attention to: " + device_prompt
            question = str(args.get("user_question") or "").strip()
            if question:
                prompt += " The homeowner asks: " + question
            description = await self.vision.describe(image, media_type, prompt)
            return {"description": description, "source": source}

        schedulable_tools = {
            "control_smart_device",
            "spotify_play_best_match",
            "spotify_start_playback",
            "spotify_resume_playback",
            "spotify_pause",
            "spotify_skip_next",
            "spotify_skip_previous",
            "set_system_volume",
            "control_device_clock",
            "navigate_device_ui",
            "show_wikipedia",
            "open_patreon",
            "close_browser",
            "put_on_title",
        }

        async def schedule_tool_call(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            if not ctx.device_id or ctx.device_action is None:
                raise RuntimeError("scheduling requires an active Jarvis voice device")
            target_name = str(args["target_tool"]).strip()
            if target_name not in schedulable_tools:
                raise ValueError(f"tool is not schedulable: {target_name}")
            target = self._tools.get(target_name)
            if target is None:
                raise ValueError(f"tool is unavailable: {target_name}")
            target_arguments = args.get("arguments") or {}
            if not isinstance(target_arguments, dict):
                raise ValueError("arguments must be an object")

            async def invoke() -> Any:
                return await target.handler(ctx, dict(target_arguments))

            return await self.deferred.schedule(
                user_id=ctx.user_id,
                device_id=ctx.device_id,
                target_tool=target_name,
                arguments=target_arguments,
                delay_seconds=args.get("delay_seconds"),
                run_at=args.get("run_at"),
                invoke=invoke,
            )

        async def list_scheduled_tool_calls(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del args
            if not ctx.device_id:
                raise RuntimeError("listing scheduled actions requires a voice device")
            return await self.deferred.list(ctx.user_id, ctx.device_id)

        async def cancel_scheduled_tool_calls(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            if not ctx.device_id:
                raise RuntimeError("cancelling scheduled actions requires a voice device")
            return await self.deferred.cancel(
                ctx.user_id,
                ctx.device_id,
                args.get("action_id"),
                args.get("query"),
                bool(args.get("cancel_all_matches", False)),
            )

        def default_timezone(args: Dict[str, Any], key: str = "iana_timezone") -> str:
            configured = (
                self.integrations.knowledge.settings.timezone
                if self.integrations is not None
                else "America/New_York"
            )
            return str(args.get(key) or configured)

        async def get_current_datetime(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return datetime_tools.current_datetime(default_timezone(args))

        async def parse_datetime(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return datetime_tools.parse_datetime(
                str(args["text"]), default_timezone(args, "assume_timezone")
            )

        async def diff_datetimes(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return datetime_tools.diff_datetimes(
                str(args["iso_a"]),
                str(args["iso_b"]),
                default_timezone(args, "assume_timezone"),
            )

        async def add_duration(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return datetime_tools.add_duration(
                base_iso=args.get("base_iso"),
                iana_timezone=default_timezone(args),
                weeks=int(args.get("weeks", 0)),
                days=int(args.get("days", 0)),
                hours=int(args.get("hours", 0)),
                minutes=int(args.get("minutes", 0)),
            )

        async def next_weekday(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return datetime_tools.next_weekday(
                str(args["weekday"]),
                iana_timezone=default_timezone(args),
                reference_iso=args.get("reference_iso"),
                inclusive=bool(args.get("inclusive", True)),
            )

        async def convert_timezone(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return datetime_tools.convert_timezone(
                str(args["iso_datetime"]),
                str(args["target_iana_timezone"]),
                default_timezone(args, "assume_timezone"),
            )

        object_schema = {"type": "object", "additionalProperties": False}
        tools = [
            Tool(
                "list_todos",
                "List the user's todos.",
                {
                    **object_schema,
                    "properties": {"include_completed": {"type": "boolean", "default": True}},
                },
                list_todos,
            ),
            Tool(
                "create_todo",
                "Create a todo for the user.",
                {
                    **object_schema,
                    "properties": {
                        "title": {"type": "string"},
                        "category": {"type": "string", "default": ""},
                    },
                    "required": ["title"],
                },
                create_todo,
            ),
            Tool(
                "get_todo",
                "Get one todo by id.",
                {
                    **object_schema,
                    "properties": {"todo_id": {"type": "string"}},
                    "required": ["todo_id"],
                },
                get_todo,
            ),
            Tool(
                "update_todo",
                "Change a todo's title, category, or completion state.",
                {
                    **object_schema,
                    "properties": {
                        "todo_id": {"type": "string"},
                        "title": {"type": ["string", "null"]},
                        "category": {"type": ["string", "null"]},
                        "completed": {"type": ["boolean", "null"]},
                    },
                    "required": ["todo_id"],
                },
                update_todo,
            ),
            Tool(
                "delete_todo",
                "Delete a todo by id.",
                {
                    **object_schema,
                    "properties": {"todo_id": {"type": "string"}},
                    "required": ["todo_id"],
                },
                delete_todo,
            ),
            Tool(
                "list_shopping_lists",
                "List the user's shopping lists and their items.",
                {**object_schema, "properties": {}},
                list_shopping_lists,
            ),
            Tool(
                "create_shopping_list",
                "Create a shopping list.",
                {
                    **object_schema,
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
                create_shopping_list,
            ),
            Tool(
                "add_shopping_items",
                "Add one or more items to a shopping list.",
                {
                    **object_schema,
                    "properties": {
                        "list_id": {"type": "string"},
                        "items": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["list_id", "items"],
                },
                add_shopping_items,
            ),
            Tool(
                "update_shopping_list",
                "Rename a shopping list, add items, remove items, or toggle checked items.",
                {
                    **object_schema,
                    "properties": {
                        "list_id": {"type": "string"},
                        "name": {"type": ["string", "null"]},
                        "add_items": {"type": "array", "items": {"type": "string"}},
                        "remove_item_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "toggle_item_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["list_id"],
                },
                update_shopping_list,
            ),
            Tool(
                "delete_shopping_list",
                "Delete a shopping list by id.",
                {
                    **object_schema,
                    "properties": {"list_id": {"type": "string"}},
                    "required": ["list_id"],
                },
                delete_shopping_list,
            ),
            Tool(
                "create_timer",
                "Create and immediately start a timer.",
                {
                    **object_schema,
                    "properties": {
                        "label": {"type": "string", "default": ""},
                        "duration_seconds": {"type": "integer", "minimum": 1, "maximum": 604800},
                    },
                    "required": ["duration_seconds"],
                },
                create_timer,
            ),
            Tool(
                "list_timers",
                "List the user's timers and their current state.",
                {**object_schema, "properties": {}},
                list_timers,
            ),
            Tool(
                "list_projects",
                "List the user's projects.",
                {**object_schema, "properties": {}},
                list_projects,
            ),
            Tool(
                "create_project",
                "Create a project.",
                {
                    **object_schema,
                    "properties": {
                        "title": {"type": "string"},
                        "description": {"type": "string", "default": ""},
                    },
                    "required": ["title"],
                },
                create_project,
            ),
            Tool(
                "update_project",
                "Update a project's title, description, or status.",
                {
                    **object_schema,
                    "properties": {
                        "project_id": {"type": "string"},
                        "title": {"type": ["string", "null"]},
                        "description": {"type": ["string", "null"]},
                        "status": {"type": ["string", "null"]},
                    },
                    "required": ["project_id"],
                },
                update_project,
            ),
            Tool(
                "search_assets",
                "Search saved text assets, optionally within a project.",
                {
                    **object_schema,
                    "properties": {
                        "query": {"type": "string"},
                        "project_id": {"type": ["string", "null"]},
                    },
                    "required": ["query"],
                },
                search_assets,
            ),
            Tool(
                "create_text_asset",
                "Create a Markdown text asset in the current conversation.",
                {
                    **object_schema,
                    "properties": {
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "project_id": {"type": ["string", "null"]},
                        "keywords": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["title", "body"],
                },
                create_text_asset,
            ),
            Tool(
                "get_text_asset",
                "Load a saved text asset, including its full body.",
                {
                    **object_schema,
                    "properties": {"asset_id": {"type": "string"}},
                    "required": ["asset_id"],
                },
                get_text_asset,
            ),
            Tool(
                "update_text_asset",
                "Edit a saved text asset's title, body, project, or keywords.",
                {
                    **object_schema,
                    "properties": {
                        "asset_id": {"type": "string"},
                        "title": {"type": ["string", "null"]},
                        "body": {"type": ["string", "null"]},
                        "project_id": {"type": ["string", "null"]},
                        "keywords": {
                            "type": ["array", "null"],
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["asset_id"],
                },
                update_text_asset,
            ),
            Tool(
                "get_conversation_transcript",
                "Load recent messages from the current conversation.",
                {
                    **object_schema,
                    "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}},
                },
                get_conversation_transcript,
            ),
            Tool(
                "search_past_conversations",
                "Search past conversations by title and last message.",
                {
                    **object_schema,
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                search_past_conversations,
            ),
            Tool(
                "list_jarvis_devices",
                "List registered Jarvis voice, display, wearable, and camera devices with their "
                "ids, names, rooms, and connection metadata.",
                {**object_schema, "properties": {}},
                list_jarvis_devices,
            ),
            Tool(
                "remember",
                "Save a durable fact, preference, or instruction about the owner.",
                {
                    **object_schema,
                    "properties": {
                        "content": {"type": "string"},
                        "category": {"type": "string", "default": "general"},
                    },
                    "required": ["content"],
                },
                remember,
            ),
            Tool(
                "search_memories",
                "Search durable owner memories.",
                {
                    **object_schema,
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                search_memories,
            ),
            Tool(
                "end_voice_session",
                "End the active voice session immediately and return the device to standby. "
                "Use when the user says stop, goodbye, cancel, hang up, that's enough, "
                "that's all, we're done, thank you, or otherwise signals the conversation is "
                "over. Do not speak after calling it, and never say its name aloud.",
                {**object_schema, "properties": {}},
                end_voice_session,
            ),
            Tool(
                "navigate_device_ui",
                "Switch the Jarvis touchscreen to one of its own built-in screens. This only "
                "moves between the screens listed in destination; it does not close a web page.",
                {
                    **object_schema,
                    "properties": {
                        "destination": {
                            "type": "string",
                            "enum": [
                                "standby",
                                "spotify",
                                "timer",
                                "timer_alarms",
                                "tv",
                                "cameras",
                            ],
                        },
                        "camera_device_id": {"type": "string", "default": ""},
                        "camera_name": {"type": "string", "default": ""},
                    },
                    "required": ["destination"],
                },
                navigate_device_ui,
            ),
            Tool(
                "spotify_play_best_match",
                "Search Spotify and immediately start playback of the best match in one step. "
                "Use this for any ordinary request to play a named song, album, artist, "
                "playlist, or genre. List the most likely result kind first in types, for "
                "example 'artist,track' for music by a performer or 'track,artist' for a "
                "named song.",
                {
                    **object_schema,
                    "properties": {
                        "query": {"type": "string"},
                        "types": {
                            "type": "string",
                            "default": "track,album,artist,playlist",
                        },
                        "device_name": {"type": "string", "default": ""},
                    },
                    "required": ["query"],
                },
                spotify_play_best_match,
            ),
            Tool(
                "spotify_search",
                "Search Spotify for playable tracks, albums, artists, or playlists without "
                "starting playback. Prefer spotify_play_best_match for a direct play request.",
                {
                    **object_schema,
                    "properties": {
                        "query": {"type": "string"},
                        "types": {
                            "type": "string",
                            "default": "track,album,artist,playlist",
                        },
                        "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                    },
                    "required": ["query"],
                },
                spotify_search,
            ),
            Tool(
                "spotify_start_playback",
                "Start Spotify playback using a URI returned by spotify_search, or a list of "
                "Spotify track URIs.",
                {
                    **object_schema,
                    "properties": {
                        "spotify_uri": {"type": "string", "default": ""},
                        "track_uris": {
                            "type": "array",
                            "items": {"type": "string"},
                            "default": [],
                        },
                        "device_name": {"type": "string", "default": ""},
                    },
                },
                spotify_start_playback,
            ),
            Tool(
                "spotify_resume_playback",
                "Resume the current Spotify context on the Jarvis device.",
                {
                    **object_schema,
                    "properties": {"device_name": {"type": "string", "default": ""}},
                },
                spotify_resume_playback,
            ),
            Tool(
                "spotify_pause",
                "Pause Spotify playback on the Jarvis device.",
                {
                    **object_schema,
                    "properties": {"device_name": {"type": "string", "default": ""}},
                },
                spotify_pause,
            ),
            Tool(
                "spotify_skip_next",
                "Skip to the next Spotify track.",
                {
                    **object_schema,
                    "properties": {"device_name": {"type": "string", "default": ""}},
                },
                spotify_skip_next,
            ),
            Tool(
                "spotify_skip_previous",
                "Return to the previous Spotify track.",
                {
                    **object_schema,
                    "properties": {"device_name": {"type": "string", "default": ""}},
                },
                spotify_skip_previous,
            ),
            Tool(
                "set_system_volume",
                "Change the current Jarvis device's system audio volume. Use this for louder, "
                "quieter, mute, or unmute requests; never use Spotify for loudness.",
                {
                    **object_schema,
                    "properties": {
                        "percent": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
                        "delta_percent": {
                            "type": ["integer", "null"],
                            "minimum": -100,
                            "maximum": 100,
                        },
                        "muted": {"type": ["boolean", "null"]},
                    },
                },
                set_system_volume,
            ),
            Tool(
                "control_device_clock",
                "Control the current device's local timer or alarms. Use create_timer for a new "
                "countdown; use this tool to stop it, show timer/alarms, or manage alarms.",
                {
                    **object_schema,
                    "properties": {
                        "operation": {
                            "type": "string",
                            "enum": [
                                "stop_timer",
                                "show_timer",
                                "show_alarms",
                                "add_alarm",
                                "remove_alarm",
                                "set_alarm_enabled",
                            ],
                        },
                        "hour": {"type": "integer", "minimum": 0, "maximum": 23},
                        "minute": {"type": "integer", "minimum": 0, "maximum": 59},
                        "repeat": {"type": ["string", "object", "null"]},
                        "enabled": {"type": ["boolean", "null"]},
                    },
                    "required": ["operation"],
                },
                control_device_clock,
            ),
            Tool(
                "show_wikipedia",
                "Open the best matching Wikipedia article on the current device's touchscreen.",
                {
                    **object_schema,
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                show_wikipedia,
            ),
            Tool(
                "open_patreon",
                "Open Patreon on the current device's touchscreen.",
                {**object_schema, "properties": {}},
                open_patreon,
            ),
            Tool(
                "close_browser",
                "Close the web page Jarvis opened on the device, such as Netflix, Patreon, or "
                "Wikipedia, and return to the touchscreen. Use this for any request to close or "
                "exit a browser tab, page, or streaming site.",
                {**object_schema, "properties": {}},
                close_browser,
            ),
            Tool(
                "put_on_title",
                "Find a movie or TV show on a preferred streaming service (Netflix, Hulu, "
                "Disney+, HBO Max, Prime Video, Apple TV+, Peacock, Paramount+) and open it "
                "on the current device's touchscreen. To play something on a television, "
                "use control_smart_device instead.",
                {
                    **object_schema,
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                put_on_title,
            ),
            Tool(
                "describe_scene",
                "Describe an uploaded image or a live Jarvis camera frame using the local vision "
                "model. For a live frame, select a camera by id or unique name substring, or use "
                "the configured default camera.",
                {
                    **object_schema,
                    "properties": {
                        "image_asset_id": {"type": ["string", "null"]},
                        "camera_device_id": {"type": ["string", "null"]},
                        "camera_name_contains": {"type": ["string", "null"]},
                        "user_question": {"type": ["string", "null"]},
                    },
                },
                describe_scene,
            ),
            Tool(
                "schedule_tool_call",
                "Schedule one safe device or smart-home tool to run later. Supply exactly one "
                "of delay_seconds or run_at; do not call the target tool immediately.",
                {
                    **object_schema,
                    "properties": {
                        "target_tool": {
                            "type": "string",
                            "enum": sorted(schedulable_tools),
                        },
                        "arguments": {"type": "object"},
                        "delay_seconds": {"type": ["number", "null"], "minimum": 0.1},
                        "run_at": {"type": ["string", "null"]},
                    },
                    "required": ["target_tool"],
                },
                schedule_tool_call,
            ),
            Tool(
                "list_scheduled_tool_calls",
                "List deferred actions for the current voice device, soonest first.",
                {**object_schema, "properties": {}},
                list_scheduled_tool_calls,
            ),
            Tool(
                "cancel_scheduled_tool_calls",
                "Cancel deferred device actions by exact action id or by a target/argument query.",
                {
                    **object_schema,
                    "properties": {
                        "action_id": {"type": ["string", "null"]},
                        "query": {"type": ["string", "null"]},
                        "cancel_all_matches": {"type": "boolean", "default": False},
                    },
                },
                cancel_scheduled_tool_calls,
            ),
            Tool(
                "get_current_datetime",
                "Get the exact current date and time in an IANA timezone.",
                {
                    **object_schema,
                    "properties": {"iana_timezone": {"type": "string"}},
                },
                get_current_datetime,
            ),
            Tool(
                "parse_datetime",
                "Parse a date or time into local and UTC ISO timestamps.",
                {
                    **object_schema,
                    "properties": {
                        "text": {"type": "string"},
                        "assume_timezone": {"type": "string"},
                    },
                    "required": ["text"],
                },
                parse_datetime,
            ),
            Tool(
                "diff_datetimes",
                "Calculate the exact duration from the first timestamp to the second.",
                {
                    **object_schema,
                    "properties": {
                        "iso_a": {"type": "string"},
                        "iso_b": {"type": "string"},
                        "assume_timezone": {"type": "string"},
                    },
                    "required": ["iso_a", "iso_b"],
                },
                diff_datetimes,
            ),
            Tool(
                "add_duration",
                "Add weeks, days, hours, and minutes to a timestamp or the current time.",
                {
                    **object_schema,
                    "properties": {
                        "base_iso": {"type": ["string", "null"]},
                        "iana_timezone": {"type": "string"},
                        "weeks": {"type": "integer", "default": 0},
                        "days": {"type": "integer", "default": 0},
                        "hours": {"type": "integer", "default": 0},
                        "minutes": {"type": "integer", "default": 0},
                    },
                },
                add_duration,
            ),
            Tool(
                "next_weekday",
                "Find the calendar date of the next requested weekday.",
                {
                    **object_schema,
                    "properties": {
                        "weekday": {
                            "type": "string",
                            "enum": list(datetime_tools.WEEKDAYS),
                        },
                        "iana_timezone": {"type": "string"},
                        "reference_iso": {"type": ["string", "null"]},
                        "inclusive": {"type": "boolean", "default": True},
                    },
                    "required": ["weekday"],
                },
                next_weekday,
            ),
            Tool(
                "convert_timezone",
                "Convert a timestamp to another IANA timezone.",
                {
                    **object_schema,
                    "properties": {
                        "iso_datetime": {"type": "string"},
                        "target_iana_timezone": {"type": "string"},
                        "assume_timezone": {"type": "string"},
                    },
                    "required": ["iso_datetime", "target_iana_timezone"],
                },
                convert_timezone,
            ),
        ]
        if self.integrations is None:
            return tools

        async def list_smart_devices(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            rows = await self.integrations.smart_home.list_devices(ctx.user_id)
            compact = []
            for row in rows:
                entry = {
                    key: row.get(key)
                    for key in ("id", "name", "source_name", "room")
                    if row.get(key) not in {None, ""}
                }
                entry["capabilities"] = row.get("capabilities") or []
                sockets = [
                    component["name"] or component["key"]
                    for component in row.get("components") or []
                    if component.get("key") != "main"
                ]
                if sockets:
                    entry["sockets"] = sockets
                if not row.get("available"):
                    entry["available"] = False
                compact.append(entry)
            return compact

        async def control_smart_device(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            parameters = dict(args.get("parameters", {}))
            component = str(args.get("component") or "").strip()
            if component:
                parameters["component"] = component
            return await self.integrations.smart_home.control_device(
                ctx.user_id,
                str(args["device_id"]),
                str(args["action"]),
                parameters,
            )

        async def control_lights(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            scope = str(args.get("scope") or "room").strip().lower()
            selector = str(args.get("selector") or "").strip()
            if scope == "room" and not selector:
                selector = ctx.device_room
            return await self.integrations.smart_home.control_lights(
                ctx.user_id,
                scope,
                selector,
                str(args["action"]),
                dict(args.get("parameters", {})),
            )

        async def room_lights_off(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del args
            return await self.integrations.smart_home.control_room_lights_for_device(
                ctx.user_id, ctx.device_id, "turn_off"
            )

        async def room_lights_on(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del args
            return await self.integrations.smart_home.control_room_lights_for_device(
                ctx.user_id, ctx.device_id, "turn_on"
            )

        async def search_gmail(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.integrations.gmail.search(
                ctx.user_id, str(args["query"]), int(args.get("limit", 10))
            )

        async def read_gmail(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            return await self.integrations.gmail.read(ctx.user_id, str(args["message_id"]))

        async def search_web(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.search_web(
                str(args["query"]), int(args.get("limit", 5))
            )

        async def search_wikipedia(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.search_wiki(
                str(args["query"]), limit=int(args.get("limit", 5))
            )

        async def search_stackoverflow(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.search_stackoverflow(
                str(args["query"]), int(args.get("limit", 5))
            )

        async def search_wookieepedia(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.search_wiki(
                str(args["query"]),
                wookieepedia=True,
                limit=int(args.get("limit", 5)),
            )

        async def search_star_wars(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.search_star_wars(str(args["query"]))

        async def weather_search_locations(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.weather_locations(str(args.get("query", "")))

        async def weather_current(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.weather_current(str(args["location_key"]))

        async def weather_forecast(ctx: ToolContext, args: Dict[str, Any]) -> Any:
            del ctx
            return await self.integrations.knowledge.weather_forecast(
                str(args["location_key"]), str(args.get("kind", "daily"))
            )

        tools.extend(
            [
                Tool(
                    "list_smart_devices",
                    "List compact ids, names, rooms, and capabilities for smart lights, outlets, "
                    "and televisions. Do not use this before room_lights_off or room_lights_on.",
                    {**object_schema, "properties": {}},
                    list_smart_devices,
                ),
                Tool(
                    "room_lights_off",
                    "Immediately turn off every light assigned to the calling Jarvis device's "
                    "room. Takes no arguments and performs its own device, room, and light "
                    "lookup. Use directly for a voice request such as 'lights off'; never list "
                    "devices first.",
                    {**object_schema, "properties": {}},
                    room_lights_off,
                ),
                Tool(
                    "room_lights_on",
                    "Immediately turn on every light assigned to the calling Jarvis device's "
                    "room. Takes no arguments and performs its own device, room, and light "
                    "lookup. Use directly for a voice request such as 'lights on'; never list "
                    "devices first.",
                    {**object_schema, "properties": {}},
                    room_lights_on,
                ),
                Tool(
                    "control_lights",
                    "Control lights by a specific device name, named room, or the whole home. "
                    "Use room_lights_off or room_lights_on instead for an unnamed room request "
                    "on a voice device. brightness takes parameters.percent 1-100, color takes "
                    "red, green, and blue 0-255, and color_temperature takes kelvin.",
                    {
                        **object_schema,
                        "properties": {
                            "scope": {
                                "type": "string",
                                "enum": ["device", "room", "all"],
                                "default": "room",
                            },
                            "selector": {"type": "string"},
                            "action": {
                                "type": "string",
                                "enum": [
                                    "turn_on",
                                    "turn_off",
                                    "brightness",
                                    "color",
                                    "color_temperature",
                                ],
                            },
                            "parameters": {"type": "object"},
                        },
                        "required": ["action"],
                    },
                    control_lights,
                ),
                Tool(
                    "control_smart_device",
                    "Control one non-light smart device, such as a television or an outlet, by "
                    "the exact id returned by list_smart_devices. Use control_lights for lights. "
                    "Set component to address one socket of a multi-outlet plug. launch_app takes "
                    "parameters.app (a name) or parameters.app_id, and key takes parameters.key.",
                    {
                        **object_schema,
                        "properties": {
                            "device_id": {"type": "string"},
                            "action": {
                                "type": "string",
                                "enum": sorted(ACTION_CAPABILITIES),
                            },
                            "component": {"type": "string"},
                            "parameters": {"type": "object"},
                        },
                        "required": ["device_id", "action"],
                    },
                    control_smart_device,
                ),
                Tool(
                    "search_gmail",
                    "Search the owner's connected Gmail using Gmail search syntax.",
                    {
                        **object_schema,
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 25},
                        },
                        "required": ["query"],
                    },
                    search_gmail,
                ),
                Tool(
                    "read_gmail",
                    "Read the full body and metadata of a Gmail message returned by search_gmail.",
                    {
                        **object_schema,
                        "properties": {"message_id": {"type": "string"}},
                        "required": ["message_id"],
                    },
                    read_gmail,
                ),
                Tool(
                    "search_web",
                    "Search the current public web. Use for news, changing facts, products, "
                    "schedules, or anything requiring up-to-date information.",
                    {
                        **object_schema,
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                        },
                        "required": ["query"],
                    },
                    search_web,
                ),
                Tool(
                    "search_wikipedia",
                    "Search Wikipedia for general knowledge and source links.",
                    {
                        **object_schema,
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                        },
                        "required": ["query"],
                    },
                    search_wikipedia,
                ),
                Tool(
                    "search_stackoverflow",
                    "Search Stack Overflow for programming questions and answers.",
                    {
                        **object_schema,
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                        },
                        "required": ["query"],
                    },
                    search_stackoverflow,
                ),
                Tool(
                    "search_wookieepedia",
                    "Search Wookieepedia for detailed Star Wars lore.",
                    {
                        **object_schema,
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                        },
                        "required": ["query"],
                    },
                    search_wookieepedia,
                ),
                Tool(
                    "search_star_wars",
                    "Search SWAPI for structured Star Wars facts.",
                    {
                        **object_schema,
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                    search_star_wars,
                ),
                Tool(
                    "weather_search_locations",
                    "Find a weather location key for a city, region, or postal code.",
                    {
                        **object_schema,
                        "properties": {"query": {"type": "string", "default": ""}},
                    },
                    weather_search_locations,
                ),
                Tool(
                    "weather_current",
                    "Get current conditions for a key returned by weather_search_locations.",
                    {
                        **object_schema,
                        "properties": {"location_key": {"type": "string"}},
                        "required": ["location_key"],
                    },
                    weather_current,
                ),
                Tool(
                    "weather_forecast",
                    "Get a five-day daily or twelve-hour hourly weather forecast.",
                    {
                        **object_schema,
                        "properties": {
                            "location_key": {"type": "string"},
                            "kind": {
                                "type": "string",
                                "enum": ["daily", "hourly"],
                                "default": "daily",
                            },
                        },
                        "required": ["location_key"],
                    },
                    weather_forecast,
                ),
            ]
        )
        return tools
