from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from .models import TaskRunRequest


@workflow.defn
class CodingTaskWorkflow:
    @workflow.run
    async def run(self, request: TaskRunRequest) -> None:
        await workflow.execute_activity(
            "run_coding_task",
            request,
            start_to_close_timeout=timedelta(hours=24),
            heartbeat_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
