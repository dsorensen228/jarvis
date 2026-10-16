package com.jarvis.wearfactory

import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.compose.foundation.BasicSwipeToDismissBox
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButton
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import com.jarvis.wearfactory.api.ApiBaseUrl
import com.jarvis.wearfactory.api.CodeFactoryWearApi
import com.jarvis.wearfactory.session.PrefsRepository
import com.jarvis.wearfactory.session.TokenStore
import com.jarvis.wearfactory.session.WearPrefs
import com.jarvis.wearfactory.speech.PushToTalkRecognizer
import com.jarvis.wearfactory.task.FactoryMode
import com.jarvis.wearfactory.task.ReportBlock
import com.jarvis.wearfactory.task.ResearchReportParser
import com.jarvis.wearfactory.task.AgentModels
import com.jarvis.wearfactory.task.TaskOutputFormatter
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

private val FactoryAccentPurple = Color(0xFFBF5AF2)

private sealed interface FactoryScreen {
    data object List : FactoryScreen

    data class Create(val parentTaskId: String? = null) : FactoryScreen

    data class Confirm(val transcript: String, val parentTaskId: String? = null) : FactoryScreen

    data class Detail(val taskId: String) : FactoryScreen

    data class Report(val taskId: String) : FactoryScreen
}

@Composable
fun WearFactoryScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val prefsRepo = remember { PrefsRepository(context.applicationContext) }
    val tokenStore = remember { TokenStore(context.applicationContext) }
    val prefs by
        prefsRepo.prefsFlow.collectAsStateWithLifecycle(
            initialValue =
                WearPrefs(
                    ApiBaseUrl.resolve(
                        stored = "",
                        buildConfigUrl = BuildConfig.WEAR_API_BASE_URL,
                    ),
                ),
        )
    val session by tokenStore.session.collectAsStateWithLifecycle()

    if (session.isSignedIn) {
        FactoryModePager(modifier) { mode, isActive, setAtRoot ->
            AuthenticatedPanel(Modifier, prefs, tokenStore, mode, isActive, setAtRoot)
        }
    } else {
        SignInPanel(modifier, prefs, tokenStore)
    }
}

@Composable
private fun SignInPanel(
    modifier: Modifier,
    prefs: WearPrefs,
    tokenStore: TokenStore,
) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val scope = rememberCoroutineScope()
    val api = remember { CodeFactoryWearApi() }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val googleClient =
        remember(BuildConfig.WEAR_GOOGLE_SIGN_IN_CLIENT_ID) {
            BuildConfig.WEAR_GOOGLE_SIGN_IN_CLIENT_ID.takeIf { it.isNotBlank() }?.let { clientId ->
                val options =
                    GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                        .requestEmail()
                        .requestIdToken(clientId)
                        .build()
                GoogleSignIn.getClient(activity, options)
            }
        }

    val signInLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            scope.launch {
                working = true
                error = null
                try {
                    val intent = result.data
                    if (intent == null) {
                        error = context.getString(R.string.sign_in_cancelled)
                        return@launch
                    }
                    val account =
                        withContext(Dispatchers.Main) {
                            GoogleSignIn.getSignedInAccountFromIntent(intent).await()
                        }
                    val idToken = account.idToken
                    if (idToken.isNullOrBlank()) {
                        error = context.getString(R.string.sign_in_no_id_token)
                        return@launch
                    }
                    when (val exchange = api.loginWithGoogle(prefs.apiBaseUrl, idToken)) {
                        is CodeFactoryWearApi.Result.Success ->
                            tokenStore.saveTokens(
                                exchange.value.accessToken,
                                exchange.value.refreshToken,
                            )
                        is CodeFactoryWearApi.Result.Failure -> error = exchange.message
                    }
                } catch (exception: Exception) {
                    Log.e("WearFactory", "Google sign-in failed", exception)
                    error =
                        if (exception is ApiException) {
                            "Google sign-in error ${exception.statusCode}"
                        } else {
                            exception.message ?: context.getString(R.string.sign_in_failed)
                        }
                } finally {
                    working = false
                }
            }
        }

    ScalingLazyColumn(
        modifier = modifier.fillMaxSize().padding(horizontal = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            Text(
                stringResource(R.string.sign_in_title),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
        if (googleClient == null) {
            item {
                Text(
                    stringResource(R.string.missing_google_client_id),
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(6.dp),
                )
            }
        }
        if (error != null) {
            item {
                Text(
                    error.orEmpty(),
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(6.dp),
                )
            }
        }
        item {
            EdgeButton(
                onClick = {
                    if (working) return@EdgeButton
                    when {
                        googleClient == null ->
                            error = context.getString(R.string.missing_google_client_id)
                        prefs.apiBaseUrl.isBlank() ->
                            error = context.getString(R.string.need_api_url)
                        else -> {
                            error = null
                            signInLauncher.launch(googleClient.signInIntent)
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (working) {
                        stringResource(R.string.signing_in)
                    } else {
                        stringResource(R.string.sign_in_with_google)
                    },
                )
            }
        }
    }
}

private suspend fun signOutGoogle(activity: ComponentActivity, tokenStore: TokenStore) {
    val clientId = BuildConfig.WEAR_GOOGLE_SIGN_IN_CLIENT_ID
    if (clientId.isNotBlank()) {
        val options =
            GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestEmail()
                .requestIdToken(clientId)
                .build()
        try {
            withContext(Dispatchers.Main) {
                GoogleSignIn.getClient(activity, options).signOut().await()
            }
        } catch (_: Exception) {
            // Tokens are still cleared even if Play Services sign-out fails.
        }
    }
    tokenStore.clear()
}

@Composable
private fun AuthenticatedPanel(
    modifier: Modifier,
    prefs: WearPrefs,
    tokenStore: TokenStore,
    mode: FactoryMode,
    isActive: Boolean,
    setAtRoot: (Boolean) -> Unit,
) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val taskListState = rememberScalingLazyListState()
    val scope = rememberCoroutineScope()
    val api = remember { CodeFactoryWearApi() }
    var screen by remember { mutableStateOf<FactoryScreen>(FactoryScreen.List) }
    var tasks by remember { mutableStateOf<List<CodeFactoryWearApi.CodeTask>>(emptyList()) }
    var selected by remember { mutableStateOf<CodeFactoryWearApi.CodeTask?>(null) }
    var events by remember { mutableStateOf<List<CodeFactoryWearApi.OutputEvent>>(emptyList()) }
    var after by remember { mutableStateOf(0) }
    var truncated by remember { mutableStateOf(false) }
    var connection by remember { mutableStateOf("Connecting…") }
    var view by remember { mutableStateOf("all") }
    var cursor by remember { mutableStateOf<String?>(null) }
    var pageError by remember { mutableStateOf<String?>(null) }
    var failedPageMore by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    var timedOut by remember { mutableStateOf(false) }
    var recognizer by remember { mutableStateOf<PushToTalkRecognizer?>(null) }
    var timeoutJob by remember { mutableStateOf<Job?>(null) }
    var retry by remember { mutableStateOf(0) }
    var reportBlocks by remember { mutableStateOf<List<ReportBlock>>(emptyList()) }
    var loadingReport by remember { mutableStateOf(false) }
    LaunchedEffect(screen) { setAtRoot(screen == FactoryScreen.List) }

    suspend fun <T> authed(call: suspend (String) -> CodeFactoryWearApi.Result<T>): CodeFactoryWearApi.Result<T> {
        val currentSession = tokenStore.session.value
        var result = call(currentSession.accessToken.orEmpty())
        if (result is CodeFactoryWearApi.Result.Failure && result.status == 401) {
            when (val refreshed = api.refresh(prefs.apiBaseUrl, currentSession.refreshToken.orEmpty())) {
                is CodeFactoryWearApi.Result.Success -> {
                    tokenStore.saveTokens(refreshed.value.accessToken, refreshed.value.refreshToken)
                    result = call(refreshed.value.accessToken)
                }
                is CodeFactoryWearApi.Result.Failure -> {
                    if (refreshed.status == 401) tokenStore.clear()
                    return refreshed
                }
            }
        }
        if (result is CodeFactoryWearApi.Result.Failure && result.status == 401) tokenStore.clear()
        return result
    }

    suspend fun loadPage(more: Boolean = false, reset: Boolean = true) {
        if (!isActive || loading || loadingMore || (more && cursor == null)) return
        val requestedView = view
        val requestedCursor = if (more) cursor else null
        if (more) loadingMore = true else loading = true
        try {
            when (val result = authed { api.listTasks(prefs.apiBaseUrl, it, requestedCursor, requestedView, mode) }) {
                is CodeFactoryWearApi.Result.Success -> if (view == requestedView) {
                    val page = result.value
                    tasks = if (!more && (reset || (requestedView == "active" && page.nextCursor == null))) page.items else
                        (page.items + tasks).distinctBy { it.id }.sortedWith(compareByDescending<CodeFactoryWearApi.CodeTask> { it.createdAt }.thenByDescending { it.id })
                    if (more || reset || (requestedView == "active" && page.nextCursor == null) || tasks.size <= 20) cursor = page.nextCursor
                    pageError = null
                }
                is CodeFactoryWearApi.Result.Failure -> if (view == requestedView) {
                    pageError = result.message
                    failedPageMore = more
                }
            }
        } finally {
            loading = false
            loadingMore = false
        }
    }

    fun openTask(task: CodeFactoryWearApi.CodeTask) {
        selected = task
        events = emptyList()
        after = 0
        truncated = false
        error = null
        connection = "Connecting…"
        screen = FactoryScreen.Detail(task.id)
    }

    fun acceptOutput(page: CodeFactoryWearApi.OutputPage) {
        if ((screen as? FactoryScreen.Detail)?.taskId != page.task.id) return
        selected = page.task
        events = (events + page.items).distinctBy { it.seq }.sortedBy { it.seq }.takeLast(100)
        after = maxOf(after, page.nextAfter)
        truncated = truncated || page.truncated
        tasks = tasks.map { if (it.id == page.task.id) page.task else it }
        error = null
    }

    fun stopRecording() {
        timeoutJob?.cancel()
        timeoutJob = null
        recording = false
        recognizer?.stop()
    }

    fun startRecording() {
        val parentTaskId = (screen as? FactoryScreen.Create)?.parentTaskId
        error = null
        timedOut = false
        recording = true
        recognizer?.destroy()
        recognizer = PushToTalkRecognizer(
            context = context,
            onPartial = {},
            onStopped = { transcript ->
                recording = false
                timeoutJob?.cancel()
                if (screen !is FactoryScreen.Create) return@PushToTalkRecognizer
                if (timedOut) error = context.getString(R.string.record_timeout)
                else if (transcript.isBlank()) error = "No words heard. Tap to try again."
                else screen = FactoryScreen.Confirm(transcript, parentTaskId)
            },
            onFailure = { message ->
                recording = false
                timeoutJob?.cancel()
                error = if (timedOut) context.getString(R.string.record_timeout) else message
            },
        ).also { it.start() }
        timeoutJob?.cancel()
        timeoutJob = scope.launch {
            delay(PushToTalkRecognizer.TIMEOUT_MS)
            if (recording) {
                timedOut = true
                error = context.getString(R.string.record_timeout)
                stopRecording()
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else error = context.getString(R.string.mic_permission)
    }

    fun toggleRecording() {
        if (recording) stopRecording()
        else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording()
        else permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun navigateBack() {
        if (screen == FactoryScreen.List) activity.finish()
        else if (!creating) {
            timeoutJob?.cancel()
            recognizer?.destroy()
            recording = false
            error = null
            val parent = when (val current = screen) {
                is FactoryScreen.Create -> current.parentTaskId
                is FactoryScreen.Confirm -> current.parentTaskId
                else -> null
            }
            screen = when (val current = screen) {
                is FactoryScreen.Report -> FactoryScreen.Detail(current.taskId)
                is FactoryScreen.Confirm -> FactoryScreen.Create(current.parentTaskId)
                else -> if (parent != null) FactoryScreen.Detail(parent) else FactoryScreen.List
            }
        }
    }

    BackHandler(enabled = isActive) { navigateBack() }

    LaunchedEffect(prefs.apiBaseUrl, screen, view, retry, isActive) {
        if (!isActive) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            when (val current = screen) {
                FactoryScreen.List -> {
                    loadPage(reset = tasks.isEmpty())
                    while (true) {
                        delay(15_000)
                        // Keep older loaded pages and the user's scroll position while updating the head.
                        loadPage(reset = false)
                    }
                }
                is FactoryScreen.Detail -> {
                    while (true) {
                        // The finite output endpoint also refreshes credentials before opening SSE.
                        var more: Boolean
                        do {
                            more = false
                            when (val result = authed { api.getOutput(prefs.apiBaseUrl, it, current.taskId, after, mode) }) {
                                is CodeFactoryWearApi.Result.Success -> {
                                    acceptOutput(result.value)
                                    more = result.value.hasMore
                                    connection = "Live"
                                }
                                is CodeFactoryWearApi.Result.Failure -> {
                                    error = result.message
                                    connection = "Reconnecting…"
                                }
                            }
                        } while (more)
                        if (selected?.let { TaskOutputFormatter.isFinished(it.status) } == true && error == null) {
                            connection = "Updated"
                            break
                        }
                        // Research exposes incremental output, not an SSE endpoint.
                        if (mode == FactoryMode.RESEARCH) {
                            delay(4_000)
                            continue
                        }
                        api.streamOutput(prefs.apiBaseUrl, tokenStore.session.value.accessToken.orEmpty(), current.taskId, after).collect { result ->
                            when (result) {
                                is CodeFactoryWearApi.Result.Success -> {
                                    acceptOutput(result.value)
                                    connection = "Live"
                                }
                                is CodeFactoryWearApi.Result.Failure -> connection = "Reconnecting…"
                            }
                        }
                        if (selected?.let { TaskOutputFormatter.isFinished(it.status) } == true) {
                            connection = "Updated"
                            break
                        }
                        connection = "Reconnecting…"
                        delay(4_000)
                    }
                }
                is FactoryScreen.Report -> {
                    loadingReport = true
                    error = null
                    try {
                        when (val result = authed { api.getReport(prefs.apiBaseUrl, it, current.taskId) }) {
                            is CodeFactoryWearApi.Result.Success -> reportBlocks = withContext(Dispatchers.Default) {
                                ResearchReportParser.parse(result.value.html)
                            }
                            is CodeFactoryWearApi.Result.Failure -> error = result.message
                        }
                    } finally { loadingReport = false }
                }
                else -> Unit
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose { timeoutJob?.cancel(); recognizer?.destroy() }
    }

    key(screen) {
        BasicSwipeToDismissBox(
            onDismissed = ::navigateBack,
            userSwipeEnabled = isActive && screen != FactoryScreen.List && !creating,
        ) { isBackground ->
            if (!isBackground) when (val current = screen) {
                FactoryScreen.List -> TaskListScreen(
                    modifier, tasks, loading, loadingMore, cursor != null, pageError, view,
                    listState = taskListState,
                    mode = mode,
                    active = isActive,
                    onRetry = { scope.launch { loadPage(more = failedPageMore) } },
                    onView = { next -> view = next; tasks = emptyList(); cursor = null; pageError = null },
                    onRefresh = { scope.launch { loadPage() } },
                    onLoadMore = { scope.launch { loadPage(more = true) } },
                    onCreate = { error = null; screen = FactoryScreen.Create() },
                    onOpen = ::openTask,
                )
                is FactoryScreen.Create -> CreateScreen(
                    modifier, recording, creating, error,
                    title = if (current.parentTaskId != null) "Follow-up task" else if (mode == FactoryMode.RESEARCH) "New research" else "New task",
                    onToggle = ::toggleRecording,
                    onSignOut = { scope.launch { signOutGoogle(activity, tokenStore) } },
                )
                is FactoryScreen.Confirm -> ConfirmScreen(
                    modifier, current.transcript, creating, error,
                    followUp = current.parentTaskId != null,
                    mode = mode,
                    onConfirmResearch = { model, verbosity ->
                        scope.launch {
                            creating = true
                            error = null
                            try {
                                when (val result = authed { api.createTask(prefs.apiBaseUrl, it, current.transcript, model, mode, verbosity) }) {
                                    is CodeFactoryWearApi.Result.Success -> openTask(result.value)
                                    is CodeFactoryWearApi.Result.Failure -> error = result.message
                                }
                            } finally { creating = false }
                        }
                    },
                    onCancel = { error = null; screen = FactoryScreen.Create(current.parentTaskId) },
                    onConfirm = { model ->
                        scope.launch {
                            creating = true
                            error = null
                            try {
                                when (val result = authed {
                                    if (current.parentTaskId == null) api.createTask(prefs.apiBaseUrl, it, current.transcript, model)
                                    else api.followUp(prefs.apiBaseUrl, it, current.parentTaskId, current.transcript, model)
                                }) {
                                    is CodeFactoryWearApi.Result.Success -> openTask(result.value)
                                    is CodeFactoryWearApi.Result.Failure -> error = result.message
                                }
                            } finally { creating = false }
                        }
                    },
                )
                is FactoryScreen.Detail -> DetailScreen(
                    modifier, selected, events, connection, truncated, error, creating,
                    onRetry = { retry++ },
                    onFollowUp = { error = null; screen = FactoryScreen.Create(current.taskId) },
                    onCancel = {
                        scope.launch {
                            creating = true
                            try {
                                when (val result = authed { api.cancelTask(prefs.apiBaseUrl, it, current.taskId, mode) }) {
                                    is CodeFactoryWearApi.Result.Success -> selected = result.value
                                    is CodeFactoryWearApi.Result.Failure -> error = result.message
                                }
                            } finally { creating = false }
                        }
                    },
                    onBack = { error = null; screen = FactoryScreen.List },
                    onReadReport = { reportBlocks = emptyList(); error = null; screen = FactoryScreen.Report(current.taskId) },
                )
                is FactoryScreen.Report -> ResearchReportScreen(
                    modifier, reportBlocks, loadingReport, error,
                    onRetry = { retry++ }, onBack = ::navigateBack,
                )
            }
        }
    }
}

@Composable
internal fun TaskListScreen(
    modifier: Modifier,
    tasks: List<CodeFactoryWearApi.CodeTask>,
    loading: Boolean,
    loadingMore: Boolean,
    hasMore: Boolean,
    error: String?,
    view: String,
    onView: (String) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onCreate: () -> Unit,
    onOpen: (CodeFactoryWearApi.CodeTask) -> Unit,
    listState: ScalingLazyListState = rememberScalingLazyListState(),
    onRetry: () -> Unit = onRefresh,
    mode: FactoryMode = FactoryMode.CODE,
    active: Boolean = true,
) {
    LaunchedEffect(active, listState, tasks.size, hasMore, loadingMore, loading, error) {
        if (!active) return@LaunchedEffect
        snapshotFlow {
            val info = listState.layoutInfo
            info.visibleItemsInfo.lastOrNull()?.index?.let { it >= info.totalItemsCount - 3 } == true
        }.distinctUntilChanged().collect { nearEnd ->
            if (nearEnd && hasMore && !loading && !loadingMore && error == null) onLoadMore()
        }
    }
    val scope = rememberCoroutineScope()
    ScreenScaffold(scrollState = listState) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            contentPadding = contentPadding,
            modifier = modifier.fillMaxSize().padding(horizontal = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(mode.label, style = MaterialTheme.typography.titleSmall)
                    IconButton(onClick = onCreate) {
                        Icon(Icons.Filled.Add, contentDescription = if (mode == FactoryMode.RESEARCH) "New research task" else stringResource(R.string.new_task))
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("all" to "All", "active" to "Active", "history" to "History").forEach { (key, label) ->
                        Text(
                            label,
                            color = if (key == view) FactoryAccentPurple else MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.clip(CircleShape).selectable(key == view, enabled = !loading && !loadingMore, role = Role.Tab, onClick = { scope.launch { listState.scrollToItem(0) }; onView(key) }).padding(vertical = 8.dp, horizontal = 4.dp),
                        )
                    }
                }
            }
            if (loading && tasks.isEmpty()) {
                item { Text("Loading tasks…", style = MaterialTheme.typography.bodySmall) }
            } else if (tasks.isEmpty() && error == null) {
                item {
                    Text(
                        when (view) { "active" -> "No active tasks"; "history" -> "No finished tasks yet"; else -> "Start your first task with +" },
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            items(tasks, key = { it.id }) { task ->
                androidx.wear.compose.material3.Card(onClick = { onOpen(task) }) {
                    Text(task.status.replace('_', ' '), color = statusColor(task.status), style = MaterialTheme.typography.labelSmall)
                    Text(task.prompt, maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                    Text(
                        listOfNotNull(AgentModels.label(task.model), task.createdAt.take(10).takeIf { it.isNotBlank() }).joinToString(" · "),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            if (error != null) {
                item { Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
                item { TextAction("Retry", onRetry) }
            } else if (loadingMore) {
                item { Text("Loading older tasks…", style = MaterialTheme.typography.bodySmall) }
            } else if (hasMore) {
                item { TextAction("More tasks", onLoadMore, !loading) }
            } else if (tasks.isNotEmpty()) {
                item { Text("You're all caught up", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            item { TextAction(if (loading) "Refreshing…" else "Refresh", onRefresh, !loading && !loadingMore) }
        }
    }
}

@Composable
internal fun TextAction(label: String, onClick: () -> Unit, enabled: Boolean = true) {
    Text(
        label,
        color = if (enabled) FactoryAccentPurple else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.labelMedium,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().clip(CircleShape).clickable(enabled = enabled, onClick = onClick).padding(vertical = 12.dp),
    )
}

@Composable
private fun CreateScreen(
    modifier: Modifier,
    recording: Boolean,
    creating: Boolean,
    error: String?,
    title: String,
    onToggle: () -> Unit,
    onSignOut: () -> Unit,
) {
    Box(modifier = modifier.fillMaxSize().padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
        Text(if (recording) "Tap to finish" else title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.align(Alignment.TopCenter).padding(top = 32.dp))
        when {
            creating -> Text("Creating task…", style = MaterialTheme.typography.titleMedium)
            else ->
                Image(
                    painter = painterResource(R.drawable.factory_logo),
                    contentDescription = stringResource(R.string.logo_content_description),
                    contentScale = ContentScale.Fit,
                    modifier =
                        Modifier
                            .size(96.dp)
                            .clip(CircleShape)
                            .then(
                                if (recording) {
                                    Modifier.border(4.dp, FactoryAccentPurple, CircleShape)
                                } else {
                                    Modifier
                                },
                            )
                            .combinedClickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = onToggle,
                                onLongClick = onSignOut,
                            ),
                )
        }
        if (error != null) {
            Text(
                error,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            )
        }
    }
}

@Composable
internal fun ConfirmScreen(
    modifier: Modifier,
    transcript: String,
    creating: Boolean,
    error: String?,
    onCancel: () -> Unit,
    onConfirm: (String) -> Unit,
    followUp: Boolean = false,
    mode: FactoryMode = FactoryMode.CODE,
    onConfirmResearch: (String, String) -> Unit = { _, _ -> },
) {
    var model by remember { mutableStateOf(AgentModels.DEFAULT) }
    var verbosity by remember { mutableStateOf("standard") }
    val listState = rememberScalingLazyListState()
    ScreenScaffold(scrollState = listState, modifier = modifier) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            contentPadding = contentPadding,
            modifier = Modifier.fillMaxSize().padding(horizontal = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                Text(
                    if (followUp) "Queue follow-up" else if (mode == FactoryMode.RESEARCH) "Confirm research" else stringResource(R.string.confirm_prompt),
                    style = MaterialTheme.typography.titleSmall,
                    textAlign = TextAlign.Center,
                )
            }
            item {
                Text(
                    transcript,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
            if (followUp) {
                item { Text("Runs after the original task finishes, using its context.", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
            }
            item {
                Text(
                    "Model · Required",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            items(AgentModels.CHOICES, key = { it.id }) { choice ->
                val selected = model == choice.id
                Text(
                    choice.label,
                    color =
                        if (selected) {
                            FactoryAccentPurple
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp)
                            .clip(CircleShape)
                            .border(
                                width = 1.dp,
                                color =
                                    if (selected) {
                                        FactoryAccentPurple
                                    } else {
                                        MaterialTheme.colorScheme.outline
                                    },
                                shape = CircleShape,
                            )
                            .selectable(
                                selected = selected,
                                enabled = !creating,
                                role = Role.RadioButton,
                                onClick = { model = choice.id },
                            )
                            .padding(vertical = 6.dp),
                )
            }
            if (mode == FactoryMode.RESEARCH) {
                item { Text("Report detail", style = MaterialTheme.typography.labelSmall) }
                items(listOf("concise" to "Concise", "standard" to "Standard", "in_depth" to "In depth")) { (value, label) ->
                    Text(label,
                        color = if (verbosity == value) FactoryAccentPurple else MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.fillMaxWidth().clip(CircleShape)
                            .selectable(verbosity == value, enabled = !creating, role = Role.RadioButton, onClick = { verbosity = value })
                            .padding(vertical = 12.dp))
                }
            }
            if (error != null) {
                item {
                    Text(
                        error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onCancel, enabled = !creating) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.discard_prompt))
                    }
                    IconButton(onClick = { if (mode == FactoryMode.RESEARCH) onConfirmResearch(model, verbosity) else onConfirm(model) }, enabled = !creating) {
                        Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.confirm_create))
                    }
                }
            }
        }
    }
}

@Composable
internal fun DetailScreen(
    modifier: Modifier,
    task: CodeFactoryWearApi.CodeTask?,
    events: List<CodeFactoryWearApi.OutputEvent>,
    connection: String,
    truncated: Boolean,
    error: String?,
    working: Boolean,
    onRetry: () -> Unit,
    onFollowUp: () -> Unit,
    onCancel: () -> Unit,
    onBack: () -> Unit,
    onReadReport: () -> Unit = {},
) {
    var confirmCancel by remember(task?.id) { mutableStateOf(false) }
    var fullPrompt by remember(task?.id) { mutableStateOf(false) }
    var showActivity by remember(task?.id) { mutableStateOf(false) }
    val research = task?.taskType == "research"
    val finished = task?.let { TaskOutputFormatter.isFinished(it.status) } == true
    val listState = rememberScalingLazyListState()
    ScreenScaffold(scrollState = listState) { contentPadding ->
        ScalingLazyColumn(
            state = listState,
            contentPadding = contentPadding,
            modifier = modifier.fillMaxSize().padding(horizontal = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                Text(
                    task?.status?.replace('_', ' ') ?: "Task",
                    color = statusColor(task?.status.orEmpty()),
                    style = MaterialTheme.typography.titleSmall,
                    textAlign = TextAlign.Center,
                )
            }
            if (task != null) {
                item {
                    Text(
                        listOfNotNull(AgentModels.label(task.model), connection).joinToString(" · "),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall,
                        textAlign = TextAlign.Center,
                    )
                }
                item {
                    Text(
                        task.prompt,
                        maxLines = if (fullPrompt) Int.MAX_VALUE else 4,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.clickable { fullPrompt = !fullPrompt },
                    )
                }
                if (task.parentTaskId != null) {
                    item { Text("Follow-up task", color = FactoryAccentPurple, style = MaterialTheme.typography.labelSmall) }
                }
                if (!research) {
                    item { TextAction(if (finished) "Continue task" else "Queue follow-up", onFollowUp, !working) }
                }
                if (research && task.reportAvailable) {
                    item { TextAction("Read report", onReadReport, !working) }
                }
                if (!finished && task.status != "cancel_requested") {
                    if (confirmCancel) {
                        item { Text("Stop this task?", style = MaterialTheme.typography.bodySmall) }
                        item {
                            Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                                IconButton(onClick = { confirmCancel = false }) { Icon(Icons.Filled.Close, contentDescription = "Keep running") }
                                IconButton(onClick = { confirmCancel = false; onCancel() }, enabled = !working) { Icon(Icons.Filled.Check, contentDescription = "Confirm stop task") }
                            }
                        }
                    } else {
                        item { TextAction(if (working) "Stopping…" else "Stop task", { confirmCancel = true }, !working) }
                    }
                }
                if (task.status == "cancel_requested") {
                    item { Text("Stopping safely…", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
                }
                if (finished && (!research || !task.reportAvailable)) {
                    val output = TaskOutputFormatter.display(task.agentOutputJson, task.error, task.stdout, task.stderr, true)
                    item { Text("Result", style = MaterialTheme.typography.titleSmall) }
                    items(TaskOutputFormatter.pages(output)) { page ->
                        Text(page, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth())
                    }
                }
                if (task.changedPaths.isNotEmpty()) {
                    item {
                        Text(
                            "${task.changedPaths.size} changed files\n${task.changedPaths.joinToString("\n")}",
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (finished && events.isNotEmpty()) {
                    item { TextAction(if (showActivity) "Hide activity" else "Show activity", { showActivity = !showActivity }) }
                }
                if (!finished || showActivity) {
                    item { Text("Latest activity", style = MaterialTheme.typography.titleSmall) }
                    if (truncated || events.size >= 100) {
                        item { Text("Showing recent activity", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    if (events.isEmpty()) {
                        item {
                            Text(
                                if (task.status == "queued") "Waiting for a worker…" else "Waiting for output…",
                                style = MaterialTheme.typography.bodySmall,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                    // Latest first makes new progress visible without fighting the user's scroll position.
                    items(events.asReversed(), key = { "output-${it.seq}" }) { event ->
                        Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                            Text(event.kind.replaceFirstChar { it.uppercase() }, color = if (event.kind == "error") MaterialTheme.colorScheme.error else FactoryAccentPurple, style = MaterialTheme.typography.labelSmall)
                            Text(if (event.text.length > 1600) "…" + event.text.takeLast(1600) else event.text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            }
            if (error != null) {
                item { Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center) }
                item { TextAction("Retry connection", onRetry) }
            }
            item { TextAction("Back to tasks", onBack) }
        }
    }
}

private fun statusColor(status: String): Color =
    when (status) {
        "success" -> Color(0xFF39B978)
        "failed" -> Color(0xFFE45D6B)
        "cancelled", "cancel_requested" -> Color(0xFF85818B)
        else -> FactoryAccentPurple
    }
