package com.jarvis.wearfactory

import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.jarvis.wearfactory.api.CodeFactoryWearApi
import com.jarvis.wearfactory.task.FactoryMode
import com.jarvis.wearfactory.task.ResearchReportParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ResearchScreensTest {
    @get:Rule val rule = createComposeRule()

    @Test fun researchCreationIncludesModelAndDepth() {
        var submitted = ""
        rule.setContent {
            ConfirmScreen(Modifier, "Compare batteries", false, null, {}, {},
                mode = FactoryMode.RESEARCH,
                onConfirmResearch = { model, depth -> submitted = "$model/$depth" })
        }
        rule.onNodeWithText("Confirm research").assertExists()
        rule.onNode(hasScrollAction()).performScrollToIndex(9)
        rule.onNodeWithText("In depth").performScrollTo().performClick()
        rule.onNodeWithContentDescription("Create task").performScrollTo().performClick()
        assertEquals("gpt-6-sol/in_depth", submitted)
    }

    @Test fun researchDetailOpensReportWithoutCodeFollowUp() {
        var opened = false
        val task = CodeFactoryWearApi.CodeTask("r1", "Compare batteries", "gpt-6-sol", "success",
            "2026-10-15", null, null, null, null, emptyList(), taskType = "research", reportAvailable = true)
        rule.setContent {
            DetailScreen(Modifier, task, emptyList(), "Updated", false, null, false,
                {}, {}, {}, {}, onReadReport = { opened = true })
        }
        rule.onNodeWithText("Continue task").assertDoesNotExist()
        rule.onNodeWithText("Read report").performScrollTo().performClick()
        assertTrue(opened)
    }

    @Test fun reportShowsCompleteTextAndCanJumpToSections() {
        val blocks = ResearchReportParser.parse("<h1>Battery study</h1><p>First finding.</p><h2>Sources</h2><p>Verified evidence.</p>")
        rule.setContent { ResearchReportScreen(Modifier, blocks, false, null, {}, {}) }
        rule.onNodeWithText("Sections").performScrollTo().performClick()
        rule.onNodeWithText("Sources").performScrollTo().performClick()
        rule.onNodeWithText("Verified evidence.").performScrollTo().assertIsDisplayed()
    }

    @Test fun reportFailureOffersRetry() {
        var retried = false
        rule.setContent { ResearchReportScreen(Modifier, emptyList(), false, "Report unavailable", { retried = true }, {}) }
        rule.onNodeWithText("Retry report").performScrollTo().performClick()
        assertTrue(retried)
    }
}
