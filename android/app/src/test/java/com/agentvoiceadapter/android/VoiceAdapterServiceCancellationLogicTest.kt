package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAdapterServiceCancellationLogicTest {
  @Test
  fun `cancellation reason returns null for successful results`() {
    val reason = VoiceAdapterService.cancellationReasonFromListenResult(
      success = true,
      canceled = true,
      cancelReason = "manual",
      rawError = "canceled",
    )

    assertNull(reason)
  }

  @Test
  fun `cancellation reason prefers explicit cancel reason`() {
    val reason = VoiceAdapterService.cancellationReasonFromListenResult(
      success = false,
      canceled = true,
      cancelReason = "  owner_disconnected  ",
      rawError = "",
    )

    assertEquals("owner_disconnected", reason)
  }

  @Test
  fun `cancellation reason falls back to canceled flag`() {
    val reason = VoiceAdapterService.cancellationReasonFromListenResult(
      success = false,
      canceled = true,
      cancelReason = "  ",
      rawError = "",
    )

    assertEquals("canceled", reason)
  }

  @Test
  fun `cancellation reason maps legacy canceled error`() {
    val reason = VoiceAdapterService.cancellationReasonFromListenResult(
      success = false,
      canceled = false,
      cancelReason = "",
      rawError = "CaNcElEd",
    )

    assertEquals("request_disconnected", reason)
  }

  @Test
  fun `cancellation reason maps owner socket closed error`() {
    val reason = VoiceAdapterService.cancellationReasonFromListenResult(
      success = false,
      canceled = false,
      cancelReason = "",
      rawError = "Turn owner socket closed before completion",
    )

    assertEquals("owner_socket_closed", reason)
  }

  @Test
  fun `cancellation reason returns null for unrelated errors`() {
    val reason = VoiceAdapterService.cancellationReasonFromListenResult(
      success = false,
      canceled = false,
      cancelReason = "",
      rawError = "timeout",
    )

    assertNull(reason)
  }

  @Test
  fun `suppression prune includes ttl-expired entries`() {
    val toClear = VoiceAdapterService.stopTtsSuppressionTurnIdsToClear(
      markedAtByTurnId = mapOf(
        "old" to 0L,
        "recent" to 800L,
      ),
      nowElapsedMs = 1000L,
      ttlMs = 900L,
      maxEntries = 10,
    )

    assertEquals(setOf("old"), toClear)
  }

  @Test
  fun `suppression prune evicts oldest entries when over max size`() {
    val toClear = VoiceAdapterService.stopTtsSuppressionTurnIdsToClear(
      markedAtByTurnId = mapOf(
        "a" to 10L,
        "b" to 20L,
        "c" to 30L,
        "d" to 40L,
      ),
      nowElapsedMs = 50L,
      ttlMs = 1_000L,
      maxEntries = 2,
    )

    assertEquals(setOf("a", "b"), toClear)
  }

  @Test
  fun `suppression prune combines expiration and overflow without duplicates`() {
    val toClear = VoiceAdapterService.stopTtsSuppressionTurnIdsToClear(
      markedAtByTurnId = mapOf(
        "expired-a" to 0L,
        "expired-b" to 10L,
        "newer-c" to 20L,
        "newer-d" to 30L,
      ),
      nowElapsedMs = 100L,
      ttlMs = 85L,
      maxEntries = 1,
    )

    assertEquals(setOf("expired-a", "expired-b", "newer-c"), toClear)
    assertTrue(!toClear.contains("newer-d"))
  }

  @Test
  fun `suppression prune clamps invalid ttl and max values`() {
    val toClear = VoiceAdapterService.stopTtsSuppressionTurnIdsToClear(
      markedAtByTurnId = mapOf(
        "a" to 100L,
        "b" to 200L,
      ),
      nowElapsedMs = 500L,
      ttlMs = 1_000L,
      maxEntries = -1,
    )

    assertEquals(setOf("a", "b"), toClear)
  }
}
