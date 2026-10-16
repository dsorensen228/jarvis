"""Shared API models and small domain helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


class TokenRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=1024)


class GoogleTokenRequest(BaseModel):
    google_id_token: str = Field(..., min_length=1, max_length=16_384)


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=8, max_length=1024)
    name: str = Field("", max_length=200)


class UserPatch(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    settings: Optional[Dict[str, Any]] = None


class PushTokenRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=4096)
    provider: Literal["expo"] = "expo"
    platform: str = Field("", max_length=50)
    device_id: Optional[str] = Field(None, max_length=300)


class PushTokenDelete(BaseModel):
    token: Optional[str] = Field(None, max_length=4096)
    provider: Literal["expo"] = "expo"
    device_id: Optional[str] = Field(None, max_length=300)


class ConversationCreate(BaseModel):
    title: str = Field("New conversation", max_length=300)
    project_id: Optional[str] = None


class ConversationPatch(BaseModel):
    title: Optional[str] = Field(None, max_length=300)
    project_id: Optional[str] = None


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=100_000)
    conversation_id: Optional[str] = None
    attachments: List[str] = Field(default_factory=list)


class WearChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=10_000)
    conversation_id: Optional[str] = None


class TodoCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    category: str = Field("", max_length=100)


class TodoPatch(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=500)
    completed: Optional[bool] = None
    category: Optional[str] = Field(None, max_length=100)


class ShoppingListCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class ShoppingListPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    add_items: List[str] = Field(default_factory=list)
    remove_item_ids: List[str] = Field(default_factory=list)
    toggle_item_ids: List[str] = Field(default_factory=list)
    share_with_user_id: Optional[str] = None


class TimerCreate(BaseModel):
    label: str = Field("", max_length=200)
    duration_seconds: int = Field(..., gt=0, le=604800)


class TimerPatch(BaseModel):
    action: Literal["start", "pause", "reset", "cancel"]


class ProjectCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    description: str = Field("", max_length=100_000)


class ProjectPatch(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=300)
    description: Optional[str] = Field(None, max_length=100_000)
    status: Optional[str] = Field(None, max_length=100_000)


class TextAssetCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    body: str = Field(..., max_length=2_000_000)
    project_id: Optional[str] = None
    conversation_id: Optional[str] = None
    parent_id: Optional[str] = None
    keywords: List[str] = Field(default_factory=list)


class TextAssetPatch(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=500)
    body: Optional[str] = Field(None, max_length=2_000_000)
    keywords: Optional[List[str]] = None
    parent_id: Optional[str] = None


class DeviceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    kind: Literal["voice", "camera", "display", "wearable"]
    room: str = Field("", max_length=200)
    base_url: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class DevicePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    kind: Optional[Literal["voice", "camera", "display", "wearable"]] = None
    room: Optional[str] = Field(None, max_length=200)
    base_url: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class DeviceRegistration(BaseModel):
    callback_token: str = Field(..., min_length=16, max_length=4096)
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    kind: Literal["camera"] = "camera"
    room: Optional[str] = Field(None, max_length=200)
    base_url: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class MemoryCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=20_000)
    category: str = Field("general", min_length=1, max_length=100)


class MemoryPatch(BaseModel):
    content: Optional[str] = Field(None, min_length=1, max_length=20_000)
    category: Optional[str] = Field(None, min_length=1, max_length=100)


class SmartDevicePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    room: Optional[str] = Field(None, max_length=200)
    # Whether the device answers to room and whole-home light requests. A smart
    # plug holding a lamp is a light; an outlet running a heater is not, so this
    # is never inferred from the device's domain alone.
    is_light: Optional[bool] = None
    # Owner labels for individually switchable sockets, keyed by component.
    component_labels: Optional[Dict[str, str]] = None
    # Overrides which display in a room receives that room's media requests.
    primary_for_room: Optional[bool] = None


class RoomCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class RoomPatch(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


SMART_HOME_ACTIONS = Literal[
    "turn_on",
    "turn_off",
    "toggle",
    "brightness",
    "color",
    "color_temperature",
    "volume_up",
    "volume_down",
    "mute",
    "unmute",
    "play",
    "pause",
    "play_pause",
    "launch_app",
    "key",
]


class SmartHomeCommand(BaseModel):
    action: SMART_HOME_ACTIONS
    # Addresses one socket or sub-entity; empty means the device's main control.
    component: str = Field("", max_length=64)
    parameters: Dict[str, Any] = Field(default_factory=dict)


class LightControlRequest(BaseModel):
    scope: Literal["device", "room", "all"] = "room"
    selector: str = Field("", max_length=200)
    action: Literal["turn_on", "turn_off", "toggle", "brightness", "color", "color_temperature"]
    parameters: Dict[str, Any] = Field(default_factory=dict)
