#!/usr/bin/env python3
"""Recover sustained LAN loss or a confirmed offline ngrok endpoint, without rebooting."""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Optional
from urllib.parse import urlsplit


STATE_PATH = Path("/run/jarvis-network-watchdog/state.json")
DEFAULT_PUBLIC_URL = "https://jarvis-api.example.com/health/live"
FAILURE_THRESHOLD = 3
COOLDOWN_SECONDS = 300
PUBLIC_PROBE_INTERVAL_SECONDS = 600
PUBLIC_RETRY_INTERVAL_SECONDS = 30


@dataclass(frozen=True)
class Config:
    interface: str
    connection_uuid: str
    public_health_url: str

    @classmethod
    def from_env(cls):
        interface = os.environ.get("JARVIS_WIFI_INTERFACE", "wlan0")
        connection_uuid = os.environ.get("JARVIS_WIFI_CONNECTION_UUID", "")
        public_url = os.environ.get("JARVIS_PUBLIC_HEALTH_URL", DEFAULT_PUBLIC_URL)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,14}", interface):
            raise ValueError("invalid_wifi_interface")
        if not re.fullmatch(
            r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
            connection_uuid,
        ):
            raise ValueError("missing_or_invalid_wifi_connection_uuid")
        if public_url:
            parsed = urlsplit(public_url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise ValueError("invalid_public_health_url")
        return cls(interface, connection_uuid, public_url)


@dataclass
class State:
    wifi_failures: int = 0
    tunnel_failures: int = 0
    wifi_attempt_at: Optional[float] = None
    tunnel_attempt_at: Optional[float] = None
    tunnel_checked_at: Optional[float] = None
    # Probe cadence is independent of confirmed evidence needed for a restart.
    # Old state files also get a prompt health check after upgrading the watchdog.
    tunnel_retry_pending: bool = True


def load_state(path):
    try:
        payload = json.loads(path.read_text())
        state = State(**payload)
        if type(state.tunnel_retry_pending) is not bool:
            raise ValueError("invalid public probe retry state")
        for count in (state.wifi_failures, state.tunnel_failures):
            if type(count) is not int or not 0 <= count <= FAILURE_THRESHOLD:
                raise ValueError("invalid failure count")
        for stamp in (
            state.wifi_attempt_at,
            state.tunnel_attempt_at,
            state.tunnel_checked_at,
        ):
            if stamp is not None and (
                type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp < 0
            ):
                raise ValueError("invalid action timestamp")
        return state
    except FileNotFoundError:
        return State()
    except (TypeError, ValueError):
        # A damaged state file must not trigger an immediate recovery action.
        return State()


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(vars(state), sort_keys=True) + "\n")
    temporary.replace(path)


def run_command(command, timeout):
    return subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
        text=True,
    )


def gateway_status(interface):
    try:
        route = run_command(
            ["ip", "-j", "-4", "route", "show", "default", "dev", interface],
            5,
        )
        if route.returncode:
            return "route_probe_failed"
        routes = json.loads(route.stdout)
        gateways = [entry["gateway"] for entry in routes if entry.get("gateway")]
        if not gateways:
            return "missing_gateway"
        gateway = str(ipaddress.IPv4Address(gateways[0]))
        ping = run_command(
            ["ping", "-n", "-I", interface, "-c", "2", "-W", "2", gateway], 6
        )
        return "reachable" if ping.returncode == 0 else "unreachable"
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return "gateway_probe_failed"


def http_status(url):
    # A subprocess timeout also bounds DNS resolution, unlike urllib's socket timeout.
    # Ignore curlrc/proxies so a local liveness check cannot become a WAN check.
    try:
        result = run_command(
            [
                "curl",
                "-q",
                "--noproxy",
                "*",
                "--silent",
                "--connect-timeout",
                "3",
                "--max-time",
                "6",
                "--max-filesize",
                "32768",
                "--header",
                "ngrok-skip-browser-warning: 1",
                "--write-out",
                "\n%{http_code}",
                url,
            ],
            8,
        )
        if result.returncode:
            return None, b""
        body, status = result.stdout.rsplit("\n", 1)
        return int(status), body.encode("utf-8")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None, b""


def diagnose(
    config,
    tunnel_checked_at=None,
    now=None,
    force_public=False,
    tunnel_failures=0,
    tunnel_retry_pending=False,
):
    result = {
        "gateway": gateway_status(config.interface),
        "api": "not_checked",
        "tunnel": "not_checked",
    }
    if result["gateway"] != "reachable":
        return result
    status, _ = http_status("http://127.0.0.1:8000/health/live")
    result["api"] = "live" if status == 200 else "unavailable"
    if result["api"] != "live" or not config.public_health_url:
        return result
    if (
        not force_public
        and tunnel_checked_at is not None
        and now is not None
        and now - tunnel_checked_at
        < (
            PUBLIC_RETRY_INTERVAL_SECONDS
            if tunnel_failures or tunnel_retry_pending
            else PUBLIC_PROBE_INTERVAL_SECONDS
        )
    ):
        result["tunnel"] = "not_due"
        return result
    status, body = http_status(config.public_health_url)
    if status == 404 and b"ERR_NGROK_3200" in body:
        result["tunnel"] = "ngrok_offline"
    elif status == 200:
        result["tunnel"] = "live"
    else:
        result["tunnel"] = "unconfirmed_failure"
    return result


def plan(state, diagnosis, now):
    state = State(**vars(state))
    state.wifi_failures = (
        min(FAILURE_THRESHOLD, state.wifi_failures + 1)
        if diagnosis["gateway"] in {"missing_gateway", "unreachable"}
        else 0
    )
    if diagnosis["gateway"] != "reachable" or diagnosis["api"] != "live":
        state.tunnel_failures = 0
        state.tunnel_retry_pending = True
        # LAN/local API recovery invalidates the previous public liveness check.
        # Verify the public endpoint on the first healthy local cycle.
        state.tunnel_checked_at = None
    elif diagnosis["tunnel"] == "ngrok_offline":
        state.tunnel_failures = min(FAILURE_THRESHOLD, state.tunnel_failures + 1)
    elif diagnosis["tunnel"] != "not_due":
        state.tunnel_failures = 0
    if diagnosis["tunnel"] in {"ngrok_offline", "live", "unconfirmed_failure"}:
        state.tunnel_checked_at = now
        state.tunnel_retry_pending = diagnosis["tunnel"] != "live"
    for name in ("wifi", "tunnel"):
        attempt_at = getattr(state, name + "_attempt_at")
        elapsed = now - attempt_at if attempt_at is not None else COOLDOWN_SECONDS
        if (
            getattr(state, name + "_failures") >= FAILURE_THRESHOLD
            and elapsed >= COOLDOWN_SECONDS
            and (name != "tunnel" or diagnosis["tunnel"] == "ngrok_offline")
        ):
            setattr(state, name + "_attempt_at", now)
            return state, "reconnect_wifi" if name == "wifi" else "restart_ngrok"
    return state, "none"


def recover(config, action):
    if action == "reconnect_wifi":
        command = [
            "nmcli",
            "--wait",
            "25",
            "connection",
            "up",
            "uuid",
            config.connection_uuid,
            "ifname",
            config.interface,
        ]
        timeout = 30
    elif action == "restart_ngrok":
        command = ["systemctl", "--no-block", "restart", "jarvis-ngrok.service"]
        timeout = 5
    else:
        return "not_requested"
    try:
        return (
            "requested" if run_command(command, timeout).returncode == 0 else "failed"
        )
    except (OSError, subprocess.TimeoutExpired):
        return "failed"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="diagnose without recovery or state writes"
    )
    args = parser.parse_args(argv)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "check": args.check,
        "action": "none",
    }
    try:
        config = Config.from_env()
        state = load_state(STATE_PATH)
        now = time.monotonic()
        diagnosis = diagnose(
            config,
            tunnel_checked_at=state.tunnel_checked_at,
            now=now,
            force_public=args.check,
            tunnel_failures=state.tunnel_failures,
            tunnel_retry_pending=state.tunnel_retry_pending,
        )
        record.update(diagnosis)
        updated, action = plan(state, diagnosis, now)
        record.update(
            {
                "wifi_failures": updated.wifi_failures,
                "tunnel_failures": updated.tunnel_failures,
                "tunnel_retry_pending": updated.tunnel_retry_pending,
            }
        )
        if args.check:
            record["would_act"] = action
        else:
            # Persist the cooldown before acting so an interrupted run cannot flap Wi-Fi.
            save_state(STATE_PATH, updated)
            record["action"] = action
            if action != "none":
                record["result"] = recover(config, action)
    except ValueError:
        record["error"] = "invalid_configuration"
        print(json.dumps(record, sort_keys=True), flush=True)
        return 1
    except OSError:
        record["error"] = "state_io_failed"
        print(json.dumps(record, sort_keys=True), flush=True)
        return 1
    print(json.dumps(record, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
