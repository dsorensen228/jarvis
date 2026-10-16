package com.jarvis.wearjarvis.api

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class JarvisWearApiTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `chat requests event stream and returns final text and audio`() = runBlocking {
        server.enqueue(
            stream(
                "event: response.text.delta\ndata: {\"text\":\"Hello\"}\n\n" +
                    "event: response.completed\ndata: {\"conversation_id\":\"conversation-1\",\"response\":\"Hello.\"}\n\n" +
                    "event: response.audio\ndata: {\"audio_base64\":\"AQIDBA==\",\"audio_encoding\":\"pcm_s16le\",\"sample_rate\":16000}\n\n" +
                    "event: turn.done\ndata: {}\n\n",
            ),
        )

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null)

        assertTrue("Expected a successful stream, got $result", result is JarvisWearApi.Result.Success)
        val response = (result as JarvisWearApi.Result.Success).value
        assertEquals("Hello.", response.text)
        assertEquals("conversation-1", response.conversationId)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), response.pcm)
        assertEquals(16000, response.sampleRate)
        assertEquals("pcm_s16le", response.encoding)
        val request = server.takeRequest()
        assertEquals("/v1/wear/chat", request.path)
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals("Bearer access", request.getHeader("Authorization"))
    }

    @Test
    fun `text arrives before the remaining network response`() = runBlocking {
        val firstFrame = "event: response.text.delta\ndata: {\"text\":\"Hello\"}\n\n"
        // Delay the second network chunk, while sending a complete first event immediately.
        val firstChunk = firstFrame + ":" + " ".repeat(512 - firstFrame.length - 3) + "\n\n"
        server.enqueue(
            stream(
                firstChunk +
                    "event: response.completed\ndata: {\"conversation_id\":\"c1\",\"response\":\"Hello!\"}\n\n" +
                    "event: response.audio\ndata: {\"audio_base64\":\"AQI=\",\"audio_encoding\":\"pcm_s16le\",\"sample_rate\":24000}\n\n" +
                    "event: turn.done\ndata: {}\n\n",
            ).throttleBody(512, 2, TimeUnit.SECONDS),
        )
        val firstText = CompletableDeferred<String>()
        val updates = mutableListOf<String>()
        val pending = async {
            JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", "previous") {
                updates += it
                firstText.complete(it)
            }
        }

        assertEquals("Hello", withTimeout(1500) { firstText.await() })
        assertFalse("The delayed audio response should still be in flight", pending.isCompleted)
        val result = withTimeout(4000) { pending.await() }
        assertTrue(result is JarvisWearApi.Result.Success)
        assertEquals(listOf("Hello", "Hello!"), updates)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"conversation_id\":\"previous\""))
    }

    @Test
    fun `deltas accumulate whitespace and completed text replaces draft`() = runBlocking {
        server.enqueue(
            stream(
                ": keep-alive\r\n\r\n" +
                    "event: response.text.delta\r\ndata: {\"text\":\"\"}\r\n\r\n" +
                    "event: response.text.delta\ndata: {\"text\":\"Hello\"}\n\n" +
                    "event: response.text.delta\ndata: {\"text\":\" \"}\n\n" +
                    "event: response.text.delta\ndata: {\"text\":\"world\"}\n\n" +
                    "event: response.completed\ndata: {\"conversation_id\":\"c1\",\ndata: \"response\":\"Final answer.\"}\n\n" +
                    "event: response.audio\ndata: {\"audio_base64\":\"\",\"audio_encoding\":\"pcm_s16le\",\"sample_rate\":24000}\n\n" +
                    "event: turn.done\ndata: {}\n\n",
            ),
        )
        val updates = mutableListOf<String>()

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null) {
            updates += it
        }

        assertTrue(result is JarvisWearApi.Result.Success)
        assertEquals(listOf("Hello", "Hello ", "Hello world", "Final answer."), updates)
        assertEquals("Final answer.", (result as JarvisWearApi.Result.Success).value.text)
    }

    @Test
    fun `unauthorized response preserves HTTP status for token refresh`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"detail\":\"Token expired\"}"))
        val updates = mutableListOf<String>()

        val result = JarvisWearApi().chat(server.url("/").toString(), "expired", "Hi", null) {
            updates += it
        }

        assertEquals(JarvisWearApi.Result.Failure(401, "Token expired"), result)
        assertTrue(updates.isEmpty())
    }

    @Test
    fun `stream error before completion fails and preserves displayed partial text`() = runBlocking {
        server.enqueue(
            stream(
                "event: response.text.delta\ndata: {\"text\":\"Partial\"}\n\n" +
                    "event: error\ndata: {\"message\":\"Generation failed\"}\n\n" +
                    "event: turn.done\ndata: {}\n\n",
            ),
        )
        val updates = mutableListOf<String>()

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null) {
            updates += it
        }

        assertTrue(result is JarvisWearApi.Result.Failure)
        assertEquals("Generation failed", (result as JarvisWearApi.Result.Failure).message)
        assertEquals(listOf("Partial"), updates)
    }

    @Test
    fun `speech failure preserves completed answer and conversation`() = runBlocking {
        server.enqueue(
            stream(
                "event: response.completed\ndata: {\"conversation_id\":\"c1\",\"response\":\"Answer\"}\n\n" +
                    "event: error\ndata: {\"message\":\"Speech unavailable\"}\n\n" +
                    "event: turn.done\ndata: {}\n\n",
            ),
        )

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null)

        assertTrue(result is JarvisWearApi.Result.Success)
        val response = (result as JarvisWearApi.Result.Success).value
        assertEquals("Answer", response.text)
        assertEquals("c1", response.conversationId)
        assertEquals("Speech unavailable", response.audioError)
        assertTrue(response.pcm.isEmpty())
    }

    @Test
    fun `stream without terminal event is rejected`() = runBlocking {
        server.enqueue(
            stream("event: response.completed\ndata: {\"conversation_id\":\"c1\",\"response\":\"Answer\"}\n\n"),
        )

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null)

        assertTrue(result is JarvisWearApi.Result.Failure)
        assertTrue((result as JarvisWearApi.Result.Failure).message.contains("stream", ignoreCase = true))
    }

    @Test
    fun `terminal event without completed answer is rejected`() = runBlocking {
        server.enqueue(stream("event: turn.done\ndata: {}\n\n"))

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null)

        assertTrue(result is JarvisWearApi.Result.Failure)
    }

    @Test
    fun `invalid audio fails instead of reporting playback ready`() = runBlocking {
        server.enqueue(
            stream(
                "event: response.completed\ndata: {\"conversation_id\":\"c1\",\"response\":\"Answer\"}\n\n" +
                    "event: response.audio\ndata: {\"audio_base64\":\"!invalid!\",\"audio_encoding\":\"pcm_s16le\",\"sample_rate\":24000}\n\n" +
                    "event: turn.done\ndata: {}\n\n",
            ),
        )

        val result = JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null)

        assertTrue(result is JarvisWearApi.Result.Failure)
    }

    @Test
    fun `cancellation before headers cancels OkHttp call`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val client = cancellationClient(started, cancelled)
        val pending = async {
            JarvisWearApi(client).chat(server.url("/").toString(), "access", "Hi", null)
        }
        withTimeout(2000) { started.await() }

        withTimeout(2000) { pending.cancelAndJoin() }

        withTimeout(2000) { cancelled.await() }
        assertTrue(pending.isCancelled)
    }

    @Test
    fun `cancellation while reading stream cancels OkHttp call`() = runBlocking {
        val firstFrame = "event: response.text.delta\ndata: {\"text\":\"Hello\"}\n\n"
        server.enqueue(
            stream(firstFrame + "event: turn.done\ndata: {}\n\n")
                .throttleBody(firstFrame.length.toLong(), 3, TimeUnit.SECONDS),
        )
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val textReceived = CompletableDeferred<Unit>()
        val client = cancellationClient(started, cancelled)
        val pending = async {
            JarvisWearApi(client).chat(server.url("/").toString(), "access", "Hi", null) {
                textReceived.complete(Unit)
            }
        }
        withTimeout(2000) { textReceived.await() }

        withTimeout(2000) { pending.cancelAndJoin() }

        withTimeout(2000) { cancelled.await() }
        assertTrue(pending.isCancelled)
    }

    @Test
    fun `cancellation from text callback is propagated`() = runBlocking {
        server.enqueue(stream("event: response.text.delta\ndata: {\"text\":\"Hello\"}\n\n"))
        var cancelled = false

        try {
            JarvisWearApi().chat(server.url("/").toString(), "access", "Hi", null) {
                throw CancellationException("Screen closed")
            }
        } catch (_: CancellationException) {
            cancelled = true
        }

        assertTrue("Cancellation must not be converted to an API failure", cancelled)
    }

    @Test
    fun `login and refresh keep their JSON token contracts`() = runBlocking {
        repeat(2) {
            server.enqueue(MockResponse().setBody("{\"access_token\":\"new-access\",\"refresh_token\":\"new-refresh\"}"))
        }
        val api = JarvisWearApi()

        val login = api.loginWithGoogle(server.url("/").toString(), "google-token")
        val refresh = api.refresh(server.url("/").toString(), "old-refresh")

        val expected = JarvisWearApi.Result.Success(JarvisWearApi.Tokens("new-access", "new-refresh"))
        assertEquals(expected, login)
        assertEquals(expected, refresh)
        val loginRequest = server.takeRequest()
        assertEquals("/v1/auth/google", loginRequest.path)
        assertEquals("{\"google_id_token\":\"google-token\"}", loginRequest.body.readUtf8())
        val refreshRequest = server.takeRequest()
        assertEquals("/v1/auth/refresh", refreshRequest.path)
        assertEquals("{\"refresh_token\":\"old-refresh\"}", refreshRequest.body.readUtf8())
    }

    private fun cancellationClient(
        started: CompletableDeferred<Unit>,
        cancelled: CompletableDeferred<Unit>,
    ): OkHttpClient =
        OkHttpClient.Builder().eventListener(
            object : EventListener() {
                override fun requestBodyEnd(call: Call, byteCount: Long) {
                    started.complete(Unit)
                }

                override fun canceled(call: Call) {
                    cancelled.complete(Unit)
                }
            },
        ).build()

    private fun stream(body: String): MockResponse =
        MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)
}
