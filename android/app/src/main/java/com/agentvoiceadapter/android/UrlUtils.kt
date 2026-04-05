package com.agentvoiceadapter.android

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object UrlUtils {
  fun normalizeBaseUrl(raw: String): String {
    val candidate = raw.trim().ifEmpty { AdapterDefaults.API_BASE_URL }
    val parsed = candidate.toHttpUrlOrNull() ?: AdapterDefaults.API_BASE_URL.toHttpUrlOrNull()
    return parsed?.newBuilder()?.build()?.toString()?.removeSuffix("/") ?: AdapterDefaults.API_BASE_URL
  }

  fun websocketUrl(baseUrl: String): String {
    val parsed = baseUrl.toHttpUrlOrNull() ?: AdapterDefaults.API_BASE_URL.toHttpUrlOrNull()
    require(parsed != null)

    val wsPath = if (parsed.encodedPath.endsWith("/")) {
      "${parsed.encodedPath}ws"
    } else {
      "${parsed.encodedPath}/ws"
    }

    val httpUrl = parsed.newBuilder()
      .encodedPath(wsPath)
      .build()
      .toString()

    return when {
      httpUrl.startsWith("https://") -> "wss://${httpUrl.removePrefix("https://")}"
      httpUrl.startsWith("http://") -> "ws://${httpUrl.removePrefix("http://")}"
      else -> throw IllegalArgumentException("unsupported base URL scheme")
    }
  }

  fun wakeIntentUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/wake-intent")
  fun turnUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/turn")
  fun turnCancelUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/turn/cancel")
  fun turnStopTtsUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/turn/stop-tts")
  fun sessionDispatchSessionsUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/session-dispatch/sessions")
  fun sessionDispatchSendUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/session-dispatch/send")
  fun serverSettingsUrl(baseUrl: String): String = buildApiUrl(baseUrl, "api/server-settings")

  private fun buildApiUrl(baseUrl: String, endpoint: String): String {
    val parsed = baseUrl.toHttpUrlOrNull() ?: AdapterDefaults.API_BASE_URL.toHttpUrlOrNull()
    require(parsed != null)

    val path = if (parsed.encodedPath.endsWith("/")) {
      "${parsed.encodedPath}$endpoint"
    } else {
      "${parsed.encodedPath}/$endpoint"
    }

    return parsed.newBuilder().encodedPath(path).build().toString()
  }
}
