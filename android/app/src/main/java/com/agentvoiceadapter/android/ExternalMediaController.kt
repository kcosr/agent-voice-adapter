package com.agentvoiceadapter.android

import android.content.Context
import android.media.AudioManager
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent

class ExternalMediaController(context: Context) {
  data class SessionResult(
    val sessionId: Long,
    val isMusicActiveAtStart: Boolean,
    val pauseDispatchCount: Int,
    val isMusicActiveAfterPauseAttempts: Boolean,
    val pausedByUs: Boolean,
  )

  data class EndResult(
    val hadActiveSession: Boolean,
    val wasPausedByUs: Boolean,
    val playDispatched: Boolean,
    val isMusicActiveAtEnd: Boolean,
  )

  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var sessionIdCounter = 0L
  private var activeSessionId = 0L

  @Volatile
  private var sessionActive = false
  @Volatile
  private var pausedByUs = false
  @Volatile
  private var startedWithActiveMedia = false
  @Volatile
  private var pauseDispatched = false

  @Synchronized
  fun beginSession(): SessionResult {
    if (sessionActive) {
      Log.i(
        TAG,
        "media_ctrl_begin_reuse sessionId=$activeSessionId isMusicActive=${audioManager.isMusicActive} pausedByUs=$pausedByUs",
      )
      return SessionResult(
        sessionId = activeSessionId,
        isMusicActiveAtStart = audioManager.isMusicActive,
        pauseDispatchCount = 0,
        isMusicActiveAfterPauseAttempts = audioManager.isMusicActive,
        pausedByUs = pausedByUs,
      )
    }
    sessionActive = true
    sessionIdCounter += 1
    activeSessionId = sessionIdCounter
    pausedByUs = false
    startedWithActiveMedia = false
    pauseDispatched = false

    val activeAtStart = audioManager.isMusicActive
    Log.i(
      TAG,
      "media_ctrl_begin sessionId=$activeSessionId isMusicActiveAtStart=$activeAtStart",
    )
    startedWithActiveMedia = activeAtStart
    var dispatchCount = 0
    var activeAfterPause = activeAtStart
    if (activeAtStart) {
      for (attempt in 1..MAX_PAUSE_ATTEMPTS) {
        dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE)
        pauseDispatched = true
        dispatchCount += 1
        waitForPausePropagation()
        activeAfterPause = audioManager.isMusicActive
        pausedByUs = shouldMarkPausedByUs(
          isMusicActiveAtStart = activeAtStart,
          isMusicActiveAfterPause = activeAfterPause,
        )
        Log.i(
          TAG,
          "media_ctrl_pause_attempt sessionId=$activeSessionId attempt=$attempt/$MAX_PAUSE_ATTEMPTS activeAfter=$activeAfterPause pausedByUs=$pausedByUs",
        )
        if (!activeAfterPause) {
          break
        }
      }
    }

    return SessionResult(
      sessionId = activeSessionId,
      isMusicActiveAtStart = activeAtStart,
      pauseDispatchCount = dispatchCount,
      isMusicActiveAfterPauseAttempts = activeAfterPause,
      pausedByUs = pausedByUs,
    )
  }

  @Synchronized
  fun endSession(expectedSessionId: Long? = null): EndResult {
    if (!sessionActive) {
      Log.i(
        TAG,
        "media_ctrl_end_no_session isMusicActive=${audioManager.isMusicActive}",
      )
      return EndResult(
        hadActiveSession = false,
        wasPausedByUs = false,
        playDispatched = false,
        isMusicActiveAtEnd = audioManager.isMusicActive,
      )
    }
    if (!isExpectedSession(expectedSessionId, activeSessionId)) {
      Log.i(
        TAG,
        "media_ctrl_end_skip expectedSessionId=$expectedSessionId activeSessionId=$activeSessionId",
      )
      return EndResult(
        hadActiveSession = false,
        wasPausedByUs = false,
        playDispatched = false,
        isMusicActiveAtEnd = audioManager.isMusicActive,
      )
    }
    sessionActive = false
    val sessionId = activeSessionId
    activeSessionId = 0L

    val wasPaused = pausedByUs
    val isMusicActiveAtEndStart = audioManager.isMusicActive
    val shouldAttemptResume = shouldAttemptResume(
      startedWithActiveMedia = startedWithActiveMedia,
      pauseDispatched = pauseDispatched,
      pausedByUs = pausedByUs,
      isMusicActiveAtEndStart = isMusicActiveAtEndStart,
    )
    Log.i(
      TAG,
      "media_ctrl_end sessionId=$sessionId startedWithActiveMedia=$startedWithActiveMedia pausedByUs=$pausedByUs pauseDispatched=$pauseDispatched shouldAttemptResume=$shouldAttemptResume isMusicActiveAtEndStart=$isMusicActiveAtEndStart",
    )
    var playDispatched = false
    if (shouldAttemptResume) {
      var activeBefore = isMusicActiveAtEndStart
      for (attempt in 1..MAX_PLAY_ATTEMPTS) {
        if (activeBefore) {
          Log.i(
            TAG,
            "media_ctrl_play_attempt_skip sessionId=$sessionId attempt=$attempt/$MAX_PLAY_ATTEMPTS reason=already_active",
          )
          break
        }
        dispatchMediaKey(KeyEvent.KEYCODE_MEDIA_PLAY)
        playDispatched = true
        waitForPlayPropagation()
        val activeAfter = audioManager.isMusicActive
        val resumedFromInactive = !activeBefore && activeAfter
        Log.i(
          TAG,
          "media_ctrl_play_attempt sessionId=$sessionId attempt=$attempt/$MAX_PLAY_ATTEMPTS activeBefore=$activeBefore activeAfter=$activeAfter resumedFromInactive=$resumedFromInactive",
        )
        if (resumedFromInactive || activeAfter) {
          break
        }
        activeBefore = activeAfter
      }
    }
    pausedByUs = false
    startedWithActiveMedia = false
    pauseDispatched = false

    return EndResult(
      hadActiveSession = true,
      wasPausedByUs = wasPaused,
      playDispatched = playDispatched,
      isMusicActiveAtEnd = audioManager.isMusicActive,
    )
  }

  @Synchronized
  fun cancelSession(expectedSessionId: Long? = null) {
    if (!isExpectedSession(expectedSessionId, activeSessionId)) {
      Log.i(
        TAG,
        "media_ctrl_cancel_skip expectedSessionId=$expectedSessionId activeSessionId=$activeSessionId",
      )
      return
    }
    Log.i(
      TAG,
      "media_ctrl_cancel sessionId=$activeSessionId pausedByUs=$pausedByUs startedWithActiveMedia=$startedWithActiveMedia pauseDispatched=$pauseDispatched",
    )
    sessionActive = false
    pausedByUs = false
    startedWithActiveMedia = false
    pauseDispatched = false
    activeSessionId = 0L
  }

  fun isMusicActiveNow(): Boolean = audioManager.isMusicActive

  private fun dispatchMediaKey(keyCode: Int) {
    val eventTime = SystemClock.uptimeMillis()
    val down = KeyEvent(eventTime, eventTime, KeyEvent.ACTION_DOWN, keyCode, 0)
    val up = KeyEvent(eventTime, eventTime, KeyEvent.ACTION_UP, keyCode, 0)
    audioManager.dispatchMediaKeyEvent(down)
    audioManager.dispatchMediaKeyEvent(up)
  }

  private fun waitForPausePropagation() {
    try {
      Thread.sleep(PAUSE_SETTLE_MS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  private fun waitForPlayPropagation() {
    try {
      Thread.sleep(PLAY_SETTLE_MS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  companion object {
    private const val TAG = "ExternalMediaController"
    private const val MAX_PAUSE_ATTEMPTS = 3
    private const val PAUSE_SETTLE_MS = 120L
    private const val MAX_PLAY_ATTEMPTS = 3
    private const val PLAY_SETTLE_MS = 140L

    internal fun shouldMarkPausedByUs(
      isMusicActiveAtStart: Boolean,
      isMusicActiveAfterPause: Boolean,
    ): Boolean {
      return isMusicActiveAtStart && !isMusicActiveAfterPause
    }

    internal fun shouldAttemptResume(
      startedWithActiveMedia: Boolean,
      pauseDispatched: Boolean,
      pausedByUs: Boolean,
      isMusicActiveAtEndStart: Boolean,
    ): Boolean {
      return startedWithActiveMedia && pauseDispatched && (pausedByUs || !isMusicActiveAtEndStart)
    }

    internal fun isExpectedSession(expectedSessionId: Long?, activeSessionId: Long): Boolean {
      return expectedSessionId == null || expectedSessionId == activeSessionId
    }
  }
}
