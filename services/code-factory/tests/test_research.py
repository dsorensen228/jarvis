from dataclasses import replace
from uuid import uuid4

import pytest

from code_factory import research
from code_factory.config import Settings


def settings_for(tmp_path):
    return replace(
        Settings.from_env(), workspace=tmp_path / "coding", research_workspace=tmp_path / "research"
    )


def test_task_workspace_is_isolated_and_canonical_policy_is_refreshed(tmp_path):
    settings = settings_for(tmp_path)
    task_id = str(uuid4())
    folder = research.prepare_workspace(settings, task_id)
    assert folder == settings.research_workspace / task_id
    assert folder.is_dir()
    policy = (folder / "AGENTS.md").read_text()
    assert policy.strip()
    (folder / "AGENTS.md").write_text("Stale policy")
    assert research.prepare_workspace(settings, task_id) == folder
    assert (folder / "AGENTS.md").read_text() == policy
    assert not settings.workspace.exists()


@pytest.mark.parametrize("task_id", ["../escape", "/tmp/escape", "not-a-task-id"])
def test_task_workspace_rejects_invalid_ids(tmp_path, task_id):
    with pytest.raises(ValueError):
        research.prepare_workspace(settings_for(tmp_path), task_id)


def test_task_workspace_rejects_symlink_and_engineering_workspace(tmp_path):
    settings = settings_for(tmp_path)
    settings.research_workspace.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    task_id = str(uuid4())
    (settings.research_workspace / task_id).symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ValueError):
        research.prepare_workspace(settings, task_id)
    assert not (elsewhere / "AGENTS.md").exists()
    with pytest.raises(ValueError):
        research.prepare_workspace(
            replace(settings, research_workspace=settings.workspace / "research"), str(uuid4())
        )


def test_report_preserves_semantics_links_classes_and_svg(tmp_path):
    folder = research.prepare_workspace(settings_for(tmp_path), str(uuid4()))
    (folder / "report.html").write_text("""<!doctype html><html><body>
    <article class="research-report random"><h1>Power demand</h1>
    <p class="lead">Demand grew 10%.</p><div class="callout">A caveat.</div>
    <div class="table-wrap"><table><caption>Demand</caption><tr><th scope="col">Year</th>
    <td>2026</td></tr></table></div><figure><svg viewBox="0 0 100 50" role="img"
    aria-label="Demand chart"><title>Demand</title><rect x="0" y="0" width="30"
    height="40" fill="#3077aa"/><path d="M0 40L30 10" stroke="currentColor"/>
    <text x="5" y="20">10%</text></svg><figcaption>Measured growth</figcaption></figure>
    <ul class="source-list"><li><a href="https://example.org/source">Source</a>
    <a href="#section">Section</a></li></ul>
    </article></body></html>""")
    html = research.read_report(folder)
    assert '<article class="research-report">' in html
    assert 'class="lead"' in html
    assert "<table>" in html and 'scope="col"' in html
    assert "<svg" in html and 'viewBox="0 0 100 50"' in html
    assert "<rect" in html and "<path" in html and "<text" in html
    assert 'href="https://example.org/source"' in html
    assert 'rel="noopener noreferrer"' in html
    assert 'target="_blank"' in html
    assert 'href="#section" rel="noopener noreferrer">Section</a>' in html
    assert "random" not in html


def test_report_strips_active_content_external_assets_and_unsafe_svg(tmp_path):
    folder = research.prepare_workspace(settings_for(tmp_path), str(uuid4()))
    (folder / "report.html").write_text("""<article><h1>Valid findings</h1><p>Evidence here.</p>
    <script>alert(1)</script><style>p {color:red}</style><meta http-equiv="refresh" content="0">
    <form action="https://evil.test"><input value="bad"></form><iframe src="https://evil.test"></iframe>
    <img src="https://evil.test/pixel" onerror="evil()"><a href="javascript:evil()">Bad</a>
    <a href="data:text/html,evil">Data</a><a href="//evil.test">Protocol relative</a>
    <div style="background:url(https://evil.test)">Keep text</div>
    <svg onload="evil()"><foreignObject><iframe src="https://evil.test"></iframe></foreignObject>
    <image href="https://evil.test/x"/><use href="https://evil.test/a.svg#x"/>
    <rect width="10" height="20" fill="url(https://evil.test/x)"/>
    <animate attributeName="href" values="javascript:evil()"/></svg></article>""")
    html = research.read_report(folder)
    assert "Valid findings" in html and "Keep text" in html
    for forbidden in (
        "evil",
        "<script",
        "<style",
        "<meta",
        "<form",
        "<iframe",
        "onload",
        "onerror",
        "foreignObject",
        "<image",
        "<use",
        "<animate",
        "style=",
        "javascript:",
        "data:",
    ):
        assert forbidden not in html


@pytest.mark.parametrize(
    "content", ["", "   ", "plain text", "<script>not findings</script>", "<p> </p>", "<svg></svg>"]
)
def test_report_rejects_empty_or_non_html_result(tmp_path, content):
    folder = research.prepare_workspace(settings_for(tmp_path), str(uuid4()))
    (folder / "report.html").write_text(content)
    with pytest.raises(ValueError):
        research.read_report(folder)


def test_report_rejects_missing_oversized_and_symlink_files(tmp_path):
    folder = research.prepare_workspace(settings_for(tmp_path), str(uuid4()))
    with pytest.raises(ValueError):
        research.read_report(folder)
    report = folder / "report.html"
    report.write_bytes(b"x" * (research.MAX_REPORT_BYTES + 1))
    with pytest.raises(ValueError):
        research.read_report(folder)
    report.unlink()
    outside = tmp_path / "outside.html"
    outside.write_text("<p>Outside report</p>")
    report.symlink_to(outside)
    with pytest.raises(ValueError):
        research.read_report(folder)


def test_verbosity_controls_detail_without_cutting_requested_scope():
    for verbosity in ("concise", "standard", "in_depth"):
        prompt = research.research_prompt("task-1", "List all matching people", verbosity)
        assert "List all matching people" in prompt
        assert "complete requested scope" in prompt
        assert "report.html" in prompt
        assert verbosity in prompt
    concise = research.research_prompt("task-1", "List everyone", "concise")
    assert "minimal elaboration" in concise
    assert "word limit" not in concise.lower()
    assert "page limit" not in concise.lower()
