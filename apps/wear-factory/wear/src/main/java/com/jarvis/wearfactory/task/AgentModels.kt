package com.jarvis.wearfactory.task

data class AgentModel(val id: String, val label: String)

/** Agent CLI model slugs selectable when creating a Code Factory task. */
object AgentModels {
    val CHOICES =
        listOf(
            AgentModel("gpt-5.6-sol-medium", "GPT-5.6 Sol"),
            AgentModel("claude-opus-5-thinking-high", "Opus 5"),
            AgentModel("claude-fable-5-thinking-high", "Fable 5"),
        )

    fun label(id: String?): String? {
        if (id.isNullOrBlank()) return null
        return CHOICES.firstOrNull { it.id == id }?.label ?: id
    }
}
