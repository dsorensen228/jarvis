package com.jarvis.wearfactory.task

data class AgentModel(val id: String, val label: String)

/** Codex CLI model IDs selectable when creating a Code Factory task. */
object AgentModels {
    const val DEFAULT = "gpt-6-sol"
    val CHOICES =
        listOf(
            AgentModel("gpt-5.6-terra", "Terra"),
            AgentModel("gpt-6-sol", "Sol"),
            AgentModel("gpt-6-astra", "Astra"),
        )

    fun label(id: String?): String? {
        if (id.isNullOrBlank()) return null
        return CHOICES.firstOrNull { it.id == id }?.label ?: id
    }
}
