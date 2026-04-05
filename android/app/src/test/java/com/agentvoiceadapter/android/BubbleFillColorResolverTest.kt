package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BubbleFillColorResolverTest {
  @Test
  fun `assistant no-wait uses standard assistant fill color`() {
    val resolved = BubbleFillColorResolver.resolve(
      role = "assistant",
      noWait = true,
      assistantColor = 1,
      assistantNoWaitColor = 2,
      userColor = 3,
      systemColor = 4,
    )

    assertEquals(1, resolved)
  }

  @Test
  fun `assistant wait uses no-wait accent fill color`() {
    val resolved = BubbleFillColorResolver.resolve(
      role = "assistant",
      noWait = false,
      assistantColor = 1,
      assistantNoWaitColor = 2,
      userColor = 3,
      systemColor = 4,
    )

    assertEquals(2, resolved)
  }

  @Test
  fun `user and system keep role-specific fill colors`() {
    val user = BubbleFillColorResolver.resolve(
      role = "user",
      noWait = true,
      assistantColor = 1,
      assistantNoWaitColor = 2,
      userColor = 3,
      systemColor = 4,
    )
    val system = BubbleFillColorResolver.resolve(
      role = "system",
      noWait = false,
      assistantColor = 1,
      assistantNoWaitColor = 2,
      userColor = 3,
      systemColor = 4,
    )

    assertEquals(3, user)
    assertEquals(4, system)
  }
}
