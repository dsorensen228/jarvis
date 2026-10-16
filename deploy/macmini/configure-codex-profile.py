"""Provision the factory's MCP profile without changing desktop settings or credentials."""

import json
import os
import tomllib
from pathlib import Path


def provision(codex_home: Path) -> Path:
    profile = codex_home / "code-factory.config.toml"
    if profile.exists():
        servers = tomllib.loads(profile.read_text()).get("mcp_servers", {})
        if "mobile-mcp" not in servers:
            raise ValueError(f"{profile} must configure mobile-mcp")
        return profile

    config = tomllib.loads((codex_home / "config.toml").read_text())
    servers = config.get("mcp_servers", {})
    mobile = servers.get("mobile-mcp", {})
    if not mobile.get("command"):
        raise ValueError("Register the existing mobile-mcp command with codex mcp add first")

    # JSON strings/arrays are valid TOML for these transport fields. Copy only the
    # configured transport, retaining credentials locally and out of build output.
    lines = [
        'mcp_oauth_credentials_store = "file"',
        "",
        "[mcp_servers.mobile-mcp]",
        'default_tools_approval_mode = "approve"',
    ]
    for field in ("command", "args", "cwd", "env_vars"):
        if field in mobile:
            lines.append(f"{field} = {json.dumps(mobile[field])}")
    if mobile.get("env"):
        lines.append("[mcp_servers.mobile-mcp.env]")
        for key, value in mobile["env"].items():
            lines.append(f"{json.dumps(key)} = {json.dumps(value)}")
    lines.append("")
    text = "\n".join(lines)
    tomllib.loads(text)
    with open(profile, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
        out.write(text)
    return profile


if __name__ == "__main__":
    print(provision(Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()))
