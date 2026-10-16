from __future__ import annotations

import asyncio
from pathlib import Path

SELF_UPDATE_PREFIXES = (
    "services/code-factory/",
    "deploy/macmini/",
)


async def git_output(repository: Path, *args: str) -> str:
    process = await asyncio.create_subprocess_exec(
        "/usr/bin/git",
        "-C",
        str(repository),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        raise RuntimeError(stderr.decode(errors="replace").strip())
    return stdout.decode(errors="replace").strip()


async def revision(repository: Path) -> str:
    return await git_output(repository, "rev-parse", "HEAD")


async def changed_paths(repository: Path, before: str, after: str) -> list[str]:
    committed = await git_output(repository, "diff", "--name-only", f"{before}..{after}")
    working = await git_output(repository, "status", "--porcelain")
    paths = {line for line in committed.splitlines() if line}
    for line in working.splitlines():
        if len(line) >= 4:
            paths.add(line[3:].split(" -> ")[-1])
    return sorted(paths)


def _jarvis_relative(path: str) -> str:
    if path.startswith("jarvis/"):
        return path[len("jarvis/") :]
    return path


def affects_code_factory(paths: list[str]) -> bool:
    return any(_jarvis_relative(path).startswith(SELF_UPDATE_PREFIXES) for path in paths)
