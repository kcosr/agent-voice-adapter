package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionFilterUtilsTest {
  @Test
  fun `global filter includes all bubbles`() {
    assertTrue(
      SessionFilterUtils.shouldDisplayBubble(
        selectedFilterId = SessionFilterUtils.GLOBAL_FILTER_ID,
        bubbleSessionId = "",
      ),
    )
    assertTrue(
      SessionFilterUtils.shouldDisplayBubble(
        selectedFilterId = SessionFilterUtils.GLOBAL_FILTER_ID,
        bubbleSessionId = "session-a",
      ),
    )
  }

  @Test
  fun `session filter includes only matching session bubbles`() {
    assertTrue(
      SessionFilterUtils.shouldDisplayBubble(
        selectedFilterId = "session-a",
        bubbleSessionId = "session-a",
      ),
    )
    assertFalse(
      SessionFilterUtils.shouldDisplayBubble(
        selectedFilterId = "session-a",
        bubbleSessionId = "session-b",
      ),
    )
    assertFalse(
      SessionFilterUtils.shouldDisplayBubble(
        selectedFilterId = "session-a",
        bubbleSessionId = "",
      ),
    )
  }

  @Test
  fun `shift filter moves to adjacent tab and stops at bounds`() {
    val ordered = listOf("", "session-a", "session-b")
    assertEquals("session-a", SessionFilterUtils.shiftFilterId("", ordered, direction = 1))
    assertEquals("session-b", SessionFilterUtils.shiftFilterId("session-a", ordered, direction = 1))
    assertEquals("session-a", SessionFilterUtils.shiftFilterId("session-b", ordered, direction = -1))
    assertNull(SessionFilterUtils.shiftFilterId("session-b", ordered, direction = 1))
    assertNull(SessionFilterUtils.shiftFilterId("", ordered, direction = -1))
  }

  @Test
  fun `non-visible active session is detected only for mismatched scoped filters`() {
    assertFalse(
      SessionFilterUtils.isNonVisibleActiveSession(
        selectedFilterId = SessionFilterUtils.GLOBAL_FILTER_ID,
        activeSessionId = "session-a",
      ),
    )
    assertFalse(
      SessionFilterUtils.isNonVisibleActiveSession(
        selectedFilterId = "session-a",
        activeSessionId = "",
      ),
    )
    assertFalse(
      SessionFilterUtils.isNonVisibleActiveSession(
        selectedFilterId = "session-a",
        activeSessionId = "session-a",
      ),
    )
    assertTrue(
      SessionFilterUtils.isNonVisibleActiveSession(
        selectedFilterId = "session-a",
        activeSessionId = "session-b",
      ),
    )
  }

  @Test
  fun `active session filter chip excludes global and matches normalized ids`() {
    assertFalse(
      SessionFilterUtils.isActiveSessionFilterChip(
        filterId = SessionFilterUtils.GLOBAL_FILTER_ID,
        activeSessionId = "session-a",
      ),
    )
    assertTrue(
      SessionFilterUtils.isActiveSessionFilterChip(
        filterId = " session-a ",
        activeSessionId = "session-a",
      ),
    )
    assertFalse(
      SessionFilterUtils.isActiveSessionFilterChip(
        filterId = "session-b",
        activeSessionId = "session-a",
      ),
    )
  }

  @Test
  fun `remove messages for session keeps non-matching messages and reports removed count`() {
    val messages = listOf("m1", "m2", "m3", "m4")
    val byMessageSession = mapOf(
      "m1" to "session-a",
      "m2" to "",
      "m3" to "session-a",
      "m4" to "session-b",
    )
    val result = SessionFilterUtils.removeMessagesForSession(
      messages = messages,
      targetSessionId = "session-a",
      resolveSessionId = { message -> byMessageSession[message].orEmpty() },
    )
    assertEquals(listOf("m2", "m4"), result.keptMessages)
    assertEquals(2, result.removedCount)
  }

  @Test
  fun `remove messages for empty target leaves list unchanged`() {
    val messages = listOf("m1", "m2")
    val result = SessionFilterUtils.removeMessagesForSession(
      messages = messages,
      targetSessionId = SessionFilterUtils.GLOBAL_FILTER_ID,
      resolveSessionId = { _ -> "session-a" },
    )
    assertEquals(messages, result.keptMessages)
    assertEquals(0, result.removedCount)
  }
}
