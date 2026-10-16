package com.jarvis.wearfactory

import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfirmScreenTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun modelsDefaultToAuto() {
        rule.setContent {
            ConfirmScreen(
                modifier = Modifier,
                transcript = "Ship it",
                creating = false,
                error = null,
                onCancel = {},
                onConfirm = {},
            )
        }
        rule.onNodeWithText("Model override · Auto if none").assertIsDisplayed()
        rule.onNodeWithText("GPT-5.6 Sol").assertIsDisplayed().assertIsNotSelected()
        rule.onNodeWithText("Opus 5").assertIsDisplayed().assertIsNotSelected()
        rule.onNodeWithText("Fable 5").assertIsDisplayed().assertIsNotSelected()
    }

    @Test
    fun selectingAModelAndTappingItAgainClearsTheOverride() {
        rule.setContent {
            ConfirmScreen(
                modifier = Modifier,
                transcript = "Ship it",
                creating = false,
                error = null,
                onCancel = {},
                onConfirm = {},
            )
        }
        rule.onNodeWithText("Fable 5").performClick().assertIsSelected()
        rule.onNodeWithText("Opus 5").performClick().assertIsSelected()
        rule.onNodeWithText("Fable 5").assertIsNotSelected()
        rule.onNodeWithText("Opus 5").performClick().assertIsNotSelected()
    }
}
