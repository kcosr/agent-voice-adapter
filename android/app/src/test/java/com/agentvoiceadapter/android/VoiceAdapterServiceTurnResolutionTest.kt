package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAdapterServiceTurnResolutionTest {
  @Test
  fun `runtime ws active turn id prioritizes capture then external then pending`() {
    assertEquals(
      "capture-turn",
      VoiceAdapterService.resolveRuntimeWsActiveTurnId(
        activeTurnCaptureId = "capture-turn",
        activeExternalMediaTurnId = "external-turn",
        pendingTurnRecognitionIds = listOf("pending-turn"),
      ),
    )
    assertEquals(
      "external-turn",
      VoiceAdapterService.resolveRuntimeWsActiveTurnId(
        activeTurnCaptureId = null,
        activeExternalMediaTurnId = "external-turn",
        pendingTurnRecognitionIds = listOf("pending-turn"),
      ),
    )
    assertEquals(
      "pending-turn",
      VoiceAdapterService.resolveRuntimeWsActiveTurnId(
        activeTurnCaptureId = null,
        activeExternalMediaTurnId = null,
        pendingTurnRecognitionIds = listOf("pending-turn", "pending-turn-2"),
      ),
    )
    assertNull(
      VoiceAdapterService.resolveRuntimeWsActiveTurnId(
        activeTurnCaptureId = null,
        activeExternalMediaTurnId = null,
        pendingTurnRecognitionIds = emptyList(),
      ),
    )
  }

  @Test
  fun `runtime ws active turn id keeps blank capture semantics`() {
    assertNull(
      VoiceAdapterService.resolveRuntimeWsActiveTurnId(
        activeTurnCaptureId = "",
        activeExternalMediaTurnId = "external-turn",
        pendingTurnRecognitionIds = emptyList(),
      ),
    )
  }

  @Test
  fun `stop tts turn id prefers explicit then external then runtime`() {
    assertEquals(
      "turn-explicit",
      VoiceAdapterService.resolveStopTtsTurnId(
        requestedTurnId = "  turn-explicit ",
        activeExternalMediaTurnId = "external-turn",
        runtimeWsActiveTurnId = "runtime-turn",
      ),
    )
    assertEquals(
      "external-turn",
      VoiceAdapterService.resolveStopTtsTurnId(
        requestedTurnId = " ",
        activeExternalMediaTurnId = "external-turn",
        runtimeWsActiveTurnId = "runtime-turn",
      ),
    )
    assertEquals(
      "runtime-turn",
      VoiceAdapterService.resolveStopTtsTurnId(
        requestedTurnId = "",
        activeExternalMediaTurnId = null,
        runtimeWsActiveTurnId = "runtime-turn",
      ),
    )
    assertNull(
      VoiceAdapterService.resolveStopTtsTurnId(
        requestedTurnId = "",
        activeExternalMediaTurnId = null,
        runtimeWsActiveTurnId = null,
      ),
    )
  }

  @Test
  fun `abort turn id prefers explicit then capture then external then pending`() {
    assertEquals(
      "turn-explicit",
      VoiceAdapterService.resolveAbortTurnId(
        requestedTurnId = " turn-explicit ",
        activeTurnCaptureId = "capture-turn",
        activeExternalMediaTurnId = "external-turn",
        pendingTurnRecognitionIds = listOf("pending-turn"),
      ),
    )
    assertEquals(
      "capture-turn",
      VoiceAdapterService.resolveAbortTurnId(
        requestedTurnId = "",
        activeTurnCaptureId = "capture-turn",
        activeExternalMediaTurnId = "external-turn",
        pendingTurnRecognitionIds = listOf("pending-turn"),
      ),
    )
    assertEquals(
      "external-turn",
      VoiceAdapterService.resolveAbortTurnId(
        requestedTurnId = "",
        activeTurnCaptureId = null,
        activeExternalMediaTurnId = "external-turn",
        pendingTurnRecognitionIds = listOf("pending-turn"),
      ),
    )
    assertEquals(
      "pending-turn",
      VoiceAdapterService.resolveAbortTurnId(
        requestedTurnId = "",
        activeTurnCaptureId = null,
        activeExternalMediaTurnId = null,
        pendingTurnRecognitionIds = listOf("pending-turn", "pending-turn-2"),
      ),
    )
    assertNull(
      VoiceAdapterService.resolveAbortTurnId(
        requestedTurnId = "",
        activeTurnCaptureId = null,
        activeExternalMediaTurnId = null,
        pendingTurnRecognitionIds = emptyList(),
      ),
    )
  }

  @Test
  fun `playback terminal abort helper excludes only the next turn id`() {
    val turnIds = VoiceAdapterService.playbackTerminalTurnIdsToAbortForNewTurn(
      pendingTurnIds = listOf("turn-a", "turn-b", "turn-c"),
      nextTurnId = "turn-b",
    )

    assertEquals(listOf("turn-a", "turn-c"), turnIds)
  }

  @Test
  fun `playback terminal abort helper keeps all ids when next turn is absent`() {
    val turnIds = VoiceAdapterService.playbackTerminalTurnIdsToAbortForNewTurn(
      pendingTurnIds = listOf("turn-a", "turn-b"),
      nextTurnId = "turn-z",
    )

    assertEquals(listOf("turn-a", "turn-b"), turnIds)
  }

  @Test
  fun `linked session label formatter avoids no-workspace prefix on blank workspace`() {
    assertEquals(
      "workspace, title",
      VoiceAdapterService.formatLinkedSessionLabel(
        workspace = "",
        resolvedTitle = "workspace, title",
      ),
    )
    assertEquals(
      "dev, active-chat",
      VoiceAdapterService.formatLinkedSessionLabel(
        workspace = "dev",
        resolvedTitle = "active-chat",
      ),
    )
  }

  @Test
  fun `in-turn helper returns true while recognition completion is pending`() {
    assertTrue(
      VoiceAdapterService.isInTurnFlowActive(
        activeTurnCaptureId = null,
        activeAgentCaptureId = null,
        activeExternalMediaTurnId = null,
        pendingActiveAgentResultTurnId = null,
        pendingTurnRecognitionIds = listOf("turn-1"),
      ),
    )
  }

  @Test
  fun `in-turn helper returns false when no turn activity remains`() {
    assertFalse(
      VoiceAdapterService.isInTurnFlowActive(
        activeTurnCaptureId = null,
        activeAgentCaptureId = null,
        activeExternalMediaTurnId = null,
        pendingActiveAgentResultTurnId = null,
        pendingTurnRecognitionIds = emptyList(),
      ),
    )
  }
}
