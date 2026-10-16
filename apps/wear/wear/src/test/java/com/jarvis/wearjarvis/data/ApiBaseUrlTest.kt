package com.jarvis.wearjarvis.data

import org.junit.Assert.assertEquals
import org.junit.Test

class ApiBaseUrlTest {
    private val publicUrl = "https://jarvis-api.example.com"

    @Test fun oldLocalAddressesUsePublicTunnel() {
        listOf(
            "http://jarvis-api.local:8000", "http://192.168.1.55:8000",
            "http://10.0.0.5:8000", "http://172.16.0.2:8000",
            "http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000",
            "http://jetson:8000", "http://[fd00::1]:8000", "",
        ).forEach { stored ->
            assertEquals(stored, publicUrl, resolveApiBaseUrl(stored, publicUrl))
        }
    }

    @Test fun explicitPublicAddressIsPreserved() {
        assertEquals("https://jarvis.example.com", resolveApiBaseUrl(" https://jarvis.example.com ", publicUrl))
        assertEquals(publicUrl, resolveApiBaseUrl(publicUrl, publicUrl))
    }
}
