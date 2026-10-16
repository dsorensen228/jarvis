"""Run with python3 -m unittest discover -s deploy/jetson/tests."""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "network_watchdog",
    Path(__file__).resolve().parents[1] / "network-watchdog.py",
)
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)

UUID = "12345678-abcd-1234-abcd-123456789012"
CONFIG = watchdog.Config("wlan0", UUID, watchdog.DEFAULT_PUBLIC_URL)


def diagnosis(gateway="reachable", api="live", tunnel="live"):
    return {"gateway": gateway, "api": api, "tunnel": tunnel}


class RecoveryPolicyTests(unittest.TestCase):
    def test_three_gateway_failures_reconnect_and_wait_for_cooldown(self):
        state = watchdog.State()
        for now in (100, 130):
            state, action = watchdog.plan(
                state, diagnosis("unreachable", "not_checked", "not_checked"), now
            )
            self.assertEqual(action, "none")
        state, action = watchdog.plan(
            state, diagnosis("unreachable", "not_checked", "not_checked"), 160
        )
        self.assertEqual(action, "reconnect_wifi")
        self.assertEqual(state.wifi_attempt_at, 160)
        for now in (190, 220, 250, 459):
            state, action = watchdog.plan(
                state, diagnosis("unreachable", "not_checked", "not_checked"), now
            )
            self.assertEqual(action, "none")
        _, action = watchdog.plan(
            state, diagnosis("unreachable", "not_checked", "not_checked"), 460
        )
        self.assertEqual(action, "reconnect_wifi")

    def test_missing_gateway_recovers_disconnected_link(self):
        _, action = watchdog.plan(
            watchdog.State(wifi_failures=2),
            diagnosis("missing_gateway", "not_checked", "not_checked"),
            100,
        )
        self.assertEqual(action, "reconnect_wifi")

    def test_intermittent_failure_resets_counter(self):
        state = watchdog.State(wifi_failures=2)
        state, action = watchdog.plan(state, diagnosis(), 100)
        self.assertEqual((state.wifi_failures, action), (0, "none"))
        _, action = watchdog.plan(
            state, diagnosis("unreachable", "not_checked", "not_checked"), 130
        )
        self.assertEqual(action, "none")

    def test_broken_probe_does_not_reset_wifi(self):
        for failure in ("route_probe_failed", "gateway_probe_failed"):
            _, action = watchdog.plan(
                watchdog.State(wifi_failures=2),
                diagnosis(failure, "not_checked", "not_checked"),
                100,
            )
            self.assertEqual(action, "none")

    def test_wan_failure_never_resets_wifi_or_restarts_tunnel(self):
        state = watchdog.State()
        for now in range(0, 600, 30):
            state, action = watchdog.plan(
                state, diagnosis(tunnel="unconfirmed_failure"), now
            )
            self.assertEqual(action, "none")
        self.assertEqual(state.wifi_failures, 0)

    def test_confirmed_ngrok_offline_requires_three_and_has_separate_cooldown(self):
        state = watchdog.State()
        for now in (100, 130, 160):
            state, action = watchdog.plan(state, diagnosis(tunnel="ngrok_offline"), now)
            self.assertEqual(action, "restart_ngrok" if now == 160 else "none")
        for now in (190, 220, 250, 459):
            state, action = watchdog.plan(state, diagnosis(tunnel="ngrok_offline"), now)
            self.assertEqual(action, "none")
        _, action = watchdog.plan(state, diagnosis(tunnel="ngrok_offline"), 460)
        self.assertEqual(action, "restart_ngrok")

    def test_unconfirmed_tunnel_failure_resets_offline_counter(self):
        state, action = watchdog.plan(
            watchdog.State(tunnel_failures=2),
            diagnosis(tunnel="unconfirmed_failure"),
            100,
        )
        self.assertEqual((state.tunnel_failures, action), (0, "none"))

    def test_gateway_or_api_failure_resets_tunnel_confirmation(self):
        for observed in (
            diagnosis("unreachable", "not_checked", "not_checked"),
            diagnosis(api="unavailable", tunnel="not_checked"),
        ):
            state, action = watchdog.plan(
                watchdog.State(tunnel_failures=2, tunnel_checked_at=100), observed, 110
            )
            self.assertEqual((state.tunnel_failures, action), (0, "none"))

    def test_skipped_public_probe_cannot_repeat_previous_recovery(self):
        state, action = watchdog.plan(
            watchdog.State(tunnel_failures=3, tunnel_attempt_at=100),
            diagnosis(tunnel="not_due"),
            400,
        )
        self.assertEqual((state.tunnel_failures, action), (3, "none"))


class ProbeTests(unittest.TestCase):
    def test_healthy_public_endpoint_is_probed_only_every_ten_minutes(self):
        state = watchdog.State()
        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", return_value=(200, b"ok")) as http:
            for now in range(0, 600, 30):
                observed = watchdog.diagnose(
                    CONFIG,
                    state.tunnel_checked_at,
                    now,
                    tunnel_failures=state.tunnel_failures,
                )
                state, action = watchdog.plan(state, observed, now)
                self.assertEqual(action, "none")
                self.assertEqual(observed["tunnel"], "live" if now == 0 else "not_due")
            self.assertEqual(
                http.call_count, 21
            )  # 20 local probes plus one public probe.
            observed = watchdog.diagnose(CONFIG, state.tunnel_checked_at, 600)
            self.assertEqual(observed["tunnel"], "live")
            self.assertEqual(http.call_count, 23)

    def test_offline_confirmation_retries_quickly_and_survives_skipped_probes(self):
        state = watchdog.State()

        def response(url):
            return (
                (200, b"ok")
                if url.startswith("http://127.0.0.1")
                else (404, b"ERR_NGROK_3200")
            )

        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", side_effect=response) as http:
            for now, count in ((0, 1), (10, 1), (30, 2), (40, 2), (60, 3)):
                observed = watchdog.diagnose(
                    CONFIG,
                    state.tunnel_checked_at,
                    now,
                    tunnel_failures=state.tunnel_failures,
                )
                state, action = watchdog.plan(state, observed, now)
                self.assertEqual(state.tunnel_failures, count)
                self.assertEqual(action, "restart_ngrok" if now == 60 else "none")
            self.assertEqual(
                http.call_count, 8
            )  # Five local probes, three confirmed public probes.

    def test_lan_outage_probes_on_recovery_and_reconfirms_before_restart(self):
        state, action = watchdog.plan(
            watchdog.State(tunnel_failures=2, tunnel_checked_at=100),
            diagnosis("unreachable", "not_checked", "not_checked"),
            110,
        )
        self.assertEqual(action, "none")
        self.assertEqual(state.tunnel_failures, 0)
        self.assertIsNone(state.tunnel_checked_at)
        self.assertTrue(state.tunnel_retry_pending)

        def response(url):
            return (
                (200, b"ok")
                if url.startswith("http://127.0.0.1")
                else (404, b"ERR_NGROK_3200")
            )

        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", side_effect=response) as http:
            for now, count in ((120, 1), (130, 1), (150, 2), (180, 3)):
                observed = watchdog.diagnose(
                    CONFIG,
                    state.tunnel_checked_at,
                    now,
                    tunnel_failures=state.tunnel_failures,
                    tunnel_retry_pending=state.tunnel_retry_pending,
                )
                state, action = watchdog.plan(state, observed, now)
                self.assertEqual(state.tunnel_failures, count)
                self.assertEqual(action, "restart_ngrok" if now == 180 else "none")
            public_calls = [
                call for call in http.call_args_list
                if call.args[0] == CONFIG.public_health_url
            ]
            self.assertEqual(len(public_calls), 3)

    def test_local_outage_invalidates_a_recent_healthy_public_check(self):
        for failure in (
            diagnosis("unreachable", "not_checked", "not_checked"),
            diagnosis(api="unavailable", tunnel="not_checked"),
        ):
            with self.subTest(failure=failure):
                state, action = watchdog.plan(
                    watchdog.State(
                        tunnel_checked_at=100, tunnel_retry_pending=False
                    ),
                    failure,
                    110,
                )
                self.assertIsNone(state.tunnel_checked_at)
                self.assertTrue(state.tunnel_retry_pending)
                with patch.object(
                    watchdog, "gateway_status", return_value="reachable"
                ), patch.object(
                    watchdog, "http_status", return_value=(200, b"ok")
                ) as http:
                    observed = watchdog.diagnose(
                        CONFIG,
                        state.tunnel_checked_at,
                        120,
                        tunnel_retry_pending=state.tunnel_retry_pending,
                    )
                self.assertEqual(observed["tunnel"], "live")
                self.assertEqual(http.call_count, 2)
                state, action = watchdog.plan(state, observed, 120)
                self.assertFalse(state.tunnel_retry_pending)
                self.assertEqual(action, "none")

    def test_uncertain_public_probes_retry_every_thirty_seconds_until_live(self):
        state = watchdog.State()
        public_response = (None, b"")
        public_probe_times = []

        def response(url):
            if url.startswith("http://127.0.0.1"):
                return 200, b"ok"
            public_probe_times.append(now)
            return public_response

        with tempfile.TemporaryDirectory() as directory, patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", side_effect=response):
            path = Path(directory) / "state.json"
            for now, expected in (
                (0, "unconfirmed_failure"),
                (10, "not_due"),
                (30, "unconfirmed_failure"),
                (59, "not_due"),
                (60, "unconfirmed_failure"),
                (90, "unconfirmed_failure"),
                (120, "live"),
                (150, "not_due"),
                (719, "not_due"),
                (720, "live"),
            ):
                if now == 60:
                    public_response = (404, b'{"detail":"Not found"}')
                elif now == 90:
                    public_response = (502, b"Bad gateway")
                elif now >= 120:
                    public_response = (200, b"ok")
                observed = watchdog.diagnose(
                    CONFIG,
                    state.tunnel_checked_at,
                    now,
                    tunnel_failures=state.tunnel_failures,
                    tunnel_retry_pending=state.tunnel_retry_pending,
                )
                self.assertEqual(observed["tunnel"], expected)
                state, action = watchdog.plan(state, observed, now)
                self.assertEqual(action, "none")
                self.assertEqual(state.tunnel_failures, 0)
                self.assertEqual(state.tunnel_retry_pending, now < 120)
                # The systemd timer starts a fresh process each cycle.
                watchdog.save_state(path, state)
                state = watchdog.load_state(path)
        self.assertEqual(public_probe_times, [0, 30, 60, 90, 120, 720])

    def test_retry_state_never_bypasses_tunnel_restart_cooldown(self):
        state = watchdog.State(tunnel_attempt_at=100, tunnel_failures=2)
        for now in (130, 160, 190, 399, 400):
            state, action = watchdog.plan(
                state, diagnosis(tunnel="ngrok_offline"), now
            )
            self.assertTrue(state.tunnel_retry_pending)
            self.assertEqual(action, "restart_ngrok" if now == 400 else "none")

    def test_manual_check_forces_public_probe_before_next_scheduled_check(self):
        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", return_value=(200, b"ok")) as http:
            observed = watchdog.diagnose(CONFIG, 100, 110, force_public=True)
            self.assertEqual(observed["tunnel"], "live")
            self.assertEqual(http.call_count, 2)

    def test_gateway_is_discovered_dynamically_and_ping_is_interface_bound(self):
        results = [
            subprocess.CompletedProcess([], 0, '[{"gateway":"192.168.7.1"}]'),
            subprocess.CompletedProcess([], 0, ""),
        ]
        with patch.object(watchdog, "run_command", side_effect=results) as run:
            self.assertEqual(watchdog.gateway_status("wlan0"), "reachable")
        self.assertEqual(
            run.call_args_list[0].args[0],
            ["ip", "-j", "-4", "route", "show", "default", "dev", "wlan0"],
        )
        self.assertEqual(
            run.call_args_list[1].args[0],
            ["ping", "-n", "-I", "wlan0", "-c", "2", "-W", "2", "192.168.7.1"],
        )

    def test_missing_default_route_is_detected(self):
        with patch.object(
            watchdog,
            "run_command",
            return_value=subprocess.CompletedProcess([], 0, "[]"),
        ):
            self.assertEqual(watchdog.gateway_status("wlan0"), "missing_gateway")

    def test_no_external_probe_when_gateway_or_api_unhealthy(self):
        with patch.object(
            watchdog, "gateway_status", return_value="unreachable"
        ), patch.object(watchdog, "http_status") as http:
            self.assertEqual(watchdog.diagnose(CONFIG)["api"], "not_checked")
            http.assert_not_called()
        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", return_value=(503, b"")) as http:
            self.assertEqual(watchdog.diagnose(CONFIG)["tunnel"], "not_checked")
            http.assert_called_once_with("http://127.0.0.1:8000/health/live")

    def test_only_specific_offline_404_allows_tunnel_recovery(self):
        for status, body, expected in (
            (404, b"ERR_NGROK_3200", "ngrok_offline"),
            (404, b'{"detail":"Not found"}', "unconfirmed_failure"),
            (502, b"ERR_NGROK_3200", "unconfirmed_failure"),
            (None, b"", "unconfirmed_failure"),
            (200, b"ok", "live"),
        ):
            with self.subTest(status=status, body=body), patch.object(
                watchdog, "gateway_status", return_value="reachable"
            ), patch.object(
                watchdog, "http_status", side_effect=[(200, b""), (status, body)]
            ):
                self.assertEqual(watchdog.diagnose(CONFIG)["tunnel"], expected)

    def test_http_reads_error_body_and_disables_proxies(self):
        response = subprocess.CompletedProcess([], 0, "ERR_NGROK_3200\n404")
        with patch.object(watchdog, "run_command", return_value=response) as run:
            self.assertEqual(
                watchdog.http_status(CONFIG.public_health_url), (404, b"ERR_NGROK_3200")
            )
            command, timeout = run.call_args.args
            self.assertEqual(command[:5], ["curl", "-q", "--noproxy", "*", "--silent"])
            self.assertEqual(timeout, 8)

    def test_http_network_failure_is_inconclusive(self):
        with patch.object(
            watchdog,
            "run_command",
            return_value=subprocess.CompletedProcess([], 6, "\n000"),
        ):
            self.assertEqual(
                watchdog.http_status(CONFIG.public_health_url), (None, b"")
            )
        with patch.object(
            watchdog, "run_command", side_effect=subprocess.TimeoutExpired("curl", 8)
        ):
            self.assertEqual(
                watchdog.http_status(CONFIG.public_health_url), (None, b"")
            )


class ExecutionTests(unittest.TestCase):
    def test_wifi_recovery_only_reactivates_configured_connection(self):
        with patch.object(
            watchdog, "run_command", return_value=subprocess.CompletedProcess([], 0)
        ) as run:
            self.assertEqual(watchdog.recover(CONFIG, "reconnect_wifi"), "requested")
        run.assert_called_once_with(
            [
                "nmcli",
                "--wait",
                "25",
                "connection",
                "up",
                "uuid",
                UUID,
                "ifname",
                "wlan0",
            ],
            30,
        )

    def test_tunnel_recovery_only_restarts_ngrok(self):
        with patch.object(
            watchdog, "run_command", return_value=subprocess.CompletedProcess([], 0)
        ) as run:
            watchdog.recover(CONFIG, "restart_ngrok")
        run.assert_called_once_with(
            ["systemctl", "--no-block", "restart", "jarvis-ngrok.service"], 5
        )

    def test_recovery_failure_still_gets_cooldown(self):
        state, action = watchdog.plan(
            watchdog.State(wifi_failures=2),
            diagnosis("unreachable", "not_checked", "not_checked"),
            100,
        )
        with patch.object(
            watchdog, "run_command", side_effect=subprocess.TimeoutExpired("nmcli", 30)
        ):
            self.assertEqual(watchdog.recover(CONFIG, action), "failed")
        self.assertEqual(state.wifi_attempt_at, 100)

    def test_check_never_writes_state_or_recovers(self):
        with patch.object(
            watchdog.Config, "from_env", return_value=CONFIG
        ), patch.object(
            watchdog, "load_state", return_value=watchdog.State(wifi_failures=2)
        ), patch.object(
            watchdog,
            "diagnose",
            return_value=diagnosis("unreachable", "not_checked", "not_checked"),
        ) as probe, patch.object(watchdog, "save_state") as save, patch.object(
            watchdog, "recover"
        ) as recover, patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(watchdog.main(["--check"]), 0)
        save.assert_not_called()
        recover.assert_not_called()
        self.assertTrue(probe.call_args.kwargs["force_public"])
        record = json.loads(output.getvalue())
        self.assertEqual(
            (record["action"], record["would_act"]), ("none", "reconnect_wifi")
        )

    def test_state_persisted_before_recovery(self):
        ordering = []
        with patch.object(
            watchdog.Config, "from_env", return_value=CONFIG
        ), patch.object(
            watchdog, "load_state", return_value=watchdog.State(wifi_failures=2)
        ), patch.object(
            watchdog,
            "diagnose",
            return_value=diagnosis("unreachable", "not_checked", "not_checked"),
        ), patch.object(
            watchdog, "save_state", side_effect=lambda *args: ordering.append("save")
        ), patch.object(
            watchdog, "recover", side_effect=lambda *args: ordering.append("recover")
        ), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(watchdog.main([]), 0)
        self.assertEqual(ordering, ["save", "recover"])

    def test_invalid_configuration_prevents_all_probes(self):
        for interface, uuid in (("wlan0", ""), ("; reboot", UUID), ("wlan0", "--help")):
            with patch.dict(
                os.environ,
                {
                    "JARVIS_WIFI_INTERFACE": interface,
                    "JARVIS_WIFI_CONNECTION_UUID": uuid,
                },
                clear=True,
            ), patch.object(watchdog, "diagnose") as probe, patch(
                "sys.stdout", new_callable=io.StringIO
            ):
                self.assertEqual(watchdog.main([]), 1)
                probe.assert_not_called()

    def test_config_defaults_and_public_probe_can_be_disabled(self):
        with patch.dict(os.environ, {"JARVIS_WIFI_CONNECTION_UUID": UUID}, clear=True):
            self.assertEqual(watchdog.Config.from_env(), CONFIG)
        with patch.dict(
            os.environ,
            {"JARVIS_WIFI_CONNECTION_UUID": UUID, "JARVIS_PUBLIC_HEALTH_URL": ""},
            clear=True,
        ):
            config = watchdog.Config.from_env()
        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", return_value=(200, b"")) as http:
            self.assertEqual(watchdog.diagnose(config)["tunnel"], "not_checked")
            self.assertEqual(http.call_count, 1)

    def test_saved_retry_state_is_passed_to_the_next_diagnosis(self):
        state = watchdog.State(tunnel_checked_at=100, tunnel_retry_pending=True)
        with patch.object(
            watchdog.Config, "from_env", return_value=CONFIG
        ), patch.object(watchdog, "load_state", return_value=state), patch.object(
            watchdog, "diagnose", return_value=diagnosis(tunnel="not_due")
        ) as probe, patch.object(watchdog, "save_state"), patch.object(
            watchdog, "recover"
        ) as recover, patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(watchdog.main([]), 0)
        self.assertTrue(probe.call_args.kwargs["tunnel_retry_pending"])
        recover.assert_not_called()

    def test_legacy_state_gets_prompt_public_verification_after_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text('{"tunnel_checked_at": 100, "tunnel_failures": 0}')
            state = watchdog.load_state(path)
        self.assertTrue(state.tunnel_retry_pending)
        with patch.object(
            watchdog, "gateway_status", return_value="reachable"
        ), patch.object(watchdog, "http_status", return_value=(200, b"ok")) as http:
            observed = watchdog.diagnose(
                CONFIG,
                state.tunnel_checked_at,
                130,
                tunnel_retry_pending=state.tunnel_retry_pending,
            )
        self.assertEqual(observed["tunnel"], "live")
        self.assertEqual(http.call_count, 2)

    def test_state_roundtrip_and_corrupt_state_starts_at_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            self.assertEqual(watchdog.load_state(path), watchdog.State())
            state = watchdog.State(wifi_failures=2, tunnel_attempt_at=100)
            watchdog.save_state(path, state)
            self.assertEqual(watchdog.load_state(path), state)
            for content in (
                "broken",
                '{"wifi_failures": -1}',
                '{"wifi_attempt_at": "bad"}',
                '{"tunnel_retry_pending": 1}',
                '{"tunnel_retry_pending": "false"}',
                "[]",
            ):
                path.write_text(content)
                self.assertEqual(watchdog.load_state(path), watchdog.State())


if __name__ == "__main__":
    unittest.main()
