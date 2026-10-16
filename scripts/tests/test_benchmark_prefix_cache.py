"""Check streaming benchmark measurements without a model or production data."""

import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "benchmark_prefix_cache", Path(__file__).parents[1] / "benchmark-prefix-cache.py"
)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


def event(payload):
    return b"data: " + json.dumps(payload).encode() + b"\n"


class PrefixCacheBenchmarkTest(unittest.TestCase):
    def test_ttft_ignores_role_event_and_retains_final_chunk_metrics(self):
        lines = [
            event({"choices": [{"delta": {"role": "assistant", "content": ""}}]}),
            event({"choices": [{"delta": {"reasoning_content": "Consider"}}]}),
            event(
                {
                    "choices": [{"delta": {}, "finish_reason": "length"}],
                    "timings": {"cache_n": 800, "prompt_n": 20, "prompt_ms": 100},
                }
            ),
            event({"choices": [], "usage": {"prompt_tokens": 820, "completion_tokens": 8}}),
            b"data: [DONE]\n",
        ]
        with patch.object(benchmark.time, "perf_counter", side_effect=[10.25, 10.5]):
            row = benchmark.consume_sse(lines, 10)
        self.assertEqual(row["ttft_ms"], 250)
        self.assertEqual(row["elapsed_ms"], 500)
        self.assertEqual(row["timings"]["cache_n"], 800)
        self.assertEqual(row["usage"]["prompt_tokens"], 820)

    def test_tool_metadata_is_not_a_token_but_name_or_arguments_are(self):
        self.assertIsNone(
            benchmark.first_delta_kind(
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [{"id": "call-1", "type": "function", "function": {}}]
                            }
                        }
                    ]
                }
            )
        )
        self.assertEqual(
            benchmark.first_delta_kind(
                {"choices": [{"delta": {"tool_calls": [{"function": {"name": "create_todo"}}]}}]}
            ),
            "tool_calls",
        )

    def test_truncated_stream_is_not_reported_as_complete(self):
        with self.assertRaisesRegex(RuntimeError, "without \\[DONE\\]"):
            benchmark.consume_sse([], 10)

    def test_output_limit_without_parsed_delta_keeps_ttft_unknown(self):
        lines = [event({"choices": [{"delta": {}, "finish_reason": "length"}]}), b"data: [DONE]\n"]
        with patch.object(benchmark.time, "perf_counter", return_value=10.5):
            row = benchmark.consume_sse(lines, 10)
        self.assertIsNone(row["ttft_ms"])


if __name__ == "__main__":
    unittest.main()
