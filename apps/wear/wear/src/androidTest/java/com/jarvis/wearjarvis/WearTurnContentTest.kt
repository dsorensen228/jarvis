package com.jarvis.wearjarvis

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.test.platform.app.InstrumentationRegistry
import androidx.wear.compose.material3.MaterialTheme
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertTrue
import java.io.File

class WearTurnContentTest {
    @get:Rule val compose = createComposeRule()

    @Test fun listeningThenThinkingIsReplacedByFirstStreamedText() {
        val listening = mutableStateOf(true)
        val sending = mutableStateOf(false)
        val reply = mutableStateOf("")
        compose.setContent {
            MaterialTheme {
                Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
                    WearTurnContent(listening.value, sending.value, reply.value, {}, {})
                }
            }
        }
        compose.onNodeWithContentDescription("Listening").assertIsDisplayed()
        capture("listening")
        compose.runOnIdle { listening.value = false; sending.value = true }
        compose.onNodeWithContentDescription("Thinking").assertIsDisplayed()
        compose.onNodeWithText("Asking Jarvis…").assertDoesNotExist()
        capture("thinking")
        compose.runOnIdle { reply.value = "The lights" }
        compose.onNodeWithText("The lights").assertIsDisplayed()
        compose.onNodeWithContentDescription("Thinking").assertDoesNotExist()
        compose.runOnIdle { reply.value = "The lights are on."; sending.value = false }
        compose.onNodeWithText("The lights are on.").assertIsDisplayed()
        capture("reply")
    }

    @Test fun longPressRemainsAvailableWhileReplyStreams() {
        var signedOut = false
        compose.setContent {
            MaterialTheme {
                WearTurnContent(false, true, "The lights", {}, { signedOut = true })
            }
        }
        compose.onNodeWithText("The lights").performTouchInput { longClick() }
        compose.runOnIdle { assertTrue(signedOut) }
    }

    private fun capture(phase: String) {
        val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        File(cache, "wear-flow-$phase.png").outputStream().use { output ->
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, output)
        }
    }
}
