package com.jarvis.wearfactory.api

import com.jarvis.wearfactory.task.FactoryMode
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CodeFactoryWearApiTest {
    @Test
    fun `createTask sends the default Sol model`() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(202)
                .setBody(
                    """{"id":"task-sol","prompt":"Ship it","status":"queued","created_at":"2026-08-15T00:00:00Z"}""",
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
                        model = "gpt-6-sol",
                    )
                }

            val body = JSONObject(server.takeRequest().body.readUtf8())
            assertEquals("Ship it", body.getString("prompt"))
            assertEquals("gpt-6-sol", body.getString("model"))
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
                      "model": "gpt-6-astra",
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
                        model = "gpt-6-astra",
                    )
                }

            val recorded = server.takeRequest()
            assertEquals("/v1/code-tasks", recorded.path)
            assertEquals("Bearer access-token", recorded.getHeader("Authorization"))
            val body = JSONObject(recorded.body.readUtf8())
            assertEquals("Ship it", body.getString("prompt"))
            assertEquals("gpt-6-astra", body.getString("model"))

            assertTrue(result is CodeFactoryWearApi.Result.Success)
            val task = (result as CodeFactoryWearApi.Result.Success).value
            assertEquals("gpt-6-astra", task.model)
        } finally {
            server.shutdown()
        }
    }
}

class TaskHistoryApiTest {
    private val task = """{"id":"task-1","prompt":"Ship it","status":"running","model":null,"error":null,"stdout":null,"created_at":"2026-09-27T00:00:00Z"}"""
    private val output = """{"items":[{"seq":4,"kind":"assistant","text":"Inspecting tests","created_at":"2026-09-27T00:00:00Z"}],"next_after":4,"has_more":false,"truncated":true,"task":$task}"""

    @Test
    fun `history pagination encodes opaque cursors and preserves next page`() = withServer { server ->
        server.enqueue(MockResponse().setBody("""{"items":[$task],"next_cursor":"older/+=="}"""))
        val result = runBlocking { CodeFactoryWearApi().listTasks(server.url("/").toString(), "token", "cursor/+==", "history") }
        val request = server.takeRequest()
        assertEquals("cursor/+==", request.requestUrl!!.queryParameter("cursor"))
        assertEquals("history", request.requestUrl!!.queryParameter("view"))
        assertEquals("20", request.requestUrl!!.queryParameter("limit"))
        val page = (result as CodeFactoryWearApi.Result.Success).value
        assertEquals("older/+==", page.nextCursor)
        assertEquals(null, page.items.single().model)
        assertEquals(null, page.items.single().stdout)
    }

    @Test
    fun `output returns incremental cursor and task status`() = withServer { server ->
        server.enqueue(MockResponse().setBody(output))
        val result = runBlocking { CodeFactoryWearApi().getOutput(server.url("/").toString(), "token", "task-1", 3) }
        assertEquals("3", server.takeRequest().requestUrl!!.queryParameter("after"))
        val page = (result as CodeFactoryWearApi.Result.Success).value
        assertEquals(4, page.nextAfter)
        assertEquals("Inspecting tests", page.items.single().text)
        assertEquals("running", page.task.status)
        assertTrue(page.truncated)
    }

    @Test
    fun `SSE accepts comments and output frames and resumes from cursor`() = withServer { server ->
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": heartbeat\n\nevent: output\nid: 4\ndata: $output\n\n"))
        val received = mutableListOf<CodeFactoryWearApi.Result<CodeFactoryWearApi.OutputPage>>()
        runBlocking {
            CodeFactoryWearApi().streamOutput(server.url("/").toString(), "token", "task-1", 3).collect { received += it }
        }
        val request = server.takeRequest()
        assertEquals("3", request.requestUrl!!.queryParameter("after"))
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals("Bearer token", request.getHeader("Authorization"))
        assertEquals(4, (received.single() as CodeFactoryWearApi.Result.Success).value.nextAfter)
    }

    @Test
    fun `follow-up sends separate prompt and selected model`() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(202).setBody(task))
        runBlocking { CodeFactoryWearApi().followUp(server.url("/").toString(), "token", "parent-1", "Also add tests", "gpt-6-sol") }
        val request = server.takeRequest()
        assertEquals("/v1/code-tasks/parent-1/follow-up", request.path)
        val body = JSONObject(request.body.readUtf8())
        assertEquals("Also add tests", body.getString("prompt"))
        assertEquals("gpt-6-sol", body.getString("model"))
    }

    @Test
    fun `cancel uses authenticated post and reports server failure`() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"detail":"Task already finished"}"""))
        val result = runBlocking { CodeFactoryWearApi().cancelTask(server.url("/").toString(), "token", "task-1") }
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/code-tasks/task-1/cancel", request.path)
        assertEquals("Task already finished", (result as CodeFactoryWearApi.Result.Failure).message)
    }

    private fun withServer(block: (MockWebServer) -> Unit) {
        val server = MockWebServer()
        server.start()
        try { block(server) } finally { server.shutdown() }
    }
}

class ResearchApiTest {
    private val task = """{"id":"research-1","prompt":"Compare storage","model":"gpt-6-astra","status":"succeeded","created_at":"2026-10-15T00:00:00Z","task_type":"research","verbosity":"in_depth","report_available":true}"""

    @Test
    fun `research creation sends chosen verbosity model prompt and authorization`() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(202).setBody(task))
        val result = runBlocking {
            CodeFactoryWearApi().createTask(server.url("/").toString(), "token", "Compare storage", "gpt-6-astra", FactoryMode.RESEARCH, "in_depth")
        }
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/research-tasks", request.path)
        assertEquals("Bearer token", request.getHeader("Authorization"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals("Compare storage", body.getString("prompt"))
        assertEquals("gpt-6-astra", body.getString("model"))
        assertEquals("in_depth", body.getString("verbosity"))
        val created = (result as CodeFactoryWearApi.Result.Success).value
        assertEquals("research", created.taskType)
        assertEquals("in_depth", created.verbosity)
        assertTrue(created.reportAvailable)
    }

    @Test
    fun `research creation defaults to standard verbosity without changing code payloads`() = withServer { server ->
        server.enqueue(MockResponse().setBody(task))
        server.enqueue(MockResponse().setBody("""{"id":"code-1","status":"queued","created_at":"now"}"""))
        val api = CodeFactoryWearApi()
        runBlocking { api.createTask(server.url("/").toString(), "token", "Research", "gpt-6-sol", FactoryMode.RESEARCH) }
        assertEquals("standard", JSONObject(server.takeRequest().body.readUtf8()).getString("verbosity"))
        val code = runBlocking { api.createTask(server.url("/").toString(), "token", "Code", "gpt-6-sol") }
        val request = server.takeRequest()
        assertEquals("/v1/code-tasks", request.path)
        assertFalse(JSONObject(request.body.readUtf8()).has("verbosity"))
        val created = (code as CodeFactoryWearApi.Result.Success).value
        assertEquals("code", created.taskType)
        assertEquals(null, created.verbosity)
        assertFalse(created.reportAvailable)
    }

    @Test
    fun `research list uses its own route and encoded pagination while parsing metadata`() = withServer { server ->
        server.enqueue(MockResponse().setBody("""{"items":[$task],"next_cursor":"next/+="}"""))
        val result = runBlocking { CodeFactoryWearApi().listTasks(server.url("/").toString(), "token", "cursor/+==", "history", FactoryMode.RESEARCH) }
        val request = server.takeRequest()
        assertEquals("/v1/research-tasks", request.requestUrl!!.encodedPath)
        assertEquals("cursor/+==", request.requestUrl!!.queryParameter("cursor"))
        assertEquals("20", request.requestUrl!!.queryParameter("limit"))
        assertEquals("history", request.requestUrl!!.queryParameter("view"))
        assertEquals("Bearer token", request.getHeader("Authorization"))
        val page = (result as CodeFactoryWearApi.Result.Success).value
        assertEquals("next/+=", page.nextCursor)
        assertEquals("research", page.items.single().taskType)
        assertTrue(page.items.single().reportAvailable)
    }

    @Test
    fun `research detail cancellation and activity stay on research routes`() = withServer { server ->
        server.enqueue(MockResponse().setBody(task))
        server.enqueue(MockResponse().setBody(task))
        server.enqueue(MockResponse().setBody("""{"items":[{"seq":17,"kind":"assistant","text":"Checking sources"}],"next_after":17,"has_more":true,"truncated":false,"task":$task}"""))
        val api = CodeFactoryWearApi()
        val baseUrl = server.url("/").toString()
        val detail = runBlocking { api.getTask(baseUrl, "token", "research-1", FactoryMode.RESEARCH) }
        val detailRequest = server.takeRequest()
        assertEquals("/v1/research-tasks/research-1", detailRequest.path)
        assertEquals("Bearer token", detailRequest.getHeader("Authorization"))
        assertEquals("in_depth", (detail as CodeFactoryWearApi.Result.Success).value.verbosity)
        runBlocking { api.cancelTask(baseUrl, "token", "research-1", FactoryMode.RESEARCH) }
        val cancel = server.takeRequest()
        assertEquals("/v1/research-tasks/research-1/cancel", cancel.path)
        assertEquals("POST", cancel.method)
        assertEquals("Bearer token", cancel.getHeader("Authorization"))
        val activity = runBlocking { api.getOutput(baseUrl, "token", "research-1", 12, FactoryMode.RESEARCH) }
        val outputRequest = server.takeRequest()
        assertEquals("/v1/research-tasks/research-1/output", outputRequest.requestUrl!!.encodedPath)
        assertEquals("12", outputRequest.requestUrl!!.queryParameter("after"))
        assertEquals("100", outputRequest.requestUrl!!.queryParameter("limit"))
        assertEquals("Bearer token", outputRequest.getHeader("Authorization"))
        val page = (activity as CodeFactoryWearApi.Result.Success).value
        assertEquals(17, page.nextAfter)
        assertEquals("Checking sources", page.items.single().text)
        assertEquals("research", page.task.taskType)
        assertTrue(page.hasMore)
    }

    @Test
    fun `report retrieves complete html from authenticated report endpoint`() = withServer { server ->
        val html = "<article><h1>A &amp; B</h1><p>" + "Evidence. ".repeat(1000) + "</p></article>"
        server.enqueue(MockResponse().setBody(JSONObject().put("task_id", "research-1").put("html", html).toString()))
        val result = runBlocking { CodeFactoryWearApi().getReport(server.url("/").toString(), "token", "research-1") }
        assertTrue(result is CodeFactoryWearApi.Result.Success)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/research-tasks/research-1/report", request.path)
        assertEquals("Bearer token", request.getHeader("Authorization"))
        val report = (result as CodeFactoryWearApi.Result.Success).value
        assertEquals("research-1", report.taskId)
        assertEquals(html, report.html)
    }

    @Test
    fun `report failure and malformed payload remain failures rather than empty reports`() = withServer { server ->
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"detail":"Report not available"}"""))
        server.enqueue(MockResponse().setBody("""{"task_id":"research-1"}"""))
        val api = CodeFactoryWearApi()
        val unavailable = runBlocking { api.getReport(server.url("/").toString(), "token", "research-1") }
        assertEquals(404, (unavailable as CodeFactoryWearApi.Result.Failure).status)
        assertEquals("Report not available", unavailable.message)
        val malformed = runBlocking { api.getReport(server.url("/").toString(), "token", "research-1") }
        assertTrue(malformed is CodeFactoryWearApi.Result.Failure)
    }

    private fun withServer(block: (MockWebServer) -> Unit) {
        val server = MockWebServer()
        server.start()
        try { block(server) } finally { server.shutdown() }
    }
}
