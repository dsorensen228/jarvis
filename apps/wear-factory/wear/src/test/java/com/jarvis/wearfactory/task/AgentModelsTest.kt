package com.jarvis.wearfactory.task

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentModelsTest {
    @Test
    fun `choices match the code factory model slugs`() {
        assertEquals(
            listOf(
                "gpt-5.6-sol-medium",
                "claude-opus-5-thinking-high",
                "claude-fable-5-thinking-high",
            ),
            AgentModels.CHOICES.map { it.id },
        )
    }

    @Test
    fun `labels resolve for known models and fall back to the slug`() {
        assertEquals("Opus 5", AgentModels.label("claude-opus-5-thinking-high"))
        assertEquals("Fable 5", AgentModels.label("claude-fable-5-thinking-high"))
        assertEquals("GPT-5.6 Sol", AgentModels.label("gpt-5.6-sol-medium"))
        assertEquals("some-new-model", AgentModels.label("some-new-model"))
        assertNull(AgentModels.label(null))
        assertNull(AgentModels.label(""))
    }
}
