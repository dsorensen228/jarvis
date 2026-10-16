from __future__ import annotations

from jarvis_voice.watchmode import _source, _title


def test_watchmode_prefers_subscription_on_first_preferred_service():
    picked = _source(
        [
            {"name": "Hulu", "type": "buy", "web_url": "https://hulu/buy"},
            {"name": "Hulu", "type": "sub", "web_url": "https://hulu/sub"},
            {"name": "Netflix", "type": "sub", "web_url": "https://netflix"},
        ],
        ("Hulu", "Netflix"),
    )
    assert picked["web_url"] == "https://hulu/sub"


def test_watchmode_uses_search_relevance_unless_year_is_requested():
    payload = {
        "title_results": [
            {"id": 1, "name": "The Office", "year": 2001},
            {"id": 2, "name": "The Office", "year": 2005},
        ]
    }
    assert _title(payload, "The Office")["id"] == 1
    assert _title(payload, "The Office 2005")["id"] == 2


def test_watchmode_matches_apple_tv_plus_despite_watchmode_spacing():
    # Watchmode labels the service AppleTV+ with no spaces; spoken/config names use spaces.
    picked = _source(
        [
            {
                "name": "AppleTV+ Amazon Channel",
                "type": "sub",
                "web_url": "https://amazon/appletv-channel",
            },
            {"name": "AppleTV+", "type": "sub", "web_url": "https://tv.apple.com/ted-lasso"},
        ],
        ("Apple TV Plus", "Netflix"),
    )
    assert picked["web_url"] == "https://tv.apple.com/ted-lasso"


def test_watchmode_spoken_apple_tv_resolves_to_apple_tv_plus():
    picked = _source(
        [
            {"name": "AppleTV", "type": "buy", "web_url": "https://tv.apple.com/buy"},
            {"name": "AppleTV+", "type": "sub", "web_url": "https://tv.apple.com/plus"},
        ],
        ("Apple TV",),
    )
    assert picked["web_url"] == "https://tv.apple.com/plus"


def test_watchmode_prefers_hbo_max_over_hulu_add_on_when_max_is_preferred():
    # "HBO (Via Hulu)" must not satisfy a Hulu preference ahead of real Max.
    picked = _source(
        [
            {"name": "HBO (Via Hulu)", "type": "sub", "web_url": "https://hulu/hbo"},
            {"name": "HBO Max", "type": "sub", "web_url": "https://play.max.com/house"},
            {"name": "MAX (Via Amazon Prime)", "type": "sub", "web_url": "https://amazon/max"},
        ],
        ("Netflix", "Hulu", "Max", "Prime Video"),
    )
    assert picked["web_url"] == "https://play.max.com/house"


def test_watchmode_accepts_hbo_max_and_prime_video_preferred_aliases():
    max_pick = _source(
        [{"name": "HBO Max", "type": "sub", "web_url": "https://play.max.com/barry"}],
        ("HBO Max",),
    )
    prime_pick = _source(
        [
            {"name": "Amazon Freevee", "type": "free", "web_url": "https://amazon/freevee"},
            {"name": "Prime Video", "type": "sub", "web_url": "https://amazon/prime"},
        ],
        ("Amazon Prime Video",),
    )
    assert max_pick["web_url"] == "https://play.max.com/barry"
    assert prime_pick["web_url"] == "https://amazon/prime"
