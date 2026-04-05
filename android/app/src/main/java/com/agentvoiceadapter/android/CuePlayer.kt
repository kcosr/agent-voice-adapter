package com.agentvoiceadapter.android

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import kotlin.math.max

class CuePlayer(context: Context) {
  private data class CueSpec(
    val repetitions: Int,
    val gapMs: Int,
    val holdFocusMs: Int,
  )

  private val lock = Any()
  private val appContext = context.applicationContext
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val cueHandler = Handler(Looper.getMainLooper())
  private val cueFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build(),
    )
    .setWillPauseWhenDucked(false)
    .build()

  private val cueAudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()
  private val notificationSoundUri = resolveNotificationSoundUri()
  private var focusHeld = false
  private var ringtone: Ringtone? = null
  private var playbackToken = 0

  @Suppress("UNUSED_PARAMETER")
  fun setGainMultiplier(multiplier: Float) {
    // Ringtone playback does not expose stable per-playback gain control; keep API stable.
  }

  fun playWakeCue() {
    playPattern(CueSpec(repetitions = 1, gapMs = 0, holdFocusMs = 850))
  }

  fun release() {
    synchronized(lock) {
      playbackToken += 1
      cueHandler.removeCallbacksAndMessages(null)
      stopRingtoneLocked()
      abandonFocusIfHeldLocked()
    }
  }

  private fun playPattern(cue: CueSpec) {
    if (cue.repetitions <= 0) {
      return
    }

    val soundUri = notificationSoundUri
    if (soundUri == null) {
      return
    }

    val token: Int
    synchronized(lock) {
      playbackToken += 1
      token = playbackToken
      cueHandler.removeCallbacksAndMessages(null)
      stopRingtoneLocked()
      requestFocusLocked()
    }

    var delayMs = 0L
    repeat(cue.repetitions) {
      cueHandler.postDelayed(
        {
          synchronized(lock) {
            if (playbackToken != token) {
              return@postDelayed
            }
            playNotificationOnceLocked(soundUri)
          }
        },
        delayMs,
      )
      delayMs += cue.gapMs.toLong()
    }

    val releaseDelay = max(delayMs, cue.holdFocusMs.toLong())
    cueHandler.postDelayed(
      {
        synchronized(lock) {
          if (playbackToken != token) {
            return@postDelayed
          }
          stopRingtoneLocked()
          abandonFocusIfHeldLocked()
        }
      },
      releaseDelay,
    )
  }

  private fun requestFocusLocked() {
    if (focusHeld) {
      return
    }
    val result = audioManager.requestAudioFocus(cueFocusRequest)
    focusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocusIfHeldLocked() {
    if (!focusHeld) {
      return
    }
    audioManager.abandonAudioFocusRequest(cueFocusRequest)
    focusHeld = false
  }

  private fun playNotificationOnceLocked(soundUri: Uri) {
    try {
      stopRingtoneLocked()
      ringtone = RingtoneManager.getRingtone(appContext, soundUri)?.apply {
        audioAttributes = cueAudioAttributes
        play()
      }
    } catch (_: Exception) {
      // no-op
    }
  }

  private fun stopRingtoneLocked() {
    try {
      ringtone?.stop()
    } catch (_: Exception) {
      // no-op
    }
    ringtone = null
  }

  private fun resolveNotificationSoundUri(): Uri? {
    return RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
  }
}
