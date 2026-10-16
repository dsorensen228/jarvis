package com.jarvis.wearfactory.api

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class CodeFactoryWearApi {
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
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    data class Tokens(val accessToken: String, val refreshToken: String)

    data class CodeTask(
        val id: String,
        val prompt: String,
        val model: String?,
        val status: String,
        val createdAt: String,
        val agentOutputJson: String?,
        val error: String?,
        val stdout: String?,
        val stderr: String?,
        val changedPaths: List<String>,
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

    suspend fun listTasks(baseUrl: String, accessToken: String): Result<List<CodeTask>> =
        getJson(baseUrl, "/v1/code-tasks?limit=50", accessToken) { json ->
            val array = json as JSONArray
            buildList {
                for (index in 0 until array.length()) {
                    add(parseTask(array.getJSONObject(index)))
                }
            }
        }

    suspend fun getTask(baseUrl: String, accessToken: String, taskId: String): Result<CodeTask> =
        getJson(baseUrl, "/v1/code-tasks/$taskId", accessToken) { json ->
            parseTask(json as JSONObject)
        }

    suspend fun createTask(
        baseUrl: String,
        accessToken: String,
        prompt: String,
        model: String?,
    ): Result<CodeTask> {
        val body = JSONObject().put("prompt", prompt)
        if (!model.isNullOrBlank()) body.put("model", model)
        return postJson(
            baseUrl = baseUrl,
            path = "/v1/code-tasks",
            body = body,
            bearer = accessToken,
        ) { json -> parseTask(json) }
    }

    private suspend fun <T> postJson(
        baseUrl: String,
        path: String,
        body: JSONObject,
        bearer: String? = null,
        parse: (JSONObject) -> T,
    ): Result<T> =
        execute(
            baseUrl = baseUrl,
            path = path,
            bearer = bearer,
            configure = { builder -> builder.post(body.toString().toRequestBody(jsonType)) },
            parse = { raw -> parse(JSONObject(raw)) },
        )

    private suspend fun <T> getJson(
        baseUrl: String,
        path: String,
        bearer: String,
        parse: (Any) -> T,
    ): Result<T> =
        execute(
            baseUrl = baseUrl,
            path = path,
            bearer = bearer,
            configure = { builder -> builder.get() },
            parse = { raw ->
                val trimmed = raw.trim()
                parse(if (trimmed.startsWith("[")) JSONArray(trimmed) else JSONObject(trimmed))
            },
        )

    private suspend fun <T> execute(
        baseUrl: String,
        path: String,
        bearer: String?,
        configure: (Request.Builder) -> Unit,
        parse: (String) -> T,
    ): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                val builder = Request.Builder().url(baseUrl.trimEnd('/') + path)
                if (!bearer.isNullOrBlank()) builder.header("Authorization", "Bearer $bearer")
                configure(builder)
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
                        Result.Success(parse(raw))
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

    private fun parseTask(json: JSONObject): CodeTask {
        val output = json.opt("agent_output")
        val outputJson =
            when {
                output == null || output == JSONObject.NULL -> null
                output is JSONObject || output is JSONArray -> output.toString()
                else -> output.toString()
            }
        val paths = json.optJSONArray("changed_paths")
        return CodeTask(
            id = json.getString("id"),
            prompt = json.optString("prompt"),
            model = json.optString("model").takeIf { it.isNotBlank() },
            status = json.optString("status"),
            createdAt = json.optString("created_at"),
            agentOutputJson = outputJson,
            error = json.optString("error").takeIf { it.isNotBlank() },
            stdout = json.optString("stdout").takeIf { it.isNotBlank() },
            stderr = json.optString("stderr").takeIf { it.isNotBlank() },
            changedPaths =
                buildList {
                    if (paths != null) {
                        for (index in 0 until paths.length()) {
                            add(paths.optString(index))
                        }
                    }
                },
        )
    }
}
