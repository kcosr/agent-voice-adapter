package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BubbleHeaderTextColorResolverTest {
  @Test
  fun `assistant no-wait uses assistant header color`() {
    val resolved = BubbleHeaderTextColorResolver.resolve(
      role = "assistant",
      noWait = true,
      assistantHeaderColor = 1,
      assistantNoWaitHeaderColor = 2,
      userHeaderColor = 3,
      systemHeaderColor = 4,
    )

    assertEquals(1, resolved)
  }

  @Test
  fun `assistant wait uses assistant no-wait header color`() {
    val resolved = BubbleHeaderTextColorResolver.resolve(
      role = "assistant",
      noWait = false,
      assistantHeaderColor = 1,
      assistantNoWaitHeaderColor = 2,
      userHeaderColor = 3,
      systemHeaderColor = 4,
    )

    assertEquals(2, resolved)
  }

  @Test
  fun `user and system ignore no-wait color`() {
    val userResolved = BubbleHeaderTextColorResolver.resolve(
      role = "user",
      noWait = true,
      assistantHeaderColor = 1,
      assistantNoWaitHeaderColor = 2,
      userHeaderColor = 3,
      systemHeaderColor = 4,
    )
    val systemResolved = BubbleHeaderTextColorResolver.resolve(
      role = "system",
      noWait = true,
      assistantHeaderColor = 1,
      assistantNoWaitHeaderColor = 2,
      userHeaderColor = 3,
      systemHeaderColor = 4,
    )

    assertEquals(3, userResolved)
    assertEquals(4, systemResolved)
  }
}
