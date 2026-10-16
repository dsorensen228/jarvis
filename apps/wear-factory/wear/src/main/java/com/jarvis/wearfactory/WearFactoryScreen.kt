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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButton
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.jarvis.wearfactory.api.ApiBaseUrl
import com.jarvis.wearfactory.api.CodeFactoryWearApi
import com.jarvis.wearfactory.session.AuthSession
import com.jarvis.wearfactory.session.PrefsRepository
import com.jarvis.wearfactory.session.TokenStore
import com.jarvis.wearfactory.session.WearPrefs
import com.jarvis.wearfactory.speech.PushToTalkRecognizer
import com.jarvis.wearfactory.task.AgentModels
import com.jarvis.wearfactory.task.TaskOutputFormatter
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

private val FactoryAccentPurple = Color(0xFFBF5AF2)

private sealed interface FactoryScreen {
    data object List : FactoryScreen

    data object Create : FactoryScreen

    data class Confirm(val transcript: String) : FactoryScreen

    data class Detail(val taskId: String) : FactoryScreen
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
        AuthenticatedPanel(modifier, prefs, session, tokenStore)
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
    session: AuthSession,
    tokenStore: TokenStore,
) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val scope = rememberCoroutineScope()
    val api = remember { CodeFactoryWearApi() }
    var screen by remember { mutableStateOf<FactoryScreen>(FactoryScreen.List) }
    var tasks by remember { mutableStateOf<List<CodeFactoryWearApi.CodeTask>>(emptyList()) }
    var selected by remember { mutableStateOf<CodeFactoryWearApi.CodeTask?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var creating by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf(false) }
    var timedOut by remember { mutableStateOf(false) }
    var recognizer by remember { mutableStateOf<PushToTalkRecognizer?>(null) }
    var timeoutJob by remember { mutableStateOf<Job?>(null) }

    suspend fun authed(
        call: suspend (String) -> CodeFactoryWearApi.Result<*>,
    ): CodeFactoryWearApi.Result<*> {
        var access = session.accessToken.orEmpty()
        var result = call(access)
        if (result is CodeFactoryWearApi.Result.Failure && result.status == 401) {
            when (val refreshed = api.refresh(prefs.apiBaseUrl, session.refreshToken.orEmpty())) {
                is CodeFactoryWearApi.Result.Success -> {
                    tokenStore.saveTokens(
                        refreshed.value.accessToken,
                        refreshed.value.refreshToken,
                    )
                    access = refreshed.value.accessToken
                    result = call(access)
                }
                is CodeFactoryWearApi.Result.Failure -> {
                    tokenStore.clear()
                    return refreshed
                }
            }
        }
        if (result is CodeFactoryWearApi.Result.Failure && result.status == 401) {
            tokenStore.clear()
        }
        return result
    }

    suspend fun refreshList() {
        when (val result = authed { api.listTasks(prefs.apiBaseUrl, it) }) {
            is CodeFactoryWearApi.Result.Success -> {
                @Suppress("UNCHECKED_CAST")
                tasks = result.value as List<CodeFactoryWearApi.CodeTask>
                error = null
            }
            is CodeFactoryWearApi.Result.Failure -> error = result.message
        }
        loading = false
    }

    suspend fun refreshSelected(taskId: String) {
        when (val result = authed { api.getTask(prefs.apiBaseUrl, it, taskId) }) {
            is CodeFactoryWearApi.Result.Success -> {
                selected = result.value as CodeFactoryWearApi.CodeTask
                error = null
            }
            is CodeFactoryWearApi.Result.Failure -> error = result.message
        }
    }

    fun stopRecording() {
        timeoutJob?.cancel()
        timeoutJob = null
        recording = false
        recognizer?.stop()
    }

    fun startRecording() {
        error = null
        timedOut = false
        recording = true
        recognizer?.destroy()
        recognizer =
            PushToTalkRecognizer(
                context = context,
                onPartial = {},
                onStopped = { transcript ->
                    recording = false
                    timeoutJob?.cancel()
                    if (timedOut) {
                        error = context.getString(R.string.record_timeout)
                    } else {
                        screen = FactoryScreen.Confirm(transcript)
                    }
                },
                onFailure = { message ->
                    recording = false
                    timeoutJob?.cancel()
                    error =
                        if (timedOut) {
                            context.getString(R.string.record_timeout)
                        } else {
                            message
                        }
                },
            ).also { it.start() }
        timeoutJob?.cancel()
        timeoutJob =
            scope.launch {
                delay(PushToTalkRecognizer.TIMEOUT_MS)
                if (recording) {
                    timedOut = true
                    error = context.getString(R.string.record_timeout)
                    stopRecording()
                }
            }
    }

    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startRecording() else error = context.getString(R.string.mic_permission)
        }

    fun toggleRecording() {
        if (recording) {
            stopRecording()
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startRecording()
        } else {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    BackHandler {
        when (screen) {
            FactoryScreen.List -> activity.finish()
            else -> {
                timeoutJob?.cancel()
                recognizer?.destroy()
                recording = false
                creating = false
                error = null
                screen = FactoryScreen.List
            }
        }
    }

    LaunchedEffect(session.accessToken, prefs.apiBaseUrl) {
        refreshList()
        while (true) {
            delay(4_000)
            refreshList()
            val detail = screen
            if (detail is FactoryScreen.Detail) {
                refreshSelected(detail.taskId)
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            timeoutJob?.cancel()
            recognizer?.destroy()
        }
    }

    when (val current = screen) {
        FactoryScreen.List ->
            TaskListScreen(
                modifier = modifier,
                tasks = tasks,
                loading = loading,
                error = error,
                onCreate = {
                    error = null
                    screen = FactoryScreen.Create
                },
                onOpen = { task ->
                    selected = task
                    screen = FactoryScreen.Detail(task.id)
                    scope.launch { refreshSelected(task.id) }
                },
            )
        FactoryScreen.Create ->
            CreateScreen(
                modifier = modifier,
                recording = recording,
                creating = creating,
                error = error,
                onToggle = { toggleRecording() },
                onSignOut = { scope.launch { signOutGoogle(activity, tokenStore) } },
            )
        is FactoryScreen.Confirm ->
            ConfirmScreen(
                modifier = modifier,
                transcript = current.transcript,
                creating = creating,
                error = error,
                onCancel = {
                    error = null
                    screen = FactoryScreen.Create
                },
                onConfirm = { modelId ->
                    scope.launch {
                        creating = true
                        error = null
                        when (
                            val result =
                                authed {
                                    api.createTask(prefs.apiBaseUrl, it, current.transcript, modelId)
                                }
                        ) {
                            is CodeFactoryWearApi.Result.Success -> {
                                val task = result.value as CodeFactoryWearApi.CodeTask
                                selected = task
                                creating = false
                                screen = FactoryScreen.Detail(task.id)
                                refreshList()
                            }
                            is CodeFactoryWearApi.Result.Failure -> {
                                creating = false
                                error = result.message
                            }
                        }
                    }
                },
            )
        is FactoryScreen.Detail ->
            DetailScreen(
                modifier = modifier,
                task = selected,
                error = error,
                onBack = { screen = FactoryScreen.List },
            )
    }
}

@Composable
private fun TaskListScreen(
    modifier: Modifier,
    tasks: List<CodeFactoryWearApi.CodeTask>,
    loading: Boolean,
    error: String?,
    onCreate: () -> Unit,
    onOpen: (CodeFactoryWearApi.CodeTask) -> Unit,
) {
    ScalingLazyColumn(
        modifier = modifier.fillMaxSize().padding(horizontal = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            IconButton(onClick = onCreate) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.new_task))
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
        if (loading && tasks.isEmpty()) {
            item { Text("Loading…", style = MaterialTheme.typography.titleSmall) }
        } else if (tasks.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.empty_tasks),
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
        }
        items(tasks, key = { it.id }) { task ->
            androidx.wear.compose.material3.Card(onClick = { onOpen(task) }) {
                Text(
                    task.status.replace('_', ' '),
                    color = statusColor(task.status),
                    style = MaterialTheme.typography.labelSmall,
                )
                Text(
                    task.prompt,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun CreateScreen(
    modifier: Modifier,
    recording: Boolean,
    creating: Boolean,
    error: String?,
    onToggle: () -> Unit,
    onSignOut: () -> Unit,
) {
    Box(modifier = modifier.fillMaxSize().padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
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
    onConfirm: (String?) -> Unit,
) {
    var model by remember { mutableStateOf<String?>(null) }
    Box(modifier = modifier.fillMaxSize()) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                Text(
                    stringResource(R.string.confirm_prompt),
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
            item {
                Text(
                    "Model override · Auto if none",
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
                                onClick = { model = if (selected) null else choice.id },
                            )
                            .padding(vertical = 6.dp),
                )
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
                    IconButton(onClick = { onConfirm(model) }, enabled = !creating) {
                        Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.confirm_create))
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailScreen(
    modifier: Modifier,
    task: CodeFactoryWearApi.CodeTask?,
    error: String?,
    onBack: () -> Unit,
) {
    ScalingLazyColumn(
        modifier = modifier.fillMaxSize().padding(horizontal = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            Text(
                task?.status?.replace('_', ' ') ?: "Task",
                color = statusColor(task?.status.orEmpty()),
                style = MaterialTheme.typography.titleSmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.combinedClickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onBack,
                    onLongClick = onBack,
                ),
            )
        }
        if (task != null) {
            val taskModelLabel = AgentModels.label(task.model)
            if (taskModelLabel != null) {
                item {
                    Text(
                        taskModelLabel,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            item {
                Text(
                    task.prompt,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
            val output =
                TaskOutputFormatter.display(
                    agentOutputJson = task.agentOutputJson,
                    error = task.error,
                    stdout = task.stdout,
                    stderr = task.stderr,
                    finished = TaskOutputFormatter.isFinished(task.status),
                )
            if (output.isNotBlank()) {
                item {
                    Text(
                        output,
                        fontSize = 9.sp,
                        lineHeight = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        textAlign = TextAlign.Start,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            if (task.changedPaths.isNotEmpty()) {
                item {
                    Text(
                        "Changed: ${task.changedPaths.joinToString(", ")}",
                        style = MaterialTheme.typography.labelSmall,
                        textAlign = TextAlign.Center,
                    )
                }
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
            EdgeButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                Text("Back")
            }
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
