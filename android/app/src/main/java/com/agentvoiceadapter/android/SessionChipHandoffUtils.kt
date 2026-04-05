package com.agentvoiceadapter.android

object SessionChipHandoffUtils {
  fun isCaptureSessionChipActive(
    audioState: String,
    recognitionIndicatorActive: Boolean,
  ): Boolean {
    val normalizedAudioState = audioState.trim().lowercase()
    return normalizedAudioState == "capture" ||
      (recognitionIndicatorActive && normalizedAudioState != "playback")
  }

  fun resolveStopTtsSessionForHandoff(
    stopTurnId: String,
    linkedSessionId: String,
    lastActiveTurnId: String,
    lastActiveSessionId: String,
  ): String {
    val normalizedLinkedSessionId = SessionFilterUtils.normalizeFilterId(linkedSessionId)
    if (normalizedLinkedSessionId.isNotEmpty()) {
      return normalizedLinkedSessionId
    }

    val normalizedStopTurnId = stopTurnId.trim()
    if (normalizedStopTurnId.isNotEmpty() && normalizedStopTurnId == lastActiveTurnId.trim()) {
      return SessionFilterUtils.normalizeFilterId(lastActiveSessionId)
    }
    return ""
  }

  fun isStopTtsHandoffActive(
    sessionId: String,
    expiresAtElapsedMs: Long,
    nowElapsedMs: Long,
  ): Boolean {
    return SessionFilterUtils.normalizeFilterId(sessionId).isNotEmpty() &&
      expiresAtElapsedMs > nowElapsedMs
  }
}
