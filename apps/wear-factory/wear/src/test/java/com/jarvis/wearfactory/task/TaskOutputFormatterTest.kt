package com.jarvis.wearfactory.task

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskOutputFormatterTest {
    @Test
    fun extractsResultStringFromAgentJson() {
        val text =
            TaskOutputFormatter.display(
                agentOutputJson = """{"result":"Shipped the lights.","duration_ms":12}""",
                error = "ignored",
                stdout = "ignored",
                stderr = null,
                finished = true,
            )
        assertEquals("Shipped the lights.", text)
    }

    @Test
    fun fallsBackToErrorWhenAgentOutputMissing() {
        val text =
            TaskOutputFormatter.display(
                agentOutputJson = null,
                error = "agent exited with status 1",
                stdout = "plain",
                stderr = null,
                finished = true,
            )
        assertEquals("agent exited with status 1", text)
    }

    @Test
    fun omitsOutputUntilTheTaskFinishes() {
        val text =
            TaskOutputFormatter.display(
                agentOutputJson = """{"result":"secret"}""",
                error = null,
                stdout = "running",
                stderr = null,
                finished = false,
            )
        assertEquals("", text)
    }

    @Test
    fun compactJsonIsStillLegibleWhenResultIsAbsent() {
        val text =
            TaskOutputFormatter.display(
                agentOutputJson = """{"ok":true,"files":["a.kt"]}""",
                error = null,
                stdout = null,
                stderr = null,
                finished = true,
            )
        assertTrue(text.contains("ok"))
        assertTrue(text.contains("a.kt"))
    }
}

class TranscriptBufferTest {
    @Test
    fun prefersLongerContinuationOfTheSameUtterance() {
        assertEquals("add a health check", TranscriptBuffer.merge("add a", "add a health check"))
    }

    @Test
    fun appendsANewChunkAfterSilenceRestart() {
        assertEquals(
            "add a health check then deploy",
            TranscriptBuffer.merge("add a health check", "then deploy"),
        )
    }
}
