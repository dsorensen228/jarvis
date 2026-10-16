package com.jarvis.wearfactory.api

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeFactoryWearApiTest {
    @Test
    fun `createTask omits model when auto is selected`() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(202)
                .setBody(
                    """{"id":"task-auto","prompt":"Ship it","status":"queued","created_at":"2026-08-15T00:00:00Z"}""",
                ),
        )
        server.start()
        try {
            val result =
                runBlocking {
                    CodeFactoryWearApi().createTask(
                        baseUrl = server.url("/").toString(),
                        accessToken = "access-token",
                        prompt = "Ship it",
                        model = null,
                    )
                }

            val body = JSONObject(server.takeRequest().body.readUtf8())
            assertEquals("Ship it", body.getString("prompt"))
            assertTrue(!body.has("model"))
            assertTrue(result is CodeFactoryWearApi.Result.Success)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `createTask posts the prompt and selected model`() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(202)
                .setBody(
                    """
                    {
                      "id": "task-1",
                      "prompt": "Ship it",
                      "model": "claude-fable-5-thinking-high",
                      "status": "queued",
                      "created_at": "2026-08-15T00:00:00Z"
                    }
                    """.trimIndent(),
                ),
        )
        server.start()
        try {
            val api = CodeFactoryWearApi()
            val result =
                runBlocking {
                    api.createTask(
                        baseUrl = server.url("/").toString(),
                        accessToken = "access-token",
                        prompt = "Ship it",
                        model = "claude-fable-5-thinking-high",
                    )
                }

            val recorded = server.takeRequest()
            assertEquals("/v1/code-tasks", recorded.path)
            assertEquals("Bearer access-token", recorded.getHeader("Authorization"))
            val body = JSONObject(recorded.body.readUtf8())
            assertEquals("Ship it", body.getString("prompt"))
            assertEquals("claude-fable-5-thinking-high", body.getString("model"))

            assertTrue(result is CodeFactoryWearApi.Result.Success)
            val task = (result as CodeFactoryWearApi.Result.Success).value
            assertEquals("claude-fable-5-thinking-high", task.model)
        } finally {
            server.shutdown()
        }
    }
}
