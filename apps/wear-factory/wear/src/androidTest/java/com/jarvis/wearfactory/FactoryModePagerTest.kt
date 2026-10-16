package com.jarvis.wearfactory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.wear.compose.foundation.BasicSwipeToDismissBox
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.jarvis.wearfactory.task.FactoryMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FactoryModePagerTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun horizontalGesturesSwitchBetweenCodeAndResearchTaskLists() {
        val activeModes = mutableMapOf<FactoryMode, Boolean>()
        setPagerContent(activeModes)

        rule.onNodeWithText("Code tasks").assertIsDisplayed()
        assertActiveMode(activeModes, FactoryMode.CODE)
        swipeToResearch()

        rule.onNodeWithText("Research tasks").assertIsDisplayed()
        assertActiveMode(activeModes, FactoryMode.RESEARCH)
        swipeToCode()

        rule.onNodeWithText("Code tasks").assertIsDisplayed()
        assertActiveMode(activeModes, FactoryMode.CODE)
    }

    @Test
    fun eachModeRetainsItsIndependentFilterWhenReturningToTheList() {
        setPagerContent()

        rule.onNodeWithText("Code filter: All").performClick()
        rule.onNodeWithText("Code filter: Active").assertIsDisplayed()
        swipeToResearch()

        rule.onNodeWithText("Research filter: All").performClick()
        rule.onNodeWithText("Research filter: History").assertIsDisplayed()
        swipeToCode()

        rule.onNodeWithText("Code filter: Active").assertIsDisplayed()
        swipeToResearch()
        rule.onNodeWithText("Research filter: History").assertIsDisplayed()
    }

    @Test
    fun childScreenDisablesModePagingUntilReturningToTasks() {
        val activeModes = mutableMapOf<FactoryMode, Boolean>()
        setPagerContent(activeModes)

        rule.onNodeWithText("Code filter: All").performClick()
        rule.onNodeWithText("Open Code task").performClick()
        rule.onNodeWithText("Code detail").assertIsDisplayed()
        swipeToResearch()
        rule.onNodeWithText("Code detail").assertIsDisplayed()
        assertActiveMode(activeModes, FactoryMode.CODE)

        rule.onNodeWithText("Back to Code tasks").performClick()
        rule.onNodeWithText("Code tasks").assertIsDisplayed()
        rule.onNodeWithText("Code filter: Active").assertIsDisplayed()
        assertActiveMode(activeModes, FactoryMode.CODE)
        swipeToResearch()
        assertRenderedLabel("Research tasks")

        rule.onNodeWithText("Research filter: All").performClick()
        rule.onNodeWithText("Open Research task").performClick()
        swipeToResearch()
        rule.onNodeWithText("Research detail").assertIsDisplayed()
        swipeToCode()
        // A child swipe returns to its own list; it must not switch to the other factory.
        rule.onNodeWithText("Research tasks").assertIsDisplayed()
        rule.onNodeWithText("Research filter: History").assertIsDisplayed()
        assertActiveMode(activeModes, FactoryMode.RESEARCH)

        swipeToCode()
        assertRenderedLabel("Code tasks")
        rule.onNodeWithText("Code filter: Active").assertIsDisplayed()
    }

    private fun setPagerContent(activeModes: MutableMap<FactoryMode, Boolean> = mutableMapOf()) {
        rule.setContent {
            MaterialTheme {
                FactoryModePager(Modifier.testTag("factory-pager")) { mode, isActive, setAtRoot ->
                    var filter by remember { mutableStateOf("All") }
                    var inDetail by remember { mutableStateOf(false) }
                    val label = if (mode == FactoryMode.CODE) "Code" else "Research"
                    SideEffect {
                        setAtRoot(!inDetail)
                        activeModes[mode] = isActive
                    }
                    // Match production: each navigation screen receives a fresh dismiss state.
                    key(inDetail) {
                        BasicSwipeToDismissBox(
                            onDismissed = { inDetail = false },
                            userSwipeEnabled = inDetail && isActive,
                        ) { isBackground ->
                            if (!isBackground) {
                                Column(
                                    modifier = Modifier.fillMaxSize(),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.Center,
                                ) {
                                    Text(if (inDetail) "$label detail" else "$label tasks")
                                    if (inDetail) {
                                        Text(
                                            "Back to $label tasks",
                                            modifier = Modifier.clickable { inDetail = false }.padding(8.dp),
                                        )
                                    } else {
                                        Text(
                                            "$label filter: $filter",
                                            modifier = Modifier.clickable {
                                                filter = if (mode == FactoryMode.CODE) "Active" else "History"
                                            }.padding(8.dp),
                                        )
                                        Text(
                                            "Open $label task",
                                            modifier = Modifier.clickable { inDetail = true }.padding(8.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun swipeToResearch() {
        rule.onNodeWithTag("factory-pager").performTouchInput {
            swipe(
                start = Offset(width * 0.82f, height * 0.5f),
                end = Offset(width * 0.20f, height * 0.5f),
                durationMillis = 400,
            )
        }
        rule.waitForIdle()
    }

    private fun swipeToCode() {
        rule.onNodeWithTag("factory-pager").performTouchInput {
            // Start inside the content, clear of Wear's reserved left edge for dismissing apps.
            swipe(
                start = Offset(width * 0.20f, height * 0.5f),
                end = Offset(width * 0.82f, height * 0.5f),
                durationMillis = 400,
            )
        }
        rule.waitForIdle()
    }

    private fun assertActiveMode(activeModes: Map<FactoryMode, Boolean>, expected: FactoryMode) {
        rule.runOnIdle {
            assertEquals(true, activeModes[expected])
            assertEquals(false, activeModes[if (expected == FactoryMode.CODE) FactoryMode.RESEARCH else FactoryMode.CODE])
        }
    }

    private fun assertRenderedLabel(text: String) {
        val label = rule.onNodeWithText(text).assertIsDisplayed()
        // A stale transition layer can leave semantics onscreen while painting only black.
        val pixels = label.captureToImage().toPixelMap()
        var visibleTextPixels = 0
        for (y in 0 until pixels.height) {
            for (x in 0 until pixels.width) {
                val pixel = pixels[x, y]
                if (pixel.alpha > 0.5f && pixel.red + pixel.green + pixel.blue > 1.5f) {
                    visibleTextPixels++
                }
            }
        }
        assertTrue("$text must actually render after leaving a child screen", visibleTextPixels >= 10)
    }
}
