package com.jarvis.wearfactory.task

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentModelsTest {
    @Test
    fun `choices match the code factory model slugs`() {
        assertEquals(
            listOf(
                "gpt-5.6-terra",
                "gpt-6-sol",
                "gpt-6-astra",
            ),
            AgentModels.CHOICES.map { it.id },
        )
    }

    @Test
    fun `labels resolve for known models and fall back to the slug`() {
        assertEquals("Terra", AgentModels.label("gpt-5.6-terra"))
        assertEquals("Astra", AgentModels.label("gpt-6-astra"))
        assertEquals("Sol", AgentModels.label("gpt-6-sol"))
        assertEquals("some-new-model", AgentModels.label("some-new-model"))
        assertNull(AgentModels.label(null))
        assertNull(AgentModels.label(""))
    }
}
