from __future__ import annotations

from jarvis_voice.browser import BrowserController


def test_browser_controller_only_closes_external_pages():
    controller = object.__new__(BrowserController)
    controller._ui_origin = "http://127.0.0.1:8765"
    assert controller._is_external_page(
        {"id": "external", "type": "page", "url": "https://www.patreon.com"}
    )
    assert not controller._is_external_page(
        {"id": "ui", "type": "page", "url": "http://127.0.0.1:8765/standby"}
    )
    assert not controller._is_external_page(
        {"id": "worker", "type": "service_worker", "url": "https://example.com/sw.js"}
    )
