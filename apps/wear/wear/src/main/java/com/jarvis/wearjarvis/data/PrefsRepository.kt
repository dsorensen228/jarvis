package com.jarvis.wearjarvis.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.jarvis.wearjarvis.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "wear_jarvis")

data class WearPrefs(
    val apiBaseUrl: String,
)

private object Keys {
    val API_BASE = stringPreferencesKey("api_base_url")
}

class PrefsRepository(private val context: Context) {

    val prefsFlow: Flow<WearPrefs> = context.dataStore.data.map { preferences ->
        val stored = preferences[Keys.API_BASE]?.trim().orEmpty()
        val apiBaseUrl = stored.ifBlank { BuildConfig.WEAR_API_BASE_URL }
        WearPrefs(apiBaseUrl = apiBaseUrl)
    }

    suspend fun saveApiBaseUrl(apiBaseUrl: String) {
        context.dataStore.edit { preferences ->
            preferences[Keys.API_BASE] = apiBaseUrl.trim()
        }
    }
}
