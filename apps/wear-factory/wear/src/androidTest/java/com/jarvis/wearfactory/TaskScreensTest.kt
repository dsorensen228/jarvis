package com.jarvis.wearfactory

import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.jarvis.wearfactory.api.CodeFactoryWearApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TaskScreensTest {
    @get:Rule val rule = createComposeRule()

    private fun task(status: String = "running") = CodeFactoryWearApi.CodeTask(
        "task-1", "Improve task history", "gpt-6-sol", status, "2026-09-27T10:00:00Z",
        if (status == "success") """{"result":"Added cursor pagination and tested it."}""" else null,
        null, null, null, emptyList(),
    )

    @Test
    fun activeEmptyStateOffersFilterAndRefresh() {
        var refreshed = false
        var selectedView = ""
        rule.setContent {
            TaskListScreen(Modifier, emptyList(), false, false, false, null, "active",
                onView = { selectedView = it }, onRefresh = { refreshed = true }, onLoadMore = {}, onCreate = {}, onOpen = {})
        }
        rule.onNodeWithText("No active tasks").assertIsDisplayed()
        rule.onNodeWithText("History").performClick()
        assertEquals("history", selectedView)
        rule.onNodeWithText("Refresh").performScrollTo().performClick()
        assertTrue(refreshed)
    }

    @Test
    fun liveOutputIsVisibleBeforeCompletionAndStopRequiresIntent() {
        var cancelled = false
        rule.setContent {
            DetailScreen(Modifier, task(), listOf(CodeFactoryWearApi.OutputEvent(1, "assistant", "Checking the pagination tests")),
                "Live", false, null, false, onRetry = {}, onFollowUp = {}, onCancel = { cancelled = true }, onBack = {})
        }
        rule.onNodeWithText("Queue follow-up").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Stop task").performScrollTo().performClick()
        assertEquals(false, cancelled)
        rule.onNodeWithContentDescription("Confirm stop task").performScrollTo().performClick()
        assertTrue(cancelled)
        rule.onNodeWithText("Checking the pagination tests").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun reachingTheEndLoadsTheNextPage() {
        var requested = 0
        rule.setContent {
            TaskListScreen(Modifier, (1..20).map { task().copy(id = "task-$it", prompt = "Task $it") }, false, false, true, null, "all",
                onView = {}, onRefresh = {}, onLoadMore = { requested++ }, onCreate = {}, onOpen = {})
        }
        assertEquals(0, requested)
        rule.onNode(hasScrollAction()).performScrollToIndex(21)
        rule.waitUntil { requested > 0 }
        assertEquals(1, requested)
    }

    @Test
    fun completedTaskShowsResultAndContinuation() {
        rule.setContent {
            DetailScreen(Modifier, task("success"), emptyList(), "Updated", false, null, false,
                onRetry = {}, onFollowUp = {}, onCancel = {}, onBack = {})
        }
        rule.onNodeWithText("Continue task").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Added cursor pagination and tested it.").performScrollTo().assertIsDisplayed()
    }
}
