package com.jarvis.wearjarvis.api

import android.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class JarvisWearApi {
    private val client =
        OkHttpClient.Builder()
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

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    data class Tokens(val accessToken: String, val refreshToken: String)

    data class ChatResponse(
        val text: String,
        val conversationId: String,
        val pcm: ByteArray,
        val sampleRate: Int,
        val encoding: String,
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
    ): Result<ChatResponse> =
        postJson(
            baseUrl = baseUrl,
            path = "/v1/wear/chat",
            bearer = accessToken,
            body =
                JSONObject().put("message", message).apply {
                    if (!conversationId.isNullOrBlank()) put("conversation_id", conversationId)
                },
        ) { json ->
            ChatResponse(
                text = json.optString("response", ""),
                conversationId = json.getString("conversation_id"),
                pcm = Base64.decode(json.optString("audio_base64", ""), Base64.DEFAULT),
                sampleRate = json.optInt("sample_rate", 24000),
                encoding = json.optString("audio_encoding", "pcm_s16le"),
            )
        }

    private suspend fun <T> postJson(
        baseUrl: String,
        path: String,
        body: JSONObject,
        bearer: String? = null,
        parse: (JSONObject) -> T,
    ): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                val builder =
                    Request.Builder()
                        .url(baseUrl.trimEnd('/') + path)
                        .post(body.toString().toRequestBody(jsonType))
                if (!bearer.isNullOrBlank()) builder.header("Authorization", "Bearer $bearer")
                client.newCall(builder.build()).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
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
                        Result.Success(parse(JSONObject(raw)))
                    } catch (error: Exception) {
                        Result.Failure(response.code, error.message ?: "Invalid server response")
                    }
                }
            } catch (error: Exception) {
                Result.Failure(0, error.message ?: error.toString())
            }
        }

    private fun parseTokens(json: JSONObject): Tokens =
        Tokens(
            accessToken = json.getString("access_token"),
            refreshToken = json.getString("refresh_token"),
        )
}
