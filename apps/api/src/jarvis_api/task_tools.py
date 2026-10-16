"""Chat adapters for the existing authenticated Code Factory task gateway."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List

from jarvis_api.api.task_models import (
    TASK_STATUSES,
    AgentModel,
    CreateCodeTask,
    CreateResearchTask,
)
from jarvis_api.tools import Tool, ToolContext


# Match the existing Coding and Research tabs while preserving the public API's
# required model field. Model choices and prompt validation remain shared.
class ChatCodeTask(CreateCodeTask):
    model: AgentModel = "gpt-6-sol"


class ChatResearchTask(CreateResearchTask):
    model: AgentModel = "gpt-6-sol"


def build_task_tools(registry: Any) -> List[Tool]:
    def client() -> Any:
        if registry.code_factory is None:
            raise RuntimeError("Code Factory is unavailable")
        return registry.code_factory

    def task_id(args: Dict[str, Any]) -> str:
        value = args.get("task_id")
        if not isinstance(value, str) or not value.strip():
            raise ValueError("task_id must contain non-whitespace text")
        return value

    def list_arguments(args: Dict[str, Any]) -> Dict[str, Any]:
        limit = args.get("limit", 30)
        task_status = args.get("status")
        cursor = args.get("cursor")
        view = args.get("view", "all")
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("limit must be between 1 and 200")
        if task_status is not None and task_status not in TASK_STATUSES:
            raise ValueError("invalid task status")
        if view not in ("all", "active", "history"):
            raise ValueError("invalid task view")
        if task_status is not None and view != "all":
            raise ValueError("choose either a status or a view")
        if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 1024):
            raise ValueError("cursor must be a string of at most 1024 characters")
        return {"limit": limit, "task_status": task_status, "cursor": cursor, "view": view}

    async def create_code_task(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        request = ChatCodeTask(**args)
        task = await client().create_task(request.prompt, request.model)
        if registry.task_notifications:
            await registry.task_notifications.track(ctx.user_id, task, "code", created=True)
        return task

    async def list_code_tasks(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        page = await client().list_tasks(**list_arguments(args))
        if registry.task_notifications:
            for task in page["items"]:
                await registry.task_notifications.track(ctx.user_id, task, "code")
        return page

    async def get_code_task(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        task = await client().get_task(task_id(args))
        if registry.task_notifications:
            await registry.task_notifications.track(ctx.user_id, task, "code")
        return task

    async def cancel_code_task(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        return await client().cancel_task(task_id(args))

    async def create_research_task(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        request = ChatResearchTask(**args)
        task = await client().create_research_task(request.prompt, request.model, request.verbosity)
        if registry.task_notifications:
            await registry.task_notifications.track(ctx.user_id, task, "research", created=True)
        return task

    async def list_research_tasks(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        page = await client().list_research_tasks(**list_arguments(args))
        if registry.task_notifications:
            for task in page["items"]:
                await registry.task_notifications.track(ctx.user_id, task, "research")
        return page

    async def get_research_task(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        task = await client().get_research_task(task_id(args))
        if registry.task_notifications:
            await registry.task_notifications.track(ctx.user_id, task, "research")
        return task

    async def cancel_research_task(ctx: ToolContext, args: Dict[str, Any]) -> Any:
        return await client().cancel_research_task(task_id(args))

    task_id_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"task_id": {"type": "string", "minLength": 1}},
        "required": ["task_id"],
    }
    list_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30},
            "status": {"type": "string", "enum": sorted(TASK_STATUSES)},
            "cursor": {"type": "string", "maxLength": 1024},
            "view": {
                "type": "string",
                "enum": ["all", "active", "history"],
                "default": "all",
                "description": "Choose either a status filter or a non-all view, not both.",
            },
        },
    }
    code_schema = deepcopy(ChatCodeTask.schema())
    code_schema["additionalProperties"] = False
    research_schema = deepcopy(ChatResearchTask.schema())
    research_schema["additionalProperties"] = False
    return [
        Tool(
            "create_code_task",
            "Start an autonomous Code Factory task to implement, fix, test, or change code "
            "in the Jarvis workspace. It runs in the background; return its id and status, "
            "then use get_code_task to inspect progress. Omit model unless the user selects one.",
            code_schema,
            create_code_task,
        ),
        Tool(
            "list_code_tasks",
            "List Code Factory tasks with optional status/view and pagination.",
            list_schema,
            list_code_tasks,
        ),
        Tool(
            "get_code_task",
            "Inspect a Code Factory task's status, result, logs, and changed files.",
            task_id_schema,
            get_code_task,
        ),
        Tool(
            "cancel_code_task",
            "Request cancellation of a Code Factory task when asked to stop it.",
            task_id_schema,
            cancel_code_task,
        ),
        Tool(
            "create_research_task",
            "Start a background research task using the research engine. It investigates the full "
            "requested scope and produces an HTML report available in the Research tab "
            "and task card. "
            "Use verbosity to choose concise, standard, or in-depth treatment. Return the task id "
            "and status; do not claim it is finished yet. Omit model unless the user selects one.",
            research_schema,
            create_research_task,
        ),
        Tool(
            "list_research_tasks",
            "List research tasks with optional status/view and pagination.",
            list_schema,
            list_research_tasks,
        ),
        Tool(
            "get_research_task",
            "Inspect research task progress, results, and report availability.",
            task_id_schema,
            get_research_task,
        ),
        Tool(
            "cancel_research_task",
            "Request cancellation of a research task when asked to stop it.",
            task_id_schema,
            cancel_research_task,
        ),
    ]
