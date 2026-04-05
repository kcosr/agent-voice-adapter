package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Test

class AppThemePaletteTest {
  @Test
  fun `charcoal assistant header colors match expected tuning`() {
    val charcoal = AppTheme.ALL.first { it.id == "charcoal" }

    assertEquals(0xFFBDBDBD.toInt(), charcoal.bubbleAssistantHeader)
    assertEquals(0xFFCC8A5A.toInt(), charcoal.bubbleAssistantNoWaitHeader)
  }
}
