package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PcmAudioPlayerMathTest {
  @Test
  fun `queue capacity ms applies multiplier and clamps range`() {
    assertEquals(5_000, PcmAudioPlayer.resolvePlaybackQueueCapacityMs(500))
    assertEquals(6_000, PcmAudioPlayer.resolvePlaybackQueueCapacityMs(1_000))
    assertEquals(120_000, PcmAudioPlayer.resolvePlaybackQueueCapacityMs(30_000))
  }

  @Test
  fun `queue capacity bytes uses default sample rate and clamps min and max`() {
    val minClamped = PcmAudioPlayer.resolvePlaybackQueueCapacityBytes(
      sampleRate = 0,
      playbackQueueCapacityMs = 5_000,
    )
    assertEquals(262_144, minClamped)

    val maxClamped = PcmAudioPlayer.resolvePlaybackQueueCapacityBytes(
      sampleRate = Int.MAX_VALUE,
      playbackQueueCapacityMs = 120_000,
    )
    assertEquals(Int.MAX_VALUE, maxClamped)
  }

  @Test
  fun `duration estimation handles invalid and tiny inputs`() {
    assertEquals(0L, PcmAudioPlayer.estimateDurationMsForPcm16(byteCount = 0, sampleRate = 24_000))
    assertEquals(0L, PcmAudioPlayer.estimateDurationMsForPcm16(byteCount = 1, sampleRate = 24_000))
    assertEquals(0L, PcmAudioPlayer.estimateDurationMsForPcm16(byteCount = 2, sampleRate = 0))
    assertEquals(1L, PcmAudioPlayer.estimateDurationMsForPcm16(byteCount = 2, sampleRate = 48_000))
    assertEquals(1_000L, PcmAudioPlayer.estimateDurationMsForPcm16(byteCount = 48_000, sampleRate = 24_000))
  }

  @Test
  fun `drain timeout clamps between min and max`() {
    assertEquals(450L, PcmAudioPlayer.resolvePlaybackDrainTimeoutMs(remainingMs = 0L))
    assertEquals(1_320L, PcmAudioPlayer.resolvePlaybackDrainTimeoutMs(remainingMs = 1_000L))
    assertEquals(8_000L, PcmAudioPlayer.resolvePlaybackDrainTimeoutMs(remainingMs = 20_000L))
  }

  @Test
  fun `recognition cue probe gain is clamped and monotonic`() {
    val low = PcmAudioPlayer.resolveRecognitionCueProbeGain(0.25f)
    val clampedLow = PcmAudioPlayer.resolveRecognitionCueProbeGain(0.0f)
    val mid = PcmAudioPlayer.resolveRecognitionCueProbeGain(2.625f)
    val high = PcmAudioPlayer.resolveRecognitionCueProbeGain(5.0f)

    assertEquals(low, clampedLow, 0.0001f)
    assertEquals(0.158f, low, 0.01f)
    assertEquals(0.794f, mid, 0.02f)
    assertEquals(3.98f, high, 0.05f)
    assertTrue(low < mid)
    assertTrue(mid < high)
  }

  @Test
  fun `cue output rate parses and clamps to supported bounds`() {
    assertEquals(48_000, PcmAudioPlayer.resolveCueOutputRate(null))
    assertEquals(48_000, PcmAudioPlayer.resolveCueOutputRate("not-a-number"))
    assertEquals(16_000, PcmAudioPlayer.resolveCueOutputRate("8000"))
    assertEquals(44_100, PcmAudioPlayer.resolveCueOutputRate("44100"))
    assertEquals(48_000, PcmAudioPlayer.resolveCueOutputRate("96000"))
  }
}
