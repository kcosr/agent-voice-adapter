package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Test

class BubblePulseTest {
  @Test
  fun trianglePulseFraction_cyclesBetweenZeroAndOne() {
    assertEquals(0f, BubblePulse.trianglePulseFraction(elapsedMs = 0, halfCycleDurationMs = 1000), 0.0001f)
    assertEquals(0.5f, BubblePulse.trianglePulseFraction(elapsedMs = 500, halfCycleDurationMs = 1000), 0.0001f)
    assertEquals(1f, BubblePulse.trianglePulseFraction(elapsedMs = 1000, halfCycleDurationMs = 1000), 0.0001f)
    assertEquals(0.5f, BubblePulse.trianglePulseFraction(elapsedMs = 1500, halfCycleDurationMs = 1000), 0.0001f)
    assertEquals(0f, BubblePulse.trianglePulseFraction(elapsedMs = 2000, halfCycleDurationMs = 1000), 0.0001f)
  }

  @Test
  fun pulseFractionToAlphaFraction_clampsAndInterpolates() {
    assertEquals(0.78f, BubblePulse.pulseFractionToAlphaFraction(0f), 0.0001f)
    assertEquals(0.89f, BubblePulse.pulseFractionToAlphaFraction(0.5f), 0.0001f)
    assertEquals(1f, BubblePulse.pulseFractionToAlphaFraction(1f), 0.0001f)

    assertEquals(0f, BubblePulse.pulseFractionToAlphaFraction(-1f, minAlphaFraction = -0.3f), 0.0001f)
    assertEquals(1f, BubblePulse.pulseFractionToAlphaFraction(2f, minAlphaFraction = 2f), 0.0001f)
  }

  @Test
  fun pulseFractionToInt_clampsAndInterpolates() {
    assertEquals(3, BubblePulse.pulseFractionToInt(pulseFraction = -1f, minValue = 3, maxValue = 5))
    assertEquals(3, BubblePulse.pulseFractionToInt(pulseFraction = 0f, minValue = 3, maxValue = 5))
    assertEquals(4, BubblePulse.pulseFractionToInt(pulseFraction = 0.5f, minValue = 3, maxValue = 5))
    assertEquals(5, BubblePulse.pulseFractionToInt(pulseFraction = 1f, minValue = 3, maxValue = 5))
    assertEquals(5, BubblePulse.pulseFractionToInt(pulseFraction = 2f, minValue = 3, maxValue = 5))
    assertEquals(4, BubblePulse.pulseFractionToInt(pulseFraction = 0.5f, minValue = 5, maxValue = 3))
  }

  @Test
  fun withAlpha_preservesRgbAndClampsAlpha() {
    val baseColor = 0xFFEA580C.toInt()
    val low = BubblePulse.withAlpha(baseColor, 0.78f)
    val high = BubblePulse.withAlpha(baseColor, 1.2f)
    val zero = BubblePulse.withAlpha(baseColor, -0.5f)

    assertEquals(0x00EA580C, low and 0x00FFFFFF)
    assertEquals(0x00EA580C, high and 0x00FFFFFF)
    assertEquals(0x00EA580C, zero and 0x00FFFFFF)
    assertEquals(199, (low ushr 24) and 0xFF)
    assertEquals(255, (high ushr 24) and 0xFF)
    assertEquals(0, (zero ushr 24) and 0xFF)
  }
}
