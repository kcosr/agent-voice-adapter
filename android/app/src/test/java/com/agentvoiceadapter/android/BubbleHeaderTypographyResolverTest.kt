package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BubbleHeaderTypographyResolverTest {
  @Test
  fun `assistant header uses medium weight family`() {
    val family = BubbleHeaderTypographyResolver.resolveHeaderFontFamily("assistant")

    assertEquals("sans-serif-medium", family)
  }

  @Test
  fun `user header uses medium weight family`() {
    val family = BubbleHeaderTypographyResolver.resolveHeaderFontFamily("user")

    assertEquals("sans-serif-medium", family)
  }

  @Test
  fun `system header uses medium weight family`() {
    val family = BubbleHeaderTypographyResolver.resolveHeaderFontFamily("system")

    assertEquals("sans-serif-medium", family)
  }

  @Test
  fun `unknown role falls back to default family`() {
    val family = BubbleHeaderTypographyResolver.resolveHeaderFontFamily("other")

    assertEquals("sans-serif", family)
  }
}
