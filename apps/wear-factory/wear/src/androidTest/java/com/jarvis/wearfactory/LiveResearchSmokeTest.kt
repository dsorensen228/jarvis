package com.jarvis.wearfactory

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jarvis.wearfactory.api.CodeFactoryWearApi
import com.jarvis.wearfactory.session.PrefsRepository
import com.jarvis.wearfactory.session.TokenStore
import com.jarvis.wearfactory.task.FactoryMode
import com.jarvis.wearfactory.task.ResearchReportParser
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Read-only deployment check using the installed app's existing account and API preference.
 * Enable with -e liveResearch true. Ordinary instrumentation runs skip this test.
 * Requires coding history and a successful research report among the first 200 history entries.
 * Credentials and report/task content must never be included in assertion messages or logs.
 */
@RunWith(AndroidJUnit4::class)
class LiveResearchSmokeTest {
    @Test
    fun existingAccountCanReadCodeResearchActivityAndReport() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveResearch") == "true")

        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val tokenStore = TokenStore(context)
            val baseUrl = PrefsRepository(context).prefsFlow.first().apiBaseUrl
            val reader = AuthenticatedReader(CodeFactoryWearApi(), tokenStore, baseUrl)

            val codePage = reader.read("Coding list") { api, token ->
                api.listTasks(baseUrl, token, mode = FactoryMode.CODE)
            }
            assertTrue("Prerequisite: the signed-in account must have coding history", codePage.items.isNotEmpty())
            assertTrue("Coding list must contain only coding tasks", codePage.items.all { it.taskType == "code" })

            var cursor: String? = null
            val visitedCursors = mutableSetOf<String>()
            var selectedTask: CodeFactoryWearApi.CodeTask? = null
            for (pageNumber in 1..10) {
                val page = reader.read("Research list") { api, token ->
                    api.listTasks(baseUrl, token, cursor = cursor, view = "history", mode = FactoryMode.RESEARCH)
                }
                assertTrue("Research list must contain only research tasks", page.items.all { it.taskType == "research" })
                selectedTask = page.items.firstOrNull { it.status == "success" && it.reportAvailable }
                if (selectedTask != null) break
                val nextCursor = page.nextCursor ?: break
                assertTrue("Research pagination must advance", visitedCursors.add(nextCursor))
                cursor = nextCursor
            }
            val task = selectedTask ?: throw AssertionError(
                "Prerequisite: the signed-in account needs a successful research report within its first 200 history entries",
            )

            val detail = reader.read("Research detail") { api, token ->
                api.getTask(baseUrl, token, task.id, mode = FactoryMode.RESEARCH)
            }
            assertTrue("Research detail must match the selected task", detail.id == task.id)
            assertTrue("Research detail must retain research type", detail.taskType == "research")
            assertTrue("Research detail must advertise its completed report", detail.status == "success" && detail.reportAvailable)

            val output = reader.read("Research activity") { api, token ->
                api.getOutput(baseUrl, token, task.id, after = 0, mode = FactoryMode.RESEARCH)
            }
            assertTrue("Research activity must reference the selected task", output.task.id == task.id)
            assertTrue("Research activity must retain research type", output.task.taskType == "research")
            assertTrue("Research activity cursor must be valid", output.nextAfter >= 0)
            assertTrue("Research activity events must use positive sequence numbers", output.items.all { it.seq > 0 })

            val report = reader.read("Research report") { api, token ->
                api.getReport(baseUrl, token, task.id)
            }
            assertTrue("Research report must match the selected task", report.taskId == task.id)
            assertTrue("Research report HTML must not be empty", report.html.isNotBlank())
            val blocks = ResearchReportParser.parse(report.html)
            assertTrue("Research report must produce readable semantic content", blocks.any { block -> block.text.any { it.isLetterOrDigit() } })
            assertTrue("Research report must not produce empty reader blocks", blocks.all { it.text.isNotBlank() })
        }
    }

    private class AuthenticatedReader(
        private val api: CodeFactoryWearApi,
        private val tokenStore: TokenStore,
        private val baseUrl: String,
    ) {
        suspend fun <T> read(
            operation: String,
            request: suspend (CodeFactoryWearApi, String) -> CodeFactoryWearApi.Result<T>,
        ): T {
            var token = tokenStore.session.value.accessToken?.takeIf { it.isNotBlank() }
            if (token == null) token = refreshSession()
            var result = request(api, token)
            if (result is CodeFactoryWearApi.Result.Failure && result.status == 401) {
                result = request(api, refreshSession())
            }
            return valueOrFail(operation, result)
        }

        private suspend fun refreshSession(): String {
            val refresh = tokenStore.session.value.refreshToken?.takeIf { it.isNotBlank() }
                ?: throw AssertionError("Prerequisite: sign in to the installed Wear Factory app before the live smoke test")
            val tokens = valueOrFail("Existing session refresh", api.refresh(baseUrl, refresh))
            assertTrue("Session refresh must return both tokens", tokens.accessToken.isNotBlank() && tokens.refreshToken.isNotBlank())
            tokenStore.saveTokens(tokens.accessToken, tokens.refreshToken)
            return tokens.accessToken
        }

        private fun <T> valueOrFail(operation: String, result: CodeFactoryWearApi.Result<T>): T =
            when (result) {
                is CodeFactoryWearApi.Result.Success -> result.value
                is CodeFactoryWearApi.Result.Failure -> throw AssertionError("$operation failed (HTTP ${result.status})")
            }
    }
}
