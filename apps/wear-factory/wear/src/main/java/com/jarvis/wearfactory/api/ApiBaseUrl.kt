package com.jarvis.wearfactory.api

/**
 * Public Jarvis API base URL for Wear Code Factory.
 *
 * Matches the reserved Jetson ngrok tunnel used by the Expo mobile app so the watch
 * works off home Wi-Fi. Override via DataStore or `WEAR_API_BASE_URL` in local.properties.
 */
object ApiBaseUrl {
    const val PUBLIC_NGROK = "https://jarvis-api.example.com"

    fun resolve(
        stored: String,
        buildConfigUrl: String,
    ): String {
        val candidate = stored.trim().ifBlank { buildConfigUrl.trim() }
        return candidate.ifBlank { PUBLIC_NGROK }
    }
}
