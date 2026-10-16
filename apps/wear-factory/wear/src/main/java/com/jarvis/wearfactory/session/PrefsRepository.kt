package com.jarvis.wearfactory.session

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.jarvis.wearfactory.BuildConfig
import com.jarvis.wearfactory.api.ApiBaseUrl
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "wear_factory")

data class WearPrefs(
    val apiBaseUrl: String,
)

private object Keys {
    val API_BASE = stringPreferencesKey("api_base_url")
}

class PrefsRepository(private val context: Context) {
    val prefsFlow: Flow<WearPrefs> =
        context.dataStore.data.map { prefs ->
            val stored = prefs[Keys.API_BASE]?.trim().orEmpty()
            val apiBaseUrl =
                ApiBaseUrl.resolve(
                    stored = stored,
                    buildConfigUrl = BuildConfig.WEAR_API_BASE_URL,
                )
            WearPrefs(apiBaseUrl = apiBaseUrl)
        }

    suspend fun saveApiBaseUrl(apiBaseUrl: String) {
        context.dataStore.edit { prefs ->
            prefs[Keys.API_BASE] = apiBaseUrl.trim()
        }
    }
}
