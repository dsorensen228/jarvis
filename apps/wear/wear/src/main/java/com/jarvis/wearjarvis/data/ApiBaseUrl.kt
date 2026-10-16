package com.jarvis.wearjarvis.data

import java.net.URI

/** Retire saved LAN endpoints so upgraded watches can use the public tunnel away from home. */
internal fun resolveApiBaseUrl(stored: String, defaultUrl: String): String {
    val value = stored.trim()
    val host = runCatching { URI(value).host?.lowercase()?.removeSurrounding("[", "]") }.getOrNull()
        ?: return defaultUrl
    val octets = host.split('.').mapNotNull { it.toIntOrNull() }
    val privateIpv4 = octets.size == 4 && (
        octets[0] == 10 || octets[0] == 127 ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 169 && octets[1] == 254)
        )
    val localIpv6 = host.contains(':') && (
        host == "::1" || host.startsWith("fc") || host.startsWith("fd") ||
            host.startsWith("fe8") || host.startsWith("fe9") ||
            host.startsWith("fea") || host.startsWith("feb")
        )
    val localName = !host.contains('.') && !host.contains(':') || host.endsWith(".local")
    return if (privateIpv4 || localIpv6 || localName) defaultUrl else value
}
