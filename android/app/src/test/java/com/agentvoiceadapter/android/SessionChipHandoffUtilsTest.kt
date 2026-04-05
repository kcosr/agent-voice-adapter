package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionChipHandoffUtilsTest {
  @Test
  fun `capture session chip active follows capture audio and recognition state`() {
    assertTrue(
      SessionChipHandoffUtils.isCaptureSessionChipActive(
        audioState = "capture",
        recognitionIndicatorActive = false,
      ),
    )
    assertTrue(
      SessionChipHandoffUtils.isCaptureSessionChipActive(
        audioState = "idle",
        recognitionIndicatorActive = true,
      ),
    )
    assertFalse(
      SessionChipHandoffUtils.isCaptureSessionChipActive(
        audioState = "idle",
        recognitionIndicatorActive = false,
      ),
    )
    assertFalse(
      SessionChipHandoffUtils.isCaptureSessionChipActive(
        audioState = "playback",
        recognitionIndicatorActive = true,
      ),
    )
  }

  @Test
  fun `stop-tts handoff prefers linked session id when available`() {
    val resolved = SessionChipHandoffUtils.resolveStopTtsSessionForHandoff(
      stopTurnId = "turn-a",
      linkedSessionId = "session-linked",
      lastActiveTurnId = "turn-a",
      lastActiveSessionId = "session-last",
    )

    assertEquals("session-linked", resolved)
  }

  @Test
  fun `stop-tts handoff falls back to last active session when turn matches`() {
    val resolved = SessionChipHandoffUtils.resolveStopTtsSessionForHandoff(
      stopTurnId = "turn-a",
      linkedSessionId = "",
      lastActiveTurnId = "turn-a",
      lastActiveSessionId = "session-last",
    )

    assertEquals("session-last", resolved)
  }

  @Test
  fun `stop-tts handoff does not fall back when stop turn differs`() {
    val resolved = SessionChipHandoffUtils.resolveStopTtsSessionForHandoff(
      stopTurnId = "turn-b",
      linkedSessionId = "",
      lastActiveTurnId = "turn-a",
      lastActiveSessionId = "session-last",
    )

    assertEquals("", resolved)
  }

  @Test
  fun `handoff activity requires non-empty session and future expiry`() {
    assertTrue(
      SessionChipHandoffUtils.isStopTtsHandoffActive(
        sessionId = "session-a",
        expiresAtElapsedMs = 1500L,
        nowElapsedMs = 1000L,
      ),
    )
    assertFalse(
      SessionChipHandoffUtils.isStopTtsHandoffActive(
        sessionId = "session-a",
        expiresAtElapsedMs = 1000L,
        nowElapsedMs = 1000L,
      ),
    )
    assertFalse(
      SessionChipHandoffUtils.isStopTtsHandoffActive(
        sessionId = "",
        expiresAtElapsedMs = 1500L,
        nowElapsedMs = 1000L,
      ),
    )
  }
}
