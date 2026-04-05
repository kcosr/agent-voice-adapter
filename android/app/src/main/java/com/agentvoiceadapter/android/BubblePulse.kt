package com.agentvoiceadapter.android

import kotlin.math.roundToInt

internal object BubblePulse {
  const val DEFAULT_MIN_ALPHA_FRACTION = 0.78f

  fun trianglePulseFraction(elapsedMs: Long, halfCycleDurationMs: Long): Float {
    val safeHalfCycle = halfCycleDurationMs.coerceAtLeast(1L)
    val fullCycle = safeHalfCycle * 2L
    val position = ((elapsedMs % fullCycle) + fullCycle) % fullCycle
    return if (position <= safeHalfCycle) {
      position.toFloat() / safeHalfCycle.toFloat()
    } else {
      (fullCycle - position).toFloat() / safeHalfCycle.toFloat()
    }
  }

  fun pulseFractionToAlphaFraction(
    pulseFraction: Float,
    minAlphaFraction: Float = DEFAULT_MIN_ALPHA_FRACTION,
  ): Float {
    val clampedMin = minAlphaFraction.coerceIn(0f, 1f)
    val clampedPulse = pulseFraction.coerceIn(0f, 1f)
    return clampedMin + ((1f - clampedMin) * clampedPulse)
  }

  fun pulseFractionToInt(
    pulseFraction: Float,
    minValue: Int,
    maxValue: Int,
  ): Int {
    val low = minOf(minValue, maxValue)
    val high = maxOf(minValue, maxValue)
    if (low == high) {
      return low
    }
    val clampedPulse = pulseFraction.coerceIn(0f, 1f)
    return (low + ((high - low) * clampedPulse)).roundToInt()
  }

  fun withAlpha(baseColor: Int, alphaFraction: Float): Int {
    val alpha = (alphaFraction.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return (baseColor and 0x00FFFFFF) or (alpha shl 24)
  }
}
