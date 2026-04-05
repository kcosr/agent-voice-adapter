package com.agentvoiceadapter.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalMediaControllerDecisionTest {
  @Test
  fun `marks paused by us only when media transitions to inactive after pause dispatch`() {
    assertTrue(
      ExternalMediaController.shouldMarkPausedByUs(
        isMusicActiveAtStart = true,
        isMusicActiveAfterPause = false,
      ),
    )
    assertFalse(
      ExternalMediaController.shouldMarkPausedByUs(
        isMusicActiveAtStart = true,
        isMusicActiveAfterPause = true,
      ),
    )
    assertFalse(
      ExternalMediaController.shouldMarkPausedByUs(
        isMusicActiveAtStart = false,
        isMusicActiveAfterPause = false,
      ),
    )
  }

  @Test
  fun `attempts resume when media started active, pause was sent, and media is inactive or pause was confirmed`() {
    assertTrue(
      ExternalMediaController.shouldAttemptResume(
        startedWithActiveMedia = true,
        pauseDispatched = true,
        pausedByUs = true,
        isMusicActiveAtEndStart = false,
      ),
    )
    assertTrue(
      ExternalMediaController.shouldAttemptResume(
        startedWithActiveMedia = true,
        pauseDispatched = true,
        pausedByUs = false,
        isMusicActiveAtEndStart = false,
      ),
    )
    assertFalse(
      ExternalMediaController.shouldAttemptResume(
        startedWithActiveMedia = true,
        pauseDispatched = true,
        pausedByUs = false,
        isMusicActiveAtEndStart = true,
      ),
    )
    assertFalse(
      ExternalMediaController.shouldAttemptResume(
        startedWithActiveMedia = true,
        pauseDispatched = false,
        pausedByUs = true,
        isMusicActiveAtEndStart = false,
      ),
    )
    assertFalse(
      ExternalMediaController.shouldAttemptResume(
        startedWithActiveMedia = false,
        pauseDispatched = true,
        pausedByUs = true,
        isMusicActiveAtEndStart = false,
      ),
    )
  }

  @Test
  fun `matches expected session id when absent or equal and rejects mismatches`() {
    assertTrue(ExternalMediaController.isExpectedSession(expectedSessionId = null, activeSessionId = 4L))
    assertTrue(ExternalMediaController.isExpectedSession(expectedSessionId = 4L, activeSessionId = 4L))
    assertFalse(ExternalMediaController.isExpectedSession(expectedSessionId = 5L, activeSessionId = 4L))
  }
}
