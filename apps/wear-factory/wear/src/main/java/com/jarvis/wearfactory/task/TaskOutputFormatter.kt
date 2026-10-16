package com.jarvis.wearfactory.task

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

object TaskOutputFormatter {
    private val finishedStatuses = setOf("success", "failed", "cancelled")

    fun isFinished(status: String): Boolean = status in finishedStatuses

    /** Smaller lazy-list items remain readable and scrollable on a round watch. */
    fun pages(text: String, maxLength: Int = 800): List<String> {
        require(maxLength > 0)
        val pages = mutableListOf<String>()
        var remaining = text.trim()
        while (remaining.length > maxLength) {
            val boundary = remaining.lastIndexOf('\n', maxLength).takeIf { it > maxLength / 2 }
                ?: remaining.lastIndexOf(' ', maxLength).takeIf { it > maxLength / 2 }
                ?: maxLength
            pages += remaining.take(boundary).trimEnd()
            remaining = remaining.drop(boundary).trimStart()
        }
        if (remaining.isNotEmpty()) pages += remaining
        return pages
    }

    fun display(
        agentOutputJson: String?,
        error: String?,
        stdout: String?,
        stderr: String?,
        finished: Boolean,
    ): String {
        if (!finished) return ""
        val fromAgent = extract(agentOutputJson)
        if (fromAgent.isNotBlank()) return fromAgent
        return error?.trim()?.takeIf { it.isNotEmpty() }
            ?: stdout?.trim()?.takeIf { it.isNotEmpty() }
            ?: stderr?.trim()?.takeIf { it.isNotEmpty() }
            ?: "No output."
    }

    internal fun extract(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        return try {
            when (val value = JSONTokener(raw).nextValue()) {
                JSONObject.NULL, null -> ""
                is String -> value
                is JSONObject -> {
                    val result = value.opt("result")
                    if (result is String && result.isNotBlank()) result else value.toString()
                }
                is JSONArray -> value.toString()
                else -> value.toString()
            }
        } catch (_: Exception) {
            raw.trim()
        }
    }
}

object TranscriptBuffer {
    fun merge(committed: String, incoming: String): String {
        val next = incoming.trim()
        if (next.isEmpty()) return committed
        if (committed.isEmpty()) return next
        if (next.startsWith(committed)) return next
        if (committed.endsWith(next)) return committed
        return "$committed $next"
    }
}
