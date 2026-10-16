package com.jarvis.wearfactory.api

import com.jarvis.wearfactory.task.FactoryMode
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
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
        val parentTaskId: String? = null,
        val taskType: String = "code",
        val verbosity: String? = null,
        val reportAvailable: Boolean = false,
    )

    data class ResearchReport(val taskId: String, val html: String)

    data class TaskPage(val items: List<CodeTask>, val nextCursor: String?)

    data class OutputEvent(val seq: Int, val kind: String, val text: String)

    data class OutputPage(
        val items: List<OutputEvent>,
        val nextAfter: Int,
        val hasMore: Boolean,
        val truncated: Boolean,
        val task: CodeTask,
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

    suspend fun listTasks(
        baseUrl: String,
        accessToken: String,
        cursor: String? = null,
        view: String = "all",
        mode: FactoryMode = FactoryMode.CODE,
    ): Result<TaskPage> =
        getJson(baseUrl, query(mode.apiPath, "limit" to "20", "cursor" to cursor, "view" to view), accessToken) { json ->
            val page = json as JSONObject
            val array = page.getJSONArray("items")
            TaskPage(
                items = List(array.length()) { parseTask(array.getJSONObject(it)) },
                nextCursor = page.optionalString("next_cursor"),
            )
        }

    suspend fun getTask(baseUrl: String, accessToken: String, taskId: String, mode: FactoryMode = FactoryMode.CODE): Result<CodeTask> =
        getJson(baseUrl, "${mode.apiPath}/$taskId", accessToken) { json ->
            parseTask(json as JSONObject)
        }

    suspend fun createTask(
        baseUrl: String,
        accessToken: String,
        prompt: String,
        model: String,
        mode: FactoryMode = FactoryMode.CODE,
        verbosity: String = "standard",
    ): Result<CodeTask> {
        val body = JSONObject().put("prompt", prompt)
        require(model.isNotBlank()) { "Model is required" }
        body.put("model", model)
        if (mode == FactoryMode.RESEARCH) body.put("verbosity", verbosity)
        return postJson(
            baseUrl = baseUrl,
            path = mode.apiPath,
            body = body,
            bearer = accessToken,
        ) { json -> parseTask(json) }
    }

    suspend fun followUp(
        baseUrl: String,
        accessToken: String,
        taskId: String,
        prompt: String,
        model: String,
    ): Result<CodeTask> =
        postJson(
            baseUrl, "/v1/code-tasks/$taskId/follow-up",
            JSONObject().put("prompt", prompt).put("model", model), accessToken,
        ) { parseTask(it) }

    suspend fun cancelTask(baseUrl: String, accessToken: String, taskId: String, mode: FactoryMode = FactoryMode.CODE): Result<CodeTask> =
        postJson(baseUrl, "${mode.apiPath}/$taskId/cancel", JSONObject(), accessToken) { parseTask(it) }

    suspend fun getOutput(baseUrl: String, accessToken: String, taskId: String, after: Int, mode: FactoryMode = FactoryMode.CODE): Result<OutputPage> =
        getJson(baseUrl, query("${mode.apiPath}/$taskId/output", "after" to after.toString(), "limit" to "100"), accessToken) {
            parseOutput(it as JSONObject)
        }

    suspend fun getReport(baseUrl: String, accessToken: String, taskId: String): Result<ResearchReport> =
        getJson(baseUrl, "${FactoryMode.RESEARCH.apiPath}/$taskId/report", accessToken) {
            val report = it as JSONObject
            ResearchReport(taskId = report.getString("task_id"), html = report.getString("html"))
        }

    /** Closing the screen or putting the watch to sleep closes the socket immediately. */
    fun streamOutput(baseUrl: String, accessToken: String, taskId: String, after: Int): Flow<Result<OutputPage>> =
        callbackFlow {
            val request = Request.Builder()
                .url(baseUrl.trimEnd('/') + query("/v1/code-tasks/$taskId/events", "after" to after.toString()))
                .header("Authorization", "Bearer $accessToken")
                .header("Accept", "text/event-stream")
                .build()
            val call = client.newCall(request)
            val reader = launch(Dispatchers.IO) {
                try {
                    call.execute().use { response ->
                        if (!response.isSuccessful) {
                            trySend(Result.Failure(response.code, "Live updates unavailable (HTTP ${response.code})"))
                            return@use
                        }
                        val source = response.body?.source() ?: return@use
                        var event = ""
                        val data = StringBuilder()
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.isEmpty() -> {
                                    if (event == "output" && data.isNotEmpty()) {
                                        send(Result.Success(parseOutput(JSONObject(data.toString()))))
                                    }
                                    event = ""
                                    data.clear()
                                }
                                line.startsWith("event:") -> event = line.substringAfter(':').trim()
                                line.startsWith("data:") -> {
                                    if (data.isNotEmpty()) data.append('\n')
                                    data.append(line.substringAfter(':').trimStart())
                                }
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    if (!call.isCanceled()) trySend(Result.Failure(0, error.message ?: "Live connection interrupted"))
                } finally {
                    close()
                }
            }
            awaitClose { call.cancel(); reader.cancel() }
        }

    private fun query(path: String, vararg parameters: Pair<String, String?>): String {
        val url = ("https://localhost$path").toHttpUrl().newBuilder()
        parameters.forEach { (key, value) -> if (value != null) url.addQueryParameter(key, value) }
        return url.build().let { it.encodedPath + (it.encodedQuery?.let { query -> "?$query" } ?: "") }
    }

    private fun parseOutput(json: JSONObject): OutputPage {
        val items = json.getJSONArray("items")
        return OutputPage(
            items = List(items.length()) { index ->
                val event = items.getJSONObject(index)
                OutputEvent(event.getInt("seq"), event.getString("kind"), event.getString("text"))
            },
            nextAfter = json.getInt("next_after"),
            hasMore = json.optBoolean("has_more"),
            truncated = json.optBoolean("truncated"),
            task = parseTask(json.getJSONObject("task")),
        )
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
            } catch (error: CancellationException) {
                throw error
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
            model = json.optionalString("model"),
            status = json.optString("status"),
            createdAt = json.optString("created_at"),
            agentOutputJson = outputJson,
            error = json.optionalString("error"),
            stdout = json.optionalString("stdout"),
            stderr = json.optionalString("stderr"),
            parentTaskId = json.optionalString("parent_task_id"),
            taskType = json.optionalString("task_type") ?: "code",
            verbosity = json.optionalString("verbosity"),
            reportAvailable = json.optBoolean("report_available"),
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

    private fun JSONObject.optionalString(key: String): String? =
        if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
}
