package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PcmAudioPlayerSignalTest {
  @Test
  fun `software gain returns same instance when gain is effectively one`() {
    val input = byteArrayOf(1, 2, 3, 4, 5)
    val output = PcmAudioPlayer.applySoftwareGainPcm16(input, gain = 1.0005f)
    assertTrue(output === input)
  }

  @Test
  fun `software gain scales signed pcm16 samples and clamps extremes`() {
    val input = pcm16Of(shortArrayOf(1000, -1000, 20_000, -20_000, 32_760, -32_760))
    val output = PcmAudioPlayer.applySoftwareGainPcm16(input, gain = 2.0f)
    val samples = shortsFromPcm16(output)

    assertEquals(listOf(2000, -2000, 32767, -32768, 32767, -32768), samples)
  }

  @Test
  fun `software gain preserves trailing odd byte`() {
    val input = byteArrayOf(0x10, 0x00, 0x20)
    val output = PcmAudioPlayer.applySoftwareGainPcm16(input, gain = 2.0f)

    assertEquals(0x20.toByte(), output.last())
    assertEquals(3, output.size)
  }

  @Test
  fun `software gain supports zero and negative gains`() {
    val input = pcm16Of(shortArrayOf(1000, -1000, 2000, -2000))

    val zeroed = shortsFromPcm16(PcmAudioPlayer.applySoftwareGainPcm16(input, gain = 0f))
    assertEquals(listOf(0, 0, 0, 0), zeroed)

    val inverted = shortsFromPcm16(PcmAudioPlayer.applySoftwareGainPcm16(input, gain = -1f))
    assertEquals(listOf(-1000, 1000, -2000, 2000), inverted)
  }

  @Test
  fun `cue probe pcm returns empty when sample rate is invalid`() {
    assertEquals(0, PcmAudioPlayer.generateCueProbePcmData(sampleRate = 0, success = true).size)
    assertEquals(0, PcmAudioPlayer.generateCueProbePcmData(sampleRate = -1, success = false).size)
  }

  @Test
  fun `cue probe pcm has expected durations for success and failure variants`() {
    val success = PcmAudioPlayer.generateCueProbePcmData(sampleRate = 48_000, success = true)
    val failure = PcmAudioPlayer.generateCueProbePcmData(sampleRate = 48_000, success = false)

    assertEquals(27_840, success.size) // 290ms * 48k * 2 bytes
    assertEquals(28_800, failure.size) // 300ms * 48k * 2 bytes
  }

  @Test
  fun `cue probe pcm contains explicit silence segment and audible segments`() {
    val sampleRate = 48_000
    val bytes = PcmAudioPlayer.generateCueProbePcmData(sampleRate = sampleRate, success = true)

    val firstSegmentSamples = (sampleRate * 95) / 1000
    val silenceSamples = (sampleRate * 55) / 1000
    val silenceStartByte = firstSegmentSamples * 2
    val silenceEndByte = (firstSegmentSamples + silenceSamples) * 2

    val firstSegment = bytes.sliceArray(0 until silenceStartByte)
    val silenceSegment = bytes.sliceArray(silenceStartByte until silenceEndByte)
    val thirdSegment = bytes.sliceArray(silenceEndByte until bytes.size)

    assertTrue(firstSegment.any { it.toInt() != 0 })
    assertTrue(silenceSegment.all { it.toInt() == 0 })
    assertTrue(thirdSegment.any { it.toInt() != 0 })
  }

  @Test
  fun `cue probe tone segments begin at zero sample due fade-in envelope`() {
    val sampleRate = 48_000
    val bytes = PcmAudioPlayer.generateCueProbePcmData(sampleRate = sampleRate, success = true)
    val firstToneStart = 0
    val thirdToneStart = ((95 + 55) * sampleRate) / 1000

    val firstSample = sampleAt(bytes, firstToneStart)
    val thirdStartSample = sampleAt(bytes, thirdToneStart)
    val thirdToneWindow = (1..200).map { offset -> sampleAt(bytes, thirdToneStart + offset) }

    assertEquals(0, firstSample)
    assertEquals(0, thirdStartSample)
    assertTrue(thirdToneWindow.any { it != 0 })
  }

  private fun pcm16Of(samples: ShortArray): ByteArray {
    val bytes = ByteArray(samples.size * 2)
    samples.forEachIndexed { index, sample ->
      val intValue = sample.toInt()
      bytes[index * 2] = (intValue and 0xFF).toByte()
      bytes[index * 2 + 1] = ((intValue shr 8) and 0xFF).toByte()
    }
    return bytes
  }

  private fun shortsFromPcm16(bytes: ByteArray): List<Int> {
    val samples = mutableListOf<Int>()
    var index = 0
    while (index + 1 < bytes.size) {
      val low = bytes[index].toInt() and 0xFF
      val high = bytes[index + 1].toInt()
      val value = (high shl 8) or low
      samples.add(value.toShort().toInt())
      index += 2
    }
    return samples
  }

  private fun sampleAt(bytes: ByteArray, sampleIndex: Int): Int {
    val byteIndex = sampleIndex * 2
    if (byteIndex + 1 >= bytes.size) {
      return 0
    }
    val low = bytes[byteIndex].toInt() and 0xFF
    val high = bytes[byteIndex + 1].toInt()
    return ((high shl 8) or low).toShort().toInt()
  }
}
