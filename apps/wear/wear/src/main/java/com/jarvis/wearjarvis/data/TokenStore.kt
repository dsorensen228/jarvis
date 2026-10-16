package com.jarvis.wearjarvis.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

data class AuthSession(
    val accessToken: String?,
    val refreshToken: String?,
) {
    val isSignedIn: Boolean
        get() = !accessToken.isNullOrBlank()
}

class TokenStore(context: Context) {

    private val appContext = context.applicationContext

    private val prefs by lazy {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        EncryptedSharedPreferences.create(
            PREFS_NAME,
            masterKeyAlias,
            appContext,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val _session = MutableStateFlow(readSession())
    val session: StateFlow<AuthSession> = _session.asStateFlow()

    private fun readSession(): AuthSession {
        val access = prefs.getString(KEY_ACCESS, null)?.takeIf { it.isNotBlank() }
        val refresh = prefs.getString(KEY_REFRESH, null)?.takeIf { it.isNotBlank() }
        return AuthSession(access, refresh)
    }

    suspend fun saveTokens(accessToken: String, refreshToken: String) =
        withContext(Dispatchers.IO) {
            prefs
                .edit()
                .putString(KEY_ACCESS, accessToken.trim())
                .putString(KEY_REFRESH, refreshToken.trim())
                .apply()
            _session.value = AuthSession(accessToken.trim(), refreshToken.trim())
        }

    suspend fun updateAccessToken(accessToken: String) =
        withContext(Dispatchers.IO) {
            val refresh = prefs.getString(KEY_REFRESH, null)
            prefs.edit().putString(KEY_ACCESS, accessToken.trim()).apply()
            _session.value = AuthSession(accessToken.trim(), refresh)
        }

    suspend fun clear() =
        withContext(Dispatchers.IO) {
            prefs.edit().clear().apply()
            _session.value = AuthSession(null, null)
        }

    companion object {
        private const val PREFS_NAME = "wear_jarvis_auth"
        private const val KEY_ACCESS = "access_token"
        private const val KEY_REFRESH = "refresh_token"
    }
}
