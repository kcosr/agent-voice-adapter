package com.agentvoiceadapter.android

import android.content.pm.ServiceInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAdapterServiceConfigTest {
  @Test
  fun `snapshot listening state reports active when turn capture id is present`() {
    val state = VoiceAdapterService.listeningSnapshotState(activeTurnCaptureId = "turn-123")
    assertEquals("active", state)
  }

  @Test
  fun `snapshot listening state reports inactive when turn capture id is absent`() {
    val state = VoiceAdapterService.listeningSnapshotState(activeTurnCaptureId = null)
    assertEquals("inactive", state)
  }

  @Test
  fun `ends external media session only when pause setting transitions from enabled to disabled`() {
    assertTrue(
      VoiceAdapterService.shouldEndExternalMediaSessionOnConfigUpdate(
        wasPauseExternalMediaEnabled = true,
        isPauseExternalMediaEnabled = false,
      ),
    )
  }

  @Test
  fun `does not end external media session when pause setting stays disabled`() {
    assertFalse(
      VoiceAdapterService.shouldEndExternalMediaSessionOnConfigUpdate(
        wasPauseExternalMediaEnabled = false,
        isPauseExternalMediaEnabled = false,
      ),
    )
  }

  @Test
  fun `does not end external media session when pause setting remains enabled`() {
    assertFalse(
      VoiceAdapterService.shouldEndExternalMediaSessionOnConfigUpdate(
        wasPauseExternalMediaEnabled = true,
        isPauseExternalMediaEnabled = true,
      ),
    )
  }

  @Test
  fun `foreground service capture type includes microphone and playback`() {
    val value = VoiceAdapterService.foregroundServiceTypeForCapture(hasActiveCapture = true)
    val expected =
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    assertEquals(expected, value)
  }

  @Test
  fun `foreground service idle type uses playback only`() {
    val value = VoiceAdapterService.foregroundServiceTypeForCapture(hasActiveCapture = false)
    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK, value)
  }
}
