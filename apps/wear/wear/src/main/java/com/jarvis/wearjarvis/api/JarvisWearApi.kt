package com.jarvis.wearjarvis.api

import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject

class JarvisWearApi(
    private val client: OkHttpClient = defaultClient(),
) {
    companion object {
        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .addInterceptor(
                Interceptor { chain ->
                    val request = chain.request()
                    val next =
                        if (request.url.host.contains("ngrok", ignoreCase = true)) {
                            request.newBuilder().header("ngrok-skip-browser-warning", "true").build()
                        } else {
                            request
                        }
                    chain.proceed(next)
                },
            )
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    data class Tokens(val accessToken: String, val refreshToken: String)

    data class ChatResponse(
        val text: String,
        val conversationId: String,
        val pcm: ByteArray,
        val sampleRate: Int,
        val encoding: String,
        val audioError: String? = null,
    )

    sealed class Result<out T> {
        data class Success<T>(val value: T) : Result<T>()
        data class Failure(val status: Int, val message: String) : Result<Nothing>()
    }

    suspend fun loginWithGoogle(baseUrl: String, googleIdToken: String): Result<Tokens> =
        postJson(
            baseUrl = baseUrl,
            path = "/v1/auth/google",
            body = JSONObject().put("google_id_token", googleIdToken),
        ) { json -> parseTokens(json) }

    suspend fun refresh(baseUrl: String, refreshToken: String): Result<Tokens> =
        postJson(
            baseUrl = baseUrl,
            path = "/v1/auth/refresh",
            body = JSONObject().put("refresh_token", refreshToken),
        ) { json -> parseTokens(json) }

    suspend fun chat(
        baseUrl: String,
        accessToken: String,
        message: String,
        conversationId: String?,
        onText: suspend (String) -> Unit = {},
    ): Result<ChatResponse> =
        post(
            baseUrl = baseUrl,
            path = "/v1/wear/chat",
            bearer = accessToken,
            accept = "text/event-stream",
            body =
                JSONObject().put("message", message).apply {
                    if (!conversationId.isNullOrBlank()) put("conversation_id", conversationId)
                },
        ) { response -> readChatStream(response, onText) }

    private suspend fun readChatStream(
        response: Response,
        onText: suspend (String) -> Unit,
    ): Result<ChatResponse> {
        val source = response.body?.source()
            ?: return Result.Failure(response.code, "Empty response stream")
        val text = StringBuilder()
        var completedText: String? = null
        var conversationId: String? = null
        var pcm = byteArrayOf()
        var sampleRate = 24000
        var encoding = "pcm_s16le"
        var audioError: String? = null
        var event = ""
        val data = StringBuilder()

        suspend fun dispatch(): Result<ChatResponse>? {
            when (event) {
                "response.text.delta" -> {
                    if (completedText == null) {
                        val delta = JSONObject(data.toString()).optString("text", "")
                        if (delta.isNotEmpty()) {
                            text.append(delta)
                            if (text.isNotBlank()) onText(text.toString())
                        }
                    }
                }
                "response.completed" -> {
                    val json = JSONObject(data.toString())
                    val finalText = json.getString("response")
                    conversationId = json.getString("conversation_id").also {
                        require(it.isNotBlank()) { "Missing conversation ID in response stream" }
                    }
                    completedText = finalText
                    if (finalText != text.toString()) onText(finalText)
                }
                "response.audio" -> {
                    val json = JSONObject(data.toString())
                    pcm = Base64.getDecoder().decode(json.getString("audio_base64"))
                    sampleRate = json.optInt("sample_rate", 24000)
                    encoding = json.optString("audio_encoding", "pcm_s16le")
                }
                "error" -> {
                    val message = JSONObject(data.toString()).optString("message", "Request failed")
                    if (completedText == null) return Result.Failure(response.code, message)
                    // Text generation is complete; a later failure must not discard the reply.
                    audioError = message
                    pcm = byteArrayOf()
                }
                "turn.done" -> {
                    val finalText = completedText
                    val finalConversationId = conversationId
                    if (finalText == null || finalConversationId == null) {
                        return Result.Failure(response.code, "Response stream ended before the answer completed")
                    }
                    return Result.Success(
                        ChatResponse(finalText, finalConversationId, pcm, sampleRate, encoding, audioError),
                    )
                }
            }
            return null
        }

        while (true) {
            currentCoroutineContext().ensureActive()
            val line = source.readUtf8Line() ?: break
            if (line.isEmpty()) {
                dispatch()?.let { return it }
                event = ""
                data.setLength(0)
            } else if (!line.startsWith(':')) {
                val separator = line.indexOf(':')
                val field = if (separator < 0) line else line.substring(0, separator)
                val value = if (separator < 0) "" else line.substring(separator + 1).removePrefix(" ")
                when (field) {
                    "event" -> event = value
                    "data" -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(value)
                    }
                }
            }
        }
        return Result.Failure(response.code, "Response stream ended before turn.done")
    }

    private suspend fun <T> postJson(
        baseUrl: String,
        path: String,
        body: JSONObject,
        bearer: String? = null,
        parse: (JSONObject) -> T,
    ): Result<T> =
        post(baseUrl, path, body, bearer) { response ->
            Result.Success(parse(JSONObject(response.body?.string().orEmpty())))
        }

    private suspend fun <T> post(
        baseUrl: String,
        path: String,
        body: JSONObject,
        bearer: String? = null,
        accept: String = "application/json",
        parse: suspend (Response) -> Result<T>,
    ): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                val builder =
                    Request.Builder()
                        .url(baseUrl.trimEnd('/') + path)
                        .header("Accept", accept)
                        .post(body.toString().toRequestBody(jsonType))
                if (!bearer.isNullOrBlank()) builder.header("Authorization", "Bearer $bearer")
                val call = client.newCall(builder.build())
                // This child job cancels immediately with its parent, even during a blocking read.
                val cancellation = Job(currentCoroutineContext().job)
                val registration = cancellation.invokeOnCompletion { cause ->
                    if (cause != null) call.cancel()
                }
                try {
                    currentCoroutineContext().ensureActive()
                    call.execute().use { response ->
                        if (!response.isSuccessful) {
                            val raw = response.body?.string().orEmpty()
                            val detail =
                                try {
                                    JSONObject(raw).optString("detail", raw)
                                } catch (_: Exception) {
                                    raw
                                }
                            return@withContext Result.Failure(
                                response.code,
                                detail.ifBlank { "HTTP ${response.code}" },
                            )
                        }
                        return@withContext try {
                            parse(response)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            currentCoroutineContext().ensureActive()
                            Result.Failure(response.code, error.message ?: "Invalid server response")
                        }
                    }
                } finally {
                    registration.dispose()
                    cancellation.complete()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                Result.Failure(0, error.message ?: error.toString())
            }
        }

    private fun parseTokens(json: JSONObject): Tokens =
        Tokens(
            accessToken = json.getString("access_token"),
            refreshToken = json.getString("refresh_token"),
        )
}
