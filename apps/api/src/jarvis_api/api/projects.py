from __future__ import annotations

import mimetypes
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response

from jarvis_api.auth import current_user
from jarvis_api.domain import ProjectCreate, ProjectPatch, TextAssetCreate, TextAssetPatch

router = APIRouter(prefix="/v1", tags=["projects"])


@router.get("/projects")
async def list_projects(request: Request, user: Dict[str, Any] = Depends(current_user)) -> Any:
    return await request.app.state.capabilities.list_projects(user["id"])


@router.post("/projects", status_code=201)
async def create_project(
    body: ProjectCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.capabilities.create_project(
        user["id"], body.title, body.description
    )


@router.get("/projects/{project_id}")
async def get_project(
    project_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    project = await request.app.state.store.get_entity("project", project_id, user["id"])
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    project["assets"] = [
        asset
        for asset in await request.app.state.store.list_entities("asset", user["id"], limit=1000)
        if asset.get("project_id") == project_id
    ]
    return project


@router.patch("/projects/{project_id}")
async def patch_project(
    project_id: str,
    body: ProjectPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    updated = await request.app.state.store.update_entity(
        "project", project_id, user["id"], body.dict(exclude_none=True)
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="project not found")
    return updated


@router.delete("/projects/{project_id}", status_code=204, response_class=Response)
async def delete_project(
    project_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    project = await request.app.state.store.get_entity("project", project_id, user["id"])
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    assets = await request.app.state.store.list_entities("asset", user["id"], limit=1000)
    for asset in assets:
        if asset.get("project_id") == project_id:
            await _delete_asset_file(request, asset)
            await request.app.state.store.delete_entity("asset", asset["id"], user["id"])
    await request.app.state.store.delete_entity("project", project_id, user["id"])
    return Response(status_code=204)


@router.get("/assets")
async def search_assets(
    request: Request,
    query: str = "",
    project_id: Optional[str] = None,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.capabilities.search_assets(user["id"], query, project_id)


@router.post("/assets/text", status_code=201)
async def create_text_asset(
    body: TextAssetCreate,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    return await request.app.state.store.create_entity(
        "asset",
        user["id"],
        {
            "kind": "text",
            "title": body.title,
            "body": body.body,
            "mime_type": "text/markdown",
            "project_id": body.project_id,
            "conversation_id": body.conversation_id,
            "parent_id": body.parent_id,
            "keywords": body.keywords,
        },
    )


@router.post("/assets/files", status_code=201)
async def upload_file_asset(
    request: Request,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    conversation_id: Optional[str] = Form(None),
    parent_id: Optional[str] = Form(None),
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    asset_id = uuid.uuid4().hex
    suffix = Path(file.filename or "").suffix[:20]
    relative = Path(user["id"]) / (asset_id + suffix)
    destination = request.app.state.settings.asset_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with destination.open("wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > 100 * 1024 * 1024:
                output.close()
                destination.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="asset exceeds 100 MiB")
            output.write(chunk)
    return await request.app.state.store.create_entity(
        "asset",
        user["id"],
        {
            "kind": "file",
            "title": title or file.filename or "Untitled file",
            "path": str(relative),
            "filename": file.filename,
            "mime_type": file.content_type
            or mimetypes.guess_type(file.filename or "")[0]
            or "application/octet-stream",
            "size": size,
            "project_id": project_id,
            "conversation_id": conversation_id,
            "parent_id": parent_id,
            "keywords": [],
        },
        entity_id=asset_id,
    )


@router.get("/assets/{asset_id}")
async def get_asset(
    asset_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    asset = await request.app.state.store.get_entity("asset", asset_id, user["id"])
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return asset


@router.get("/assets/{asset_id}/content")
async def get_asset_content(
    asset_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    asset = await request.app.state.store.get_entity("asset", asset_id, user["id"])
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    if asset.get("kind") == "text":
        return PlainTextResponse(asset.get("body", ""), media_type=asset.get("mime_type"))
    path = (request.app.state.settings.asset_dir / asset["path"]).resolve()
    if request.app.state.settings.asset_dir not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="asset content not found")
    return FileResponse(path, media_type=asset.get("mime_type"), filename=asset.get("filename"))


@router.patch("/assets/{asset_id}")
async def patch_text_asset(
    asset_id: str,
    body: TextAssetPatch,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    asset = await request.app.state.store.get_entity("asset", asset_id, user["id"])
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    if asset.get("kind") != "text" and body.body is not None:
        raise HTTPException(status_code=409, detail="binary file content cannot be patched")
    updated = await request.app.state.store.update_entity(
        "asset", asset_id, user["id"], body.dict(exclude_none=True)
    )
    return updated


@router.delete("/assets/{asset_id}", status_code=204, response_class=Response)
async def delete_asset(
    asset_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    asset = await request.app.state.store.get_entity("asset", asset_id, user["id"])
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    await _delete_asset_file(request, asset)
    await request.app.state.store.delete_entity("asset", asset_id, user["id"])
    return Response(status_code=204)


@router.get("/projects/{project_id}/tree")
async def project_tree(
    project_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    await _project(request, user["id"], project_id)
    assets = await request.app.state.store.list_entities("asset", user["id"], limit=1000)
    return [_tree_node(asset) for asset in assets if asset.get("project_id") == project_id]


@router.post("/projects/{project_id}/folders", status_code=201)
async def create_project_folder(
    project_id: str,
    body: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    await _project(request, user["id"], project_id)
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="folder name is required")
    folder = await request.app.state.store.create_entity(
        "asset",
        user["id"],
        {
            "kind": "folder",
            "title": name[:500],
            "project_id": project_id,
            "parent_id": body.get("parent_id"),
        },
    )
    return _tree_node(folder)


@router.patch("/projects/{project_id}/nodes/{node_id}")
async def rename_project_node(
    project_id: str,
    node_id: str,
    body: Dict[str, Any],
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Any:
    await _project(request, user["id"], project_id)
    node = await request.app.state.store.get_entity("asset", node_id, user["id"])
    if node is None or node.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="project node not found")
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=422, detail="node name is required")
    updated = await request.app.state.store.update_entity(
        "asset", node_id, user["id"], {"title": name[:500]}
    )
    return _tree_node(updated or node)


@router.delete("/projects/{project_id}/nodes/{node_id}", status_code=204)
async def delete_project_node(
    project_id: str,
    node_id: str,
    request: Request,
    user: Dict[str, Any] = Depends(current_user),
) -> Response:
    await _project(request, user["id"], project_id)
    assets = [
        asset
        for asset in await request.app.state.store.list_entities("asset", user["id"], limit=1000)
        if asset.get("project_id") == project_id
    ]
    by_parent: Dict[Optional[str], list] = {}
    for asset in assets:
        by_parent.setdefault(asset.get("parent_id"), []).append(asset)
    targets = []
    pending = [node_id]
    while pending:
        current = pending.pop()
        node = next((asset for asset in assets if asset["id"] == current), None)
        if node is not None:
            targets.append(node)
            pending.extend(child["id"] for child in by_parent.get(current, []))
    if not targets:
        raise HTTPException(status_code=404, detail="project node not found")
    for node in targets:
        await _delete_asset_file(request, node)
        await request.app.state.store.delete_entity("asset", node["id"], user["id"])
    return Response(status_code=204)


async def _project(request: Request, owner_id: str, project_id: str) -> Dict[str, Any]:
    project = await request.app.state.store.get_entity("project", project_id, owner_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _tree_node(asset: Dict[str, Any]) -> Dict[str, Any]:
    is_folder = asset.get("kind") == "folder"
    return {
        "id": asset["id"],
        "project_id": asset.get("project_id"),
        "parent_id": asset.get("parent_id"),
        "type": "folder" if is_folder else "asset",
        "name": asset.get("title") or asset.get("filename") or "Untitled",
        "asset_id": None if is_folder else asset["id"],
        "created_at": asset.get("created_at"),
        "updated_at": asset.get("updated_at"),
    }


async def _delete_asset_file(request: Request, asset: Dict[str, Any]) -> None:
    if not asset.get("path"):
        return
    path = (request.app.state.settings.asset_dir / asset["path"]).resolve()
    if request.app.state.settings.asset_dir in path.parents:
        path.unlink(missing_ok=True)
