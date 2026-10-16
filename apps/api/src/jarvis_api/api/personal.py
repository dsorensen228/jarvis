from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from jarvis_api.auth import current_user
from jarvis_api.domain import (
    MemoryCreate,
    MemoryPatch,
    ShoppingListCreate,
    ShoppingListPatch,
    TimerCreate,
    TimerPatch,
    TodoCreate,
    TodoPatch,
    utc_now,
)

router = APIRouter(prefix="/v1", tags=["personal"])


@router.get("/memories")
async def list_memories(
    request: Request,
    q: str = "",
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    if q.strip():
        return await request.app.state.capabilities.search_memories(user["id"], q)
    return await request.app.state.capabilities.list_memories(user["id"])


@router.post("/memories", status_code=201)
async def create_memory(
    body: MemoryCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.capabilities.create_memory(
        user["id"], body.content, body.category
    )


@router.patch("/memories/{memory_id}")
async def patch_memory(
    memory_id: str,
    body: MemoryPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    updated = await request.app.state.store.update_entity(
        "memory", memory_id, user["id"], body.dict(exclude_none=True)
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="memory not found")
    return updated


@router.delete("/memories/{memory_id}", status_code=204, response_class=Response)
async def delete_memory(
    memory_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    if not await request.app.state.store.delete_entity("memory", memory_id, user["id"]):
        raise HTTPException(status_code=404, detail="memory not found")
    return Response(status_code=204)


@router.get("/todos")
async def list_todos(
    request: Request,
    include_completed: bool = True,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.capabilities.list_todos(user["id"], include_completed)


@router.post("/todos", status_code=201)
async def create_todo(
    body: TodoCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.capabilities.create_todo(user["id"], body.title, body.category)


@router.patch("/todos/{todo_id}")
async def patch_todo(
    todo_id: str,
    body: TodoPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    updated = await request.app.state.store.update_entity(
        "todo", todo_id, user["id"], body.dict(exclude_none=True)
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return updated


@router.delete("/todos/{todo_id}", status_code=204, response_class=Response)
async def delete_todo(
    todo_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    if not await request.app.state.store.delete_entity("todo", todo_id, user["id"]):
        raise HTTPException(status_code=404, detail="todo not found")
    return Response(status_code=204)


@router.get("/shopping-lists")
async def list_shopping_lists(
    request: Request, user: Dict[str, Any] = Depends(current_user)
) -> Any:
    rows = await request.app.state.store.list_all_entities("shopping_list", limit=1000)
    return [
        _public_shopping_list(row, user["id"])
        for row in rows
        if row["owner_id"] == user["id"] or user["id"] in row.get("shared_with", [])
    ]


@router.post("/shopping-lists", status_code=201)
async def create_shopping_list(
    body: ShoppingListCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    row = await request.app.state.store.create_entity(
        "shopping_list", user["id"], {"name": body.name.strip(), "items": [], "shared_with": []}
    )
    row["owner_id"] = user["id"]
    return _public_shopping_list(row, user["id"])


@router.patch("/shopping-lists/{list_id}")
async def patch_shopping_list(
    list_id: str,
    body: ShoppingListPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    current = await _shopping_list(request, list_id)
    owner_id = current["owner_id"]
    if owner_id != user["id"] and user["id"] not in current.get("shared_with", []):
        raise HTTPException(status_code=404, detail="shopping list not found")
    if body.share_with_user_id is not None and owner_id != user["id"]:
        raise HTTPException(status_code=403, detail="only the owner can share a shopping list")

    def mutate(current: Dict[str, Any]) -> Dict[str, Any]:
        if body.name is not None:
            current["name"] = body.name
        items = list(current.get("items", []))
        remove = set(body.remove_item_ids)
        toggle = set(body.toggle_item_ids)
        items = [item for item in items if item.get("id") not in remove]
        for item in items:
            if item.get("id") in toggle:
                item["checked"] = not bool(item.get("checked"))
        import uuid

        for text in body.add_items:
            if text.strip():
                items.append({"id": uuid.uuid4().hex, "text": text.strip(), "checked": False})
        current["items"] = items
        if body.share_with_user_id:
            shared = set(current.get("shared_with", []))
            shared.add(body.share_with_user_id)
            current["shared_with"] = sorted(shared)
        return current

    updated = await request.app.state.store.mutate_entity(
        "shopping_list", list_id, owner_id, mutate
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="shopping list not found")
    updated["owner_id"] = owner_id
    return _public_shopping_list(updated, user["id"])


@router.delete("/shopping-lists/{list_id}", status_code=204, response_class=Response)
async def delete_shopping_list(
    list_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    current = await _shopping_list(request, list_id)
    if current["owner_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="shopping list not found")
    if not await request.app.state.store.delete_entity("shopping_list", list_id, user["id"]):
        raise HTTPException(status_code=404, detail="shopping list not found")
    return Response(status_code=204)


async def _shopping_list(request: Request, list_id: str) -> Dict[str, Any]:
    row = next(
        (
            item
            for item in await request.app.state.store.list_all_entities("shopping_list", limit=1000)
            if item["id"] == list_id
        ),
        None,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="shopping list not found")
    return row


def _public_shopping_list(row: Dict[str, Any], viewer_id: str) -> Dict[str, Any]:
    return {
        **row,
        "owner_id": row["owner_id"],
        "is_shared_with_me": row["owner_id"] != viewer_id,
    }


@router.get("/timers")
async def list_timers(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    return await request.app.state.capabilities.list_timers(user["id"])


@router.post("/timers", status_code=201)
async def create_timer(
    body: TimerCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.capabilities.create_timer(
        user["id"], body.label, body.duration_seconds
    )


@router.patch("/timers/{timer_id}")
async def patch_timer(
    timer_id: str,
    body: TimerPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    def mutate(timer: Dict[str, Any]) -> Dict[str, Any]:
        now = utc_now()
        remaining = int(timer.get("remaining_seconds", timer.get("duration_seconds", 0)))
        if timer.get("status") == "running" and timer.get("fire_at"):
            try:
                fire_at = datetime.fromisoformat(timer["fire_at"])
                remaining = max(0, int((fire_at - now).total_seconds()))
            except ValueError:
                pass
        if body.action == "start":
            timer.update(
                status="running",
                started_at=now.isoformat(),
                fire_at=(now + timedelta(seconds=remaining)).isoformat(),
            )
        elif body.action == "pause":
            timer.update(status="paused", remaining_seconds=remaining, fire_at=None)
        elif body.action == "reset":
            timer.update(
                status="idle",
                remaining_seconds=int(timer["duration_seconds"]),
                started_at=None,
                fire_at=None,
            )
        else:
            timer.update(status="cancelled", remaining_seconds=remaining, fire_at=None)
        return timer

    updated = await request.app.state.store.mutate_entity("timer", timer_id, user["id"], mutate)
    if updated is None:
        raise HTTPException(status_code=404, detail="timer not found")
    return request.app.state.capabilities.materialize_timer(updated)


@router.delete("/timers/{timer_id}", status_code=204, response_class=Response)
async def delete_timer(
    timer_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    if not await request.app.state.store.delete_entity("timer", timer_id, user["id"]):
        raise HTTPException(status_code=404, detail="timer not found")
    return Response(status_code=204)
