package com.jarvis.wearfactory.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiBaseUrlTest {
    @Test
    fun publicDefaultIsTheReservedNgrokTunnel() {
        assertEquals(
            "https://jarvis-api.example.com",
            ApiBaseUrl.PUBLIC_NGROK,
        )
        assertTrue(ApiBaseUrl.PUBLIC_NGROK.contains("ngrok", ignoreCase = true))
    }

    @Test
    fun resolveUsesStoredOverrideWhenPresent() {
        assertEquals(
            "http://10.0.0.5:8000",
            ApiBaseUrl.resolve(
                stored = "http://10.0.0.5:8000",
                buildConfigUrl = ApiBaseUrl.PUBLIC_NGROK,
            ),
        )
    }

    @Test
    fun resolveFallsBackToBuildConfigThenPublicNgrok() {
        assertEquals(
            ApiBaseUrl.PUBLIC_NGROK,
            ApiBaseUrl.resolve(stored = "  ", buildConfigUrl = ApiBaseUrl.PUBLIC_NGROK),
        )
        assertEquals(
            ApiBaseUrl.PUBLIC_NGROK,
            ApiBaseUrl.resolve(stored = "", buildConfigUrl = ""),
        )
        assertEquals(
            "https://example.test",
            ApiBaseUrl.resolve(stored = "", buildConfigUrl = "https://example.test"),
        )
    }
}
