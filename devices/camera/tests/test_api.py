from __future__ import annotations

import socket

from jarvis_camera.api import registration_url


def test_registration_url_resolves_mdns_name_to_ipv4() -> None:
    calls = []

    def resolver(host, port, family, sock_type):
        calls.append((host, port, family, sock_type))
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.34", port))]

    assert (
        registration_url("http://camera-two.local:8089", resolver) == "http://192.0.2.34:8089"
    )
    assert calls == [("camera-two.local", 8089, socket.AF_INET, socket.SOCK_STREAM)]


def test_registration_url_keeps_non_mdns_address() -> None:
    def unexpected_resolver(*args):
        raise AssertionError(f"resolver unexpectedly called with {args}")

    assert (
        registration_url("http://192.0.2.34:8089", unexpected_resolver)
        == "http://192.0.2.34:8089"
    )
