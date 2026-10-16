package com.jarvis.wearjarvis

import android.Manifest
import android.content.pm.PackageManager
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.jarvis.wearjarvis.api.JarvisWearApi
import com.jarvis.wearjarvis.audio.PcmStreamPlayer
import com.jarvis.wearjarvis.data.AuthSession
import com.jarvis.wearjarvis.data.PrefsRepository
import com.jarvis.wearjarvis.data.TokenStore
import com.jarvis.wearjarvis.data.WearPrefs
import com.jarvis.wearjarvis.speech.SpeechRecognizerHelper
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

private const val AUTO_CLOSE_MS = 15_000L

@Composable
fun WearJarvisScreen(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val prefsRepo = remember { PrefsRepository(context.applicationContext) }
    val tokenStore = remember { TokenStore(context.applicationContext) }
    val prefs by
        prefsRepo.prefsFlow.collectAsStateWithLifecycle(
            initialValue = WearPrefs(BuildConfig.WEAR_API_BASE_URL),
        )
    val session by tokenStore.session.collectAsStateWithLifecycle()

    if (session.isSignedIn) {
        MainPanel(modifier, prefs, session, tokenStore)
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
    val api = remember { JarvisWearApi() }
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
                        is JarvisWearApi.Result.Success ->
                            tokenStore.saveTokens(
                                exchange.value.accessToken,
                                exchange.value.refreshToken,
                            )
                        is JarvisWearApi.Result.Failure -> error = exchange.message
                    }
                } catch (exception: Exception) {
                    Log.e("WearJarvis", "Google sign-in failed", exception)
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
            // Jarvis tokens are still cleared even if Play Services sign-out fails.
        }
    }
    tokenStore.clear()
}

@Composable
private fun MainPanel(
    modifier: Modifier,
    prefs: WearPrefs,
    session: AuthSession,
    tokenStore: TokenStore,
) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val scope = rememberCoroutineScope()
    val api = remember { JarvisWearApi() }
    val player = remember { PcmStreamPlayer() }
    var speechHelper by remember { mutableStateOf<SpeechRecognizerHelper?>(null) }
    var listening by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var reply by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var conversationId by remember { mutableStateOf<String?>(null) }
    var closeJob by remember { mutableStateOf<Job?>(null) }
    var turnJob by remember { mutableStateOf<Job?>(null) }

    fun scheduleClose() {
        closeJob?.cancel()
        closeJob =
            scope.launch {
                delay(AUTO_CLOSE_MS)
                (context as? MainActivity)?.finish()
            }
    }

    suspend fun sendMessage(message: String) {
        sending = true
        error = null
        var access = session.accessToken.orEmpty()
        val onText: suspend (String) -> Unit = { text ->
            withContext(Dispatchers.Main) { reply = text }
        }
        var result = api.chat(prefs.apiBaseUrl, access, message, conversationId, onText)
        if (result is JarvisWearApi.Result.Failure && result.status == 401) {
            when (val refreshed = api.refresh(prefs.apiBaseUrl, session.refreshToken.orEmpty())) {
                is JarvisWearApi.Result.Success -> {
                    tokenStore.saveTokens(
                        refreshed.value.accessToken,
                        refreshed.value.refreshToken,
                    )
                    access = refreshed.value.accessToken
                    result = api.chat(prefs.apiBaseUrl, access, message, conversationId, onText)
                }
                is JarvisWearApi.Result.Failure -> {
                    tokenStore.clear()
                    error = refreshed.message
                    sending = false
                    return
                }
            }
        }
        when (result) {
            is JarvisWearApi.Result.Success -> {
                reply = result.value.text
                conversationId = result.value.conversationId
                error = result.value.audioError
                if (result.value.pcm.isNotEmpty() &&
                    player.startIfNeeded(result.value.sampleRate, 1, result.value.encoding)
                ) {
                    player.enqueue(result.value.pcm)
                }
                scheduleClose()
            }
            is JarvisWearApi.Result.Failure -> {
                if (result.status == 401) tokenStore.clear()
                error = result.message
            }
        }
        sending = false
    }

    fun startRecognizer() {
        closeJob?.cancel()
        turnJob?.cancel()
        sending = false
        player.stop()
        reply = ""
        error = null
        listening = true
        speechHelper?.destroy()
        speechHelper =
            SpeechRecognizerHelper(
                    context = context,
                    onPartial = {},
                    onFinal = { message ->
                        listening = false
                        speechHelper?.destroy()
                        speechHelper = null
                        turnJob = scope.launch { sendMessage(message) }
                    },
                    onError = { code ->
                        listening = false
                        speechHelper?.destroy()
                        speechHelper = null
                        if (code != SpeechRecognizer.ERROR_NO_MATCH &&
                            code != SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                        ) {
                            error = speechErrorLabel(code)
                        }
                    },
                )
                .also { it.start() }
    }

    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startRecognizer() else error = "Microphone permission is required"
        }

    fun toggleListening() {
        if (listening) {
            listening = false
            speechHelper?.destroy()
            speechHelper = null
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startRecognizer()
        } else {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            closeJob?.cancel()
            turnJob?.cancel()
            speechHelper?.destroy()
            player.stop()
        }
    }

    Box(
        modifier = modifier.fillMaxSize().padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        WearTurnContent(
            listening = listening,
            sending = sending,
            reply = reply,
            onTap = { if (!sending) toggleListening() },
            onSignOut = {
                turnJob?.cancel()
                player.stop()
                scope.launch { signOutGoogle(activity, tokenStore) }
            },
        )
        if (error != null) {
            Text(
                error.orEmpty(),
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            )
        }
    }
}

private fun speechErrorLabel(code: Int): String =
    when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
        SpeechRecognizer.ERROR_CLIENT -> "Speech service unavailable"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission denied"
        SpeechRecognizer.ERROR_NETWORK -> "Network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "Recognition server error"
        else -> "Speech error ($code)"
    }
