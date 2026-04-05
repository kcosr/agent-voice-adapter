package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BubbleHeaderLabelResolverTest {
  @Test
  fun `assistant bubble uses linked session title when present`() {
    val resolved = BubbleHeaderLabelResolver.resolveHeaderTitle(
      role = "assistant",
      linkedSessionLabel = "workspace, title",
      defaultRoleLabel = "Assistant",
    )

    assertEquals("workspace, title", resolved)
  }

  @Test
  fun `user bubble uses linked session title when present`() {
    val resolved = BubbleHeaderLabelResolver.resolveHeaderTitle(
      role = "user",
      linkedSessionLabel = "workspace, title",
      defaultRoleLabel = "You",
    )

    assertEquals("workspace, title", resolved)
  }

  @Test
  fun `user bubble keeps role label when linked session title is blank`() {
    val resolved = BubbleHeaderLabelResolver.resolveHeaderTitle(
      role = "user",
      linkedSessionLabel = "   ",
      defaultRoleLabel = "You",
    )

    assertEquals("You", resolved)
  }

  @Test
  fun `system bubble keeps role label even when linked session title exists`() {
    val resolved = BubbleHeaderLabelResolver.resolveHeaderTitle(
      role = "system",
      linkedSessionLabel = "workspace, title",
      defaultRoleLabel = "System",
    )

    assertEquals("System", resolved)
  }
}
