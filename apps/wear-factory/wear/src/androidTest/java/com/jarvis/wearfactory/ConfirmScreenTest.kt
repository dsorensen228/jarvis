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
    fun modelsDefaultToSol() {
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
        rule.onNodeWithText("Model · Required").assertIsDisplayed()
        rule.onNodeWithText("Sol").assertIsDisplayed().assertIsSelected()
        rule.onNodeWithText("Terra").assertIsDisplayed().assertIsNotSelected()
        rule.onNodeWithText("Astra").assertIsDisplayed().assertIsNotSelected()
    }

    @Test
    fun selectionCannotBeCleared() {
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
        rule.onNodeWithText("Astra").performClick().assertIsSelected()
        rule.onNodeWithText("Terra").performClick().assertIsSelected()
        rule.onNodeWithText("Astra").assertIsNotSelected()
        rule.onNodeWithText("Terra").performClick().assertIsSelected()
    }
}
