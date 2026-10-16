"""Research workspace policy and the safe, portable report artifact contract."""

from __future__ import annotations

import os
import re
import stat
from contextlib import suppress
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import nh3

from .config import Settings
from .models import ResearchVerbosity

MAX_REPORT_BYTES = 2 * 1024 * 1024
PROMPTS_DIR = Path(__file__).parent / "prompts"
REPORT_CLASSES = {
    "research-report",
    "lead",
    "callout",
    "metric-grid",
    "metric",
    "table-wrap",
    "source-list",
    "muted",
}
HTML_TAGS = {
    "article",
    "section",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "s",
    "small",
    "mark",
    "sub",
    "sup",
    "blockquote",
    "q",
    "cite",
    "abbr",
    "time",
    "pre",
    "code",
    "kbd",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
    "table",
    "caption",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "a",
    "details",
    "summary",
}
SVG_TAGS = {
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "title",
    "desc",
    "defs",
    "marker",
}
SVG_ATTRIBUTES = {
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "stroke-dashoffset",
    "fill-opacity",
    "stroke-opacity",
    "opacity",
    "fill-rule",
    "transform",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "width",
    "height",
    "d",
    "points",
    "dx",
    "dy",
    "text-anchor",
    "dominant-baseline",
    "font-size",
    "font-weight",
    "marker-start",
    "marker-mid",
    "marker-end",
}
ATTRIBUTES = {
    "*": {"class", "id", "title", "role", "aria-label", "aria-labelledby", "aria-describedby"},
    "a": {"href"},
    "th": {"scope", "colspan", "rowspan"},
    "td": {"colspan", "rowspan"},
    "ol": {"start", "reversed"},
    "li": {"value"},
    "time": {"datetime"},
    **{tag: SVG_ATTRIBUTES for tag in SVG_TAGS},
    "svg": SVG_ATTRIBUTES | {"viewBox", "preserveAspectRatio"},
    "marker": SVG_ATTRIBUTES | {"viewBox", "refX", "refY", "markerWidth", "markerHeight", "orient"},
}
REMOVED_CONTENT_TAGS = {
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "template",
    "noscript",
    "audio",
    "video",
    "canvas",
    "foreignObject",
    "foreignobject",
    "image",
    "use",
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
}
IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]*\Z")
SAFE_COLOR = re.compile(
    r"(?:#[0-9a-fA-F]{3,8}|[A-Za-z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,% +\-/]+\))\Z"
)
LOCAL_MARKER = re.compile(r"(?:none|url\(#[A-Za-z][A-Za-z0-9_.:-]*\))\Z")
DEPTH_INSTRUCTIONS = {
    "concise": "Use direct essentials with minimal elaboration for each item or finding.",
    "standard": "Use balanced explanation and relevant supporting evidence for each finding.",
    "in_depth": (
        "Give considerable detail per item or finding, including helpful reasoning, context, "
        "evidence, caveats, and implications."
    ),
}


def _attribute_filter(tag: str, attribute: str, value: str) -> str | None:
    if attribute == "class":
        return " ".join(item for item in value.split() if item in REPORT_CLASSES) or None
    if attribute == "id":
        return value if IDENTIFIER.fullmatch(value) else None
    if attribute == "href":
        if value.startswith("#") and IDENTIFIER.fullmatch(value[1:]):
            return value
        try:
            parsed = urlsplit(value)
        except ValueError:
            return None
        return value if parsed.scheme in {"https", "http"} and parsed.hostname else None
    if attribute in {"fill", "stroke"}:
        return value if SAFE_COLOR.fullmatch(value) else None
    if attribute.startswith("marker-"):
        return value if LOCAL_MARKER.fullmatch(value) else None
    return value


CLEANER = nh3.Cleaner(
    tags=HTML_TAGS | SVG_TAGS,
    clean_content_tags=REMOVED_CONTENT_TAGS,
    attributes=ATTRIBUTES,
    attribute_filter=_attribute_filter,
    url_schemes={"https", "http"},
    link_rel="noopener noreferrer",
    strip_comments=True,
)


class _ReportContent(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.has_structure = False
        self.text: list[str] = []
        self.html: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.has_structure |= tag in HTML_TAGS - {"br", "hr", "a", "span"}
        if tag == "a":
            # Serialize only sanitized attributes. Local anchors stay in the report;
            # source citations open in a separate browsing context outside the viewer.
            if any(name == "href" and value and not value.startswith("#") for name, value in attrs):
                attrs = [*attrs, ("target", "_blank")]
            attributes = "".join(
                f' {name}="{escape(value or "", quote=True)}"' for name, value in attrs
            )
            self.html.append(f"<a{attributes}>")
        else:
            self.html.append(self.get_starttag_text())

    def handle_endtag(self, tag: str) -> None:
        self.html.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        self.text.append(data)
        self.html.append(data)

    def handle_entityref(self, name: str) -> None:
        self.html.append(f"&{name};")
        self.text.append(unescape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        self.html.append(f"&#{name};")
        self.text.append(unescape(f"&#{name};"))


def _write_policy(directory_fd: int, policy: str) -> None:
    fd = os.open(
        "AGENTS.md",
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory_fd,
    )
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(policy)


def initialize_workspace(settings: Settings) -> Path:
    root = settings.research_workspace.expanduser()
    if root.is_symlink():
        raise ValueError("research workspace must not be a symlink")
    root = root.resolve()
    coding = settings.workspace.resolve()
    if root == coding or root.is_relative_to(coding) or coding.is_relative_to(root):
        raise ValueError("research workspace must be separate from the engineering workspace")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    policy = (PROMPTS_DIR / "research-AGENTS.md").read_text(encoding="utf-8")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _write_policy(root_fd, policy)
    finally:
        os.close(root_fd)
    return root


def prepare_workspace(settings: Settings, task_id: str) -> Path:
    if str(UUID(task_id)) != task_id:
        raise ValueError("research task ID must be a canonical UUID")
    root = initialize_workspace(settings)
    policy = (PROMPTS_DIR / "research-AGENTS.md").read_text(encoding="utf-8")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with suppress(FileExistsError):
            os.mkdir(task_id, mode=0o700, dir_fd=root_fd)
        try:
            task_fd = os.open(task_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except OSError as exc:
            raise ValueError("research task directory must be a regular directory") from exc
        try:
            _write_policy(task_fd, policy)
            # A repeated setup must not mistake an interrupted run's report for new work.
            with suppress(FileNotFoundError):
                os.unlink("report.html", dir_fd=task_fd)
        finally:
            os.close(task_fd)
    finally:
        os.close(root_fd)
    return root / task_id


def research_prompt(task_id: str, prompt: str, verbosity: ResearchVerbosity) -> str:
    return (
        f"Code Factory research task {task_id}.\n\n"
        f"{(PROMPTS_DIR / 'research.md').read_text(encoding='utf-8').strip()}\n\n"
        f"Requested detail level: {verbosity}. {DEPTH_INSTRUCTIONS[verbosity]}\n"
        "Cover the complete requested scope at every detail level. Depth changes the detail "
        "per point, never the number of requested items or coverage. A concise exhaustive list "
        "can still be long. Avoid filler and repetition.\n\n"
        f"Research request:\n{prompt}"
    )


def write_previous_report(workspace: Path, html: str) -> None:
    if len(html.encode("utf-8")) > MAX_REPORT_BYTES:
        raise ValueError("previous research report exceeds the artifact size limit")
    directory_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(
            "previous-report.html",
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_fd,
        )
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(html)
    finally:
        os.close(directory_fd)


def read_report(workspace: Path) -> str:
    """Read only this run's regular UTF-8 artifact, then sanitize before persistence."""
    if workspace.is_symlink() or workspace.parent.is_symlink():
        raise ValueError("research report directory must not be a symlink")
    try:
        directory_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            report_fd = os.open(
                "report.html", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd
            )
        finally:
            os.close(directory_fd)
        with os.fdopen(report_fd, "rb") as artifact:
            info = os.fstat(artifact.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("report.html must be a regular file, not a link or device")
            if info.st_size > MAX_REPORT_BYTES:
                raise ValueError("report.html exceeds the 2 MiB artifact size limit")
            raw = artifact.read(MAX_REPORT_BYTES + 1)
    except OSError as exc:
        raise ValueError("report.html is missing, unreadable, or a symlink") from exc
    if len(raw) > MAX_REPORT_BYTES:
        raise ValueError("report.html exceeds the 2 MiB artifact size limit")
    try:
        html = CLEANER.clean(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError("report.html must contain UTF-8 HTML") from exc
    content = _ReportContent()
    content.feed(html)
    if not content.has_structure or not "".join(content.text).strip():
        raise ValueError("report.html must contain meaningful HTML research content")
    html = "".join(content.html)
    if len(html.encode("utf-8")) > MAX_REPORT_BYTES:
        raise ValueError("sanitized report exceeds the 2 MiB artifact size limit")
    return html
