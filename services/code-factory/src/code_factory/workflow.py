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
        if request.parent_task_id:
            # Waiting inside run_coding_task would occupy the only worker slot and
            # deadlock a queued parent. Short checks release it; the durable timer
            # keeps a follow-up ordered even after worker restarts or queue reordering.
            while not await workflow.execute_activity(
                "parent_task_finished",
                request.parent_task_id,
                start_to_close_timeout=timedelta(seconds=15),
            ):
                await workflow.sleep(timedelta(seconds=2))
        await workflow.execute_activity(
            "run_coding_task",
            request,
            start_to_close_timeout=timedelta(hours=24),
            heartbeat_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )
