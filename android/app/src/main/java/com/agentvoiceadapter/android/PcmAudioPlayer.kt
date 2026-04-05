package com.agentvoiceadapter.android

import android.content.Context
import android.os.Build
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin

class PcmAudioPlayer(context: Context) {
  private data class QueuedPcmChunk(
    val turnId: String,
    val bytes: ByteArray,
    val sampleRate: Int,
    val durationMs: Long,
    val epoch: Long,
  )

  @Volatile
  var speechEnabled: Boolean = true

  private enum class FocusMode {
    NONE,
    PLAYBACK,
    CAPTURE,
  }

  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val mainHandler = Handler(Looper.getMainLooper())
  private val abandonPlaybackFocusRunnable = Runnable { releasePlaybackFocusIfIdle() }
  private val playbackDrainTimeoutRunnable = Runnable {
    synchronized(this) {
      completePendingPlaybackDrainNoLock()
    }
  }
  private val playbackDrainCheckRunnable = Runnable {
    synchronized(this) {
      maybeResolvePlaybackDrainNoLock()
    }
  }

  private val focusChangeListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        stop()
      }

      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        track?.setVolume(0.35f)
      }

      AudioManager.AUDIOFOCUS_GAIN -> {
        track?.setVolume(1f)
      }
    }
  }

  private val playbackFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build(),
    )
    .setWillPauseWhenDucked(true)
    .setOnAudioFocusChangeListener(focusChangeListener, mainHandler)
    .build()

  private val captureFocusRequest = AudioFocusRequest.Builder(
    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
  )
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build(),
    )
    .setWillPauseWhenDucked(true)
    .setOnAudioFocusChangeListener(focusChangeListener, mainHandler)
    .build()

  private var focusMode: FocusMode = FocusMode.NONE
  @Volatile
  private var continuousReservationEnabled: Boolean = true
  @Volatile
  private var continuousReservationActive: Boolean = false
  private var track: AudioTrack? = null
  private var sampleRate: Int = 0
  @Volatile
  private var ttsGain: Float = 1f
  @Volatile
  private var recognitionCueGain: Float = 1f
  @Volatile
  private var playbackStartupPrerollMs: Int = AdapterDefaults.PLAYBACK_STARTUP_PREROLL_MS
  @Volatile
  private var playbackBufferMs: Int = AdapterDefaults.PLAYBACK_BUFFER_MS
  @Volatile
  private var estimatedPlaybackEndElapsedMs: Long = 0L
  private var framesWrittenForTrack: Int = 0
  private var pendingPlaybackDrainCallback: (() -> Unit)? = null
  private var lastStartupPrerollTurnKey: String? = null
  private val queueLock = Object()
  private val queuedPcm = ArrayDeque<QueuedPcmChunk>()
  @Volatile
  private var queuedPcmBytes: Int = 0
  @Volatile
  private var queuedPcmDurationMs: Long = 0L
  @Volatile
  private var writeInProgressDurationMs: Long = 0L
  @Volatile
  private var playbackQueueCapacityMs: Int =
    resolvePlaybackQueueCapacityMs(AdapterDefaults.PLAYBACK_BUFFER_MS)
  @Volatile
  private var playbackWorkerRunning: Boolean = true
  @Volatile
  private var playbackEpoch: Long = 0L
  private val playbackWorkerThread = Thread(
    { playbackWorkerLoop() },
    "PcmAudioPlayerPlayback",
  ).apply {
    isDaemon = true
    start()
  }
  private val playbackPositionUpdateListener = object : AudioTrack.OnPlaybackPositionUpdateListener {
    override fun onMarkerReached(track: AudioTrack) {
      synchronized(this@PcmAudioPlayer) {
        completePendingPlaybackDrainNoLock()
      }
    }

    override fun onPeriodicNotification(track: AudioTrack) {
      // no-op
    }
  }

  fun setContinuousReservationEnabled(enabled: Boolean) {
    continuousReservationEnabled = enabled
    if (!enabled) {
      continuousReservationActive = false
    }
  }

  fun setTtsGain(gain: Float) {
    ttsGain = gain.coerceIn(0.25f, 5.0f)
  }

  fun setRecognitionCueGain(gain: Float) {
    recognitionCueGain = gain.coerceIn(0.25f, 5.0f)
  }

  fun setPlaybackStartupPrerollMs(ms: Int) {
    playbackStartupPrerollMs = ms.coerceIn(0, 2_000)
  }

  fun setPlaybackBufferMs(ms: Int) {
    val normalized = ms.coerceIn(100, 30_000)
    playbackBufferMs = normalized
    synchronized(queueLock) {
      playbackQueueCapacityMs = resolvePlaybackQueueCapacityMs(normalized)
      queueLock.notifyAll()
    }
  }

  fun playBase64Chunk(turnId: String, chunkBase64: String, requestedSampleRate: Int) {
    if (!speechEnabled) {
      return
    }

    val bytes = try {
      Base64.decode(chunkBase64, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
      return
    }

    if (bytes.isEmpty()) {
      return
    }

    val outputRate = if (requestedSampleRate > 0) requestedSampleRate else 24_000
    val adjustedBytes = applySoftwareGain(bytes, ttsGain)
    val bytesForQueue = synchronized(this) {
      if (!shouldApplyStartupPrerollForTurnNoLock(turnId)) {
        adjustedBytes
      } else {
        val prerollBytes = buildStartupPrerollPcmNoLock(outputRate)
        if (prerollBytes.isEmpty()) {
          adjustedBytes
        } else {
          ByteArray(prerollBytes.size + adjustedBytes.size).also { combined ->
            System.arraycopy(prerollBytes, 0, combined, 0, prerollBytes.size)
            System.arraycopy(adjustedBytes, 0, combined, prerollBytes.size, adjustedBytes.size)
          }
        }
      }
    }
    enqueuePcmChunk(turnId = turnId, bytes = bytesForQueue, sampleRate = outputRate)
  }

  private fun enqueuePcmChunk(turnId: String, bytes: ByteArray, sampleRate: Int) {
    if (bytes.isEmpty()) {
      return
    }
    val durationMs = estimateDurationMs(bytes.size, sampleRate)
    val chunkEpoch = playbackEpoch
    synchronized(queueLock) {
      if (chunkEpoch != playbackEpoch) {
        return
      }
      val queueCapacityBytes = resolvePlaybackQueueCapacityBytes(sampleRate)
      while (
        playbackWorkerRunning &&
        speechEnabled &&
        queuedPcm.isNotEmpty() &&
        queuedPcmBytes + bytes.size > queueCapacityBytes
      ) {
        try {
          queueLock.wait(PLAYBACK_QUEUE_WAIT_STEP_MS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          return
        }
      }
      if (!playbackWorkerRunning || !speechEnabled) {
        return
      }
      queuedPcm.addLast(
        QueuedPcmChunk(
          turnId = turnId,
          bytes = bytes,
          sampleRate = sampleRate,
          durationMs = durationMs,
          epoch = chunkEpoch,
        ),
      )
      queuedPcmBytes += bytes.size
      queuedPcmDurationMs += durationMs
      queueLock.notifyAll()
    }
  }

  private fun playbackWorkerLoop() {
    while (true) {
      val nextChunk = synchronized(queueLock) {
        while (queuedPcm.isEmpty() && playbackWorkerRunning) {
          try {
            queueLock.wait()
          } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return
          }
        }
        if (!playbackWorkerRunning) {
          return
        }
        val chunk = queuedPcm.removeFirst()
        queuedPcmBytes = (queuedPcmBytes - chunk.bytes.size).coerceAtLeast(0)
        queuedPcmDurationMs = (queuedPcmDurationMs - chunk.durationMs).coerceAtLeast(0L)
        writeInProgressDurationMs = chunk.durationMs
        queueLock.notifyAll()
        chunk
      }
      writeQueuedChunk(nextChunk)
    }
  }

  private fun writeQueuedChunk(chunk: QueuedPcmChunk) {
    var offset = 0
    var trackUnavailableRetryCount = 0
    while (playbackWorkerRunning && speechEnabled && chunk.epoch == playbackEpoch && offset < chunk.bytes.size) {
      val activeTrack = synchronized(this) {
        if (chunk.epoch != playbackEpoch) {
          null
        } else
        if (!requestPlaybackFocusIfNeeded()) {
          null
        } else if (!ensureTrack(chunk.sampleRate)) {
          null
        } else {
          track
        }
      }

      if (activeTrack == null) {
        trackUnavailableRetryCount += 1
        if (trackUnavailableRetryCount <= PLAYBACK_TRACK_UNAVAILABLE_LOG_LIMIT) {
          Log.w(
            TAG,
            "playback_worker_track_unavailable turnId=${chunk.turnId} sampleRate=${chunk.sampleRate} retry=$trackUnavailableRetryCount",
          )
        }
        try {
          Thread.sleep(PLAYBACK_TRACK_RETRY_DELAY_MS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          break
        }
        continue
      }

      val writeCount = try {
        activeTrack.write(chunk.bytes, offset, chunk.bytes.size - offset)
      } catch (error: Exception) {
        Log.w(
          TAG,
          "playback_worker_write_failed turnId=${chunk.turnId} sampleRate=${chunk.sampleRate} offset=$offset",
          error,
        )
        synchronized(this) {
          stopTrackOnlyNoLock()
        }
        try {
          Thread.sleep(PLAYBACK_TRACK_RETRY_DELAY_MS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          break
        }
        continue
      }

      if (writeCount <= 0) {
        Log.w(
          TAG,
          "playback_worker_write_non_positive turnId=${chunk.turnId} sampleRate=${chunk.sampleRate} offset=$offset writeCount=$writeCount",
        )
        synchronized(this) {
          stopTrackOnlyNoLock()
        }
        try {
          Thread.sleep(PLAYBACK_TRACK_RETRY_DELAY_MS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          break
        }
        continue
      }

      offset += writeCount
      synchronized(this) {
        notePlaybackWriteNoLock(writeCount, chunk.sampleRate)
        schedulePlaybackFocusRelease()
      }
    }

    if (chunk.epoch != playbackEpoch && offset < chunk.bytes.size) {
      Log.i(
        TAG,
        "playback_worker_chunk_aborted turnId=${chunk.turnId} epoch=${chunk.epoch} currentEpoch=$playbackEpoch offset=$offset size=${chunk.bytes.size}",
      )
    }

    synchronized(queueLock) {
      writeInProgressDurationMs = 0L
      queueLock.notifyAll()
    }
    synchronized(this) {
      if (pendingPlaybackDrainCallback != null) {
        mainHandler.removeCallbacks(playbackDrainCheckRunnable)
        mainHandler.post(playbackDrainCheckRunnable)
      }
    }
  }

  @Synchronized
  fun beginRecognitionCaptureFocus(): Boolean {
    mainHandler.removeCallbacks(abandonPlaybackFocusRunnable)
    return when (focusMode) {
      FocusMode.CAPTURE -> true
      FocusMode.PLAYBACK -> {
        val granted = requestCaptureFocusNoLock()
        if (granted) {
          abandonPlaybackFocusNoLock()
        }
        granted
      }

      FocusMode.NONE -> requestCaptureFocusNoLock()
    }
  }

  @Synchronized
  fun endRecognitionCaptureFocus() {
    if (focusMode == FocusMode.CAPTURE) {
      abandonCaptureFocusNoLock()
      if (continuousReservationActive) {
        requestPlaybackFocusIfNeeded()
      }
    }
  }

  @Synchronized
  fun beginContinuousReservation() {
    if (!continuousReservationEnabled) {
      return
    }
    continuousReservationActive = true
    mainHandler.removeCallbacks(abandonPlaybackFocusRunnable)
    if (focusMode == FocusMode.NONE) {
      requestPlaybackFocusIfNeeded()
    }
  }

  @Synchronized
  fun endContinuousReservation() {
    if (!continuousReservationEnabled) {
      return
    }
    continuousReservationActive = false
    if (focusMode == FocusMode.PLAYBACK) {
      schedulePlaybackFocusRelease()
    }
  }

  @Synchronized
  fun playCueProbe(success: Boolean = true): Boolean {
    logCueProbeState("start", success, null, null)
    if (!requestPlaybackFocusIfNeeded()) {
      logCueProbeState("focus_denied", success, null, null)
      return false
    }

    val outputRate = resolveCueOutputRateNoLock()
    if (!ensureTrack(outputRate)) {
      logCueProbeState("track_unavailable", success, null, null)
      return false
    }
    resetTrackBufferForProbeNoLock()
    val cueBytes = generateCueProbePcm(outputRate, success)
    // Use a nonlinear loudness curve so the cue gain slider has a more noticeable range,
    // while keeping hard safety bounds to avoid harsh clipping across routes/devices.
    val probeGain = resolveRecognitionCueProbeGainNoLock()
    val adjustedCueBytes = applySoftwareGain(cueBytes, probeGain)
    val prerollBytes = buildStartupPrerollPcmNoLock(outputRate)
    val adjustedBytes =
      if (prerollBytes.isEmpty()) {
        adjustedCueBytes
      } else {
        ByteArray(prerollBytes.size + adjustedCueBytes.size).also { combined ->
          System.arraycopy(prerollBytes, 0, combined, 0, prerollBytes.size)
          System.arraycopy(adjustedCueBytes, 0, combined, prerollBytes.size, adjustedCueBytes.size)
        }
      }
    val bytesWritten = track?.write(adjustedBytes, 0, adjustedBytes.size) ?: -1
    logCueProbeState("write", success, bytesWritten, probeGain)
    if (bytesWritten > 0) {
      scheduleCueProbePostWriteCheckNoLock(
        success = success,
        expectedFrames = bytesWritten / 2,
        outputRate = outputRate,
        probeGain = probeGain,
        replayAttempt = 0,
      )
    }
    notePlaybackWriteNoLock(adjustedBytes.size, outputRate)
    schedulePlaybackFocusRelease()
    return true
  }

  @Synchronized
  fun estimatedPlaybackRemainingMs(): Long {
    val now = SystemClock.elapsedRealtime()
    val trackRemainingMs = (estimatedPlaybackEndElapsedMs - now).coerceAtLeast(0L)
    val queueRemainingMs = synchronized(queueLock) {
      (queuedPcmDurationMs + writeInProgressDurationMs).coerceAtLeast(0L)
    }
    return (trackRemainingMs + queueRemainingMs).coerceAtLeast(0L)
  }

  @Synchronized
  fun onPlaybackDrained(onDrained: () -> Unit) {
    pendingPlaybackDrainCallback = onDrained
    mainHandler.removeCallbacks(playbackDrainCheckRunnable)
    mainHandler.post(playbackDrainCheckRunnable)
  }

  @Synchronized
  fun stop() {
    advancePlaybackEpochNoLock()
    clearQueuedPcmQueueNoLock()
    stopTrackOnlyNoLock()
    mainHandler.removeCallbacks(abandonPlaybackFocusRunnable)
    if (focusMode == FocusMode.PLAYBACK && !continuousReservationActive) {
      abandonPlaybackFocusNoLock()
    }
  }

  fun muteCurrentOutput() {
    try {
      track?.setVolume(0f)
    } catch (_: Exception) {
      // no-op
    }
  }

  @Synchronized
  fun interruptCurrentOutput() {
    advancePlaybackEpochNoLock()
    clearQueuedPcmQueueNoLock()
    val activeTrack = track ?: return
    try {
      activeTrack.pause()
      activeTrack.flush()
    } catch (_: Exception) {
      // no-op
    }
  }

  fun release() {
    playbackWorkerRunning = false
    synchronized(queueLock) {
      queueLock.notifyAll()
    }
    synchronized(this) {
      advancePlaybackEpochNoLock()
      clearQueuedPcmQueueNoLock()
      stopTrackOnlyNoLock()
      mainHandler.removeCallbacks(abandonPlaybackFocusRunnable)
      when (focusMode) {
        FocusMode.PLAYBACK -> abandonPlaybackFocusNoLock()
        FocusMode.CAPTURE -> abandonCaptureFocusNoLock()
        FocusMode.NONE -> {
          // no-op
        }
      }
    }
    try {
      playbackWorkerThread.join(PLAYBACK_WORKER_JOIN_TIMEOUT_MS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  @Synchronized
  private fun clearQueuedPcmQueueNoLock() {
    synchronized(queueLock) {
      queuedPcm.clear()
      queuedPcmBytes = 0
      queuedPcmDurationMs = 0L
      writeInProgressDurationMs = 0L
      queueLock.notifyAll()
    }
  }

  @Synchronized
  private fun advancePlaybackEpochNoLock() {
    playbackEpoch = (playbackEpoch + 1L).coerceAtLeast(0L)
  }

  @Synchronized
  private fun maybeResolvePlaybackDrainNoLock() {
    if (pendingPlaybackDrainCallback == null) {
      return
    }

    val queueActive = synchronized(queueLock) {
      queuedPcm.isNotEmpty() || writeInProgressDurationMs > 0L
    }
    if (queueActive) {
      mainHandler.removeCallbacks(playbackDrainCheckRunnable)
      mainHandler.postDelayed(playbackDrainCheckRunnable, PLAYBACK_DRAIN_CHECK_INTERVAL_MS)
      return
    }

    val activeTrack = track
    if (activeTrack == null || framesWrittenForTrack <= 0) {
      completePendingPlaybackDrainNoLock()
      return
    }

    if (activeTrack.playbackHeadPosition >= framesWrittenForTrack) {
      completePendingPlaybackDrainNoLock()
      return
    }

    activeTrack.setNotificationMarkerPosition(framesWrittenForTrack)
    schedulePlaybackDrainTimeoutNoLock()

    mainHandler.removeCallbacks(playbackDrainCheckRunnable)
    mainHandler.postDelayed(playbackDrainCheckRunnable, PLAYBACK_DRAIN_CHECK_INTERVAL_MS)
  }

  @Synchronized
  private fun resolvePlaybackQueueCapacityBytes(sampleRate: Int): Int {
    return resolvePlaybackQueueCapacityBytes(
      sampleRate = sampleRate,
      playbackQueueCapacityMs = playbackQueueCapacityMs,
    )
  }

  @Synchronized
  private fun estimateDurationMs(byteCount: Int, sampleRate: Int): Long {
    return estimateDurationMsForPcm16(byteCount = byteCount, sampleRate = sampleRate)
  }

  @Synchronized
  private fun resolvePlaybackQueueCapacityMs(playbackBufferMs: Int): Int {
    return PcmAudioPlayer.resolvePlaybackQueueCapacityMs(playbackBufferMs = playbackBufferMs)
  }

  @Synchronized
  private fun ensureTrack(rate: Int): Boolean {
    if (track != null && sampleRate == rate && track?.state == AudioTrack.STATE_INITIALIZED) {
      return true
    }

    stopTrackOnlyNoLock()

    val channelConfig = AudioFormat.CHANNEL_OUT_MONO
    val encoding = AudioFormat.ENCODING_PCM_16BIT
    val minBuffer = AudioTrack.getMinBufferSize(rate, channelConfig, encoding)
    if (minBuffer <= 0) {
      Log.w(TAG, "audio_track_init_failed reason=min_buffer rate=$rate minBuffer=$minBuffer")
      return false
    }
    val targetBufferBytes = ((rate.toLong() * 2L * playbackBufferMs) / 1_000L)
      .coerceIn(1L, Int.MAX_VALUE.toLong())
      .toInt()
    val bufferSize = max(minBuffer, targetBufferBytes)

    val newTrack = try {
      AudioTrack(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
        AudioFormat.Builder()
          .setSampleRate(rate)
          .setEncoding(encoding)
          .setChannelMask(channelConfig)
          .build(),
        bufferSize,
        AudioTrack.MODE_STREAM,
        AudioManager.AUDIO_SESSION_ID_GENERATE,
      )
    } catch (e: Exception) {
      Log.w(TAG, "audio_track_init_failed reason=constructor rate=$rate", e)
      return false
    }

    if (newTrack.state != AudioTrack.STATE_INITIALIZED) {
      Log.w(TAG, "audio_track_init_failed reason=uninitialized rate=$rate state=${newTrack.state}")
      try {
        newTrack.release()
      } catch (_: Exception) {
        // no-op
      }
      return false
    }

    try {
      newTrack.setPlaybackPositionUpdateListener(playbackPositionUpdateListener, mainHandler)
      newTrack.setVolume(1f)
      newTrack.play()
      Log.i(
        TAG,
        "audio_track_init_success rate=$rate minBuffer=$minBuffer targetBufferBytes=$targetBufferBytes bufferSize=$bufferSize playbackBufferMs=$playbackBufferMs queueCapacityMs=$playbackQueueCapacityMs queueCapacityBytes=${resolvePlaybackQueueCapacityBytes(rate)}",
      )
    } catch (e: Exception) {
      Log.w(TAG, "audio_track_init_failed reason=play rate=$rate", e)
      try {
        newTrack.release()
      } catch (_: Exception) {
        // no-op
      }
      return false
    }

    track = newTrack
    sampleRate = rate
    framesWrittenForTrack = 0
    return true
  }

  @Synchronized
  private fun requestPlaybackFocusIfNeeded(): Boolean {
    return when (focusMode) {
      FocusMode.CAPTURE -> {
        abandonCaptureFocusNoLock()
        requestPlaybackFocusNoLock()
      }
      FocusMode.PLAYBACK -> true
      FocusMode.NONE -> requestPlaybackFocusNoLock()
    }
  }

  @Synchronized
  private fun requestCaptureFocusNoLock(): Boolean {
    val result = audioManager.requestAudioFocus(captureFocusRequest)
    val granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (granted) {
      focusMode = FocusMode.CAPTURE
    }
    return granted
  }

  @Synchronized
  private fun requestPlaybackFocusNoLock(): Boolean {
    val result = audioManager.requestAudioFocus(playbackFocusRequest)
    val granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    if (granted) {
      focusMode = FocusMode.PLAYBACK
    }
    return granted
  }

  @Synchronized
  private fun abandonPlaybackFocusNoLock() {
    audioManager.abandonAudioFocusRequest(playbackFocusRequest)
    if (focusMode == FocusMode.PLAYBACK) {
      focusMode = FocusMode.NONE
    }
  }

  @Synchronized
  private fun abandonCaptureFocusNoLock() {
    audioManager.abandonAudioFocusRequest(captureFocusRequest)
    if (focusMode == FocusMode.CAPTURE) {
      focusMode = FocusMode.NONE
    }
  }

  @Synchronized
  private fun releasePlaybackFocusIfIdle() {
    if (focusMode == FocusMode.PLAYBACK) {
      abandonPlaybackFocusNoLock()
    }
  }

  @Synchronized
  private fun schedulePlaybackFocusRelease() {
    if (continuousReservationActive) {
      return
    }
    if (focusMode != FocusMode.PLAYBACK) {
      return
    }
    mainHandler.removeCallbacks(abandonPlaybackFocusRunnable)
    mainHandler.postDelayed(abandonPlaybackFocusRunnable, 1_400)
  }

  @Synchronized
  private fun stopTrackOnlyNoLock() {
    val pendingDrain = pendingPlaybackDrainCallback
    pendingPlaybackDrainCallback = null
    mainHandler.removeCallbacks(playbackDrainTimeoutRunnable)
    mainHandler.removeCallbacks(playbackDrainCheckRunnable)
    try {
      track?.pause()
      track?.flush()
      track?.release()
    } catch (_: Exception) {
      // no-op
    } finally {
      track = null
      sampleRate = 0
      estimatedPlaybackEndElapsedMs = 0L
      framesWrittenForTrack = 0
    }
    pendingDrain?.let { callback ->
      mainHandler.post(callback)
    }
  }

  @Synchronized
  private fun resetTrackBufferForProbeNoLock() {
    try {
      track?.pause()
      track?.flush()
      track?.play()
      framesWrittenForTrack = 0
      estimatedPlaybackEndElapsedMs = 0L
    } catch (_: Exception) {
      // no-op
    }
  }

  @Synchronized
  private fun notePlaybackWriteNoLock(byteCount: Int, rate: Int) {
    if (byteCount <= 0 || rate <= 0) {
      return
    }
    val sampleCount = byteCount / 2L
    if (sampleCount <= 0L) {
      return
    }
    val writeDurationMs = (sampleCount * 1_000L) / rate.toLong()
    if (writeDurationMs <= 0L) {
      return
    }
    val now = SystemClock.elapsedRealtime()
    val base = maxOf(now, estimatedPlaybackEndElapsedMs)
    estimatedPlaybackEndElapsedMs = base + writeDurationMs
    framesWrittenForTrack =
      (framesWrittenForTrack + sampleCount.toInt()).coerceAtMost(Int.MAX_VALUE - 1)
  }

  @Synchronized
  private fun shouldApplyStartupPrerollForTurnNoLock(turnId: String): Boolean {
    val prerollMs = playbackStartupPrerollMs.coerceIn(0, 2_000)
    if (prerollMs <= 0) {
      return false
    }
    val normalizedTurnId = turnId.trim().ifEmpty { UNKNOWN_TTS_TURN_KEY }
    val shouldApply = normalizedTurnId != lastStartupPrerollTurnKey
    if (shouldApply) {
      lastStartupPrerollTurnKey = normalizedTurnId
    }
    return shouldApply
  }

  @Synchronized
  private fun buildStartupPrerollPcmNoLock(rate: Int): ByteArray {
    val prerollMs = playbackStartupPrerollMs.coerceIn(0, 2_000)
    if (prerollMs <= 0 || rate <= 0) {
      return ByteArray(0)
    }
    val sampleCount = ((rate.toLong() * prerollMs.toLong()) / 1_000L).toInt()
    if (sampleCount <= 0) {
      return ByteArray(0)
    }
    return ByteArray(sampleCount * 2)
  }

  @Synchronized
  private fun schedulePlaybackDrainTimeoutNoLock() {
    val remainingMs = estimatedPlaybackRemainingMs()
    val timeoutMs = resolvePlaybackDrainTimeoutMs(remainingMs = remainingMs)
    mainHandler.removeCallbacks(playbackDrainTimeoutRunnable)
    mainHandler.postDelayed(playbackDrainTimeoutRunnable, timeoutMs)
  }

  @Synchronized
  private fun resolveRecognitionCueProbeGainNoLock(): Float {
    return resolveRecognitionCueProbeGain(recognitionCueGain = recognitionCueGain)
  }

  @Synchronized
  private fun completePendingPlaybackDrainNoLock() {
    val callback = pendingPlaybackDrainCallback ?: return
    pendingPlaybackDrainCallback = null
    mainHandler.removeCallbacks(playbackDrainTimeoutRunnable)
    mainHandler.removeCallbacks(playbackDrainCheckRunnable)
    mainHandler.post(callback)
  }

  private fun applySoftwareGain(input: ByteArray, gain: Float): ByteArray {
    return applySoftwareGainPcm16(input = input, gain = gain)
  }

  private fun generateCueProbePcm(sampleRate: Int, success: Boolean): ByteArray {
    return generateCueProbePcmData(sampleRate = sampleRate, success = success)
  }

  @Synchronized
  private fun logCueProbeState(
    stage: String,
    success: Boolean,
    writeResult: Int?,
    probeGain: Float?,
  ) {
    val musicVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
    val musicVolumeMax = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    val musicMuted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      audioManager.isStreamMute(AudioManager.STREAM_MUSIC)
    } else {
      false
    }
    val playbackState = track?.playState ?: -1
    val playbackHeadPosition = track?.playbackHeadPosition ?: -1
    val routedDevice = describeRoutedDeviceNoLock()
    Log.i(
      TAG,
      "cue_probe stage=$stage success=$success writeResult=${writeResult ?: "n/a"} probeGain=${probeGain ?: "n/a"} focusMode=$focusMode continuousReservationActive=$continuousReservationActive speechEnabled=$speechEnabled ttsGain=$ttsGain streamVolume=$musicVolume/$musicVolumeMax streamMuted=$musicMuted audioMode=${audioManager.mode} isMusicActive=${audioManager.isMusicActive} trackPlayState=$playbackState trackHead=$playbackHeadPosition routedDevice=$routedDevice",
    )
  }

  private fun describeRoutedDeviceNoLock(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      return "unavailable"
    }
    val routed = track?.routedDevice ?: return "none"
    return "${routed.type}:${routed.productName}"
  }

  @Synchronized
  private fun resolveCueOutputRateNoLock(): Int {
    val raw = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)
    return resolveCueOutputRate(rawSampleRate = raw)
  }

  @Synchronized
  private fun scheduleCueProbePostWriteCheckNoLock(
    success: Boolean,
    expectedFrames: Int,
    outputRate: Int,
    probeGain: Float,
    replayAttempt: Int,
  ) {
    mainHandler.postDelayed(
      {
        synchronized(this) {
          val head = track?.playbackHeadPosition ?: -1
          val playState = track?.playState ?: -1
          val advanced = head > 0
          Log.i(
            TAG,
            "cue_probe stage=post_write_check success=$success expectedFrames=$expectedFrames playbackHead=$head advanced=$advanced replayAttempt=$replayAttempt trackPlayState=$playState focusMode=$focusMode routedDevice=${describeRoutedDeviceNoLock()}",
          )
          if (!advanced && replayAttempt < CUE_PROBE_MAX_REPLAY_ATTEMPTS) {
            Log.w(
              TAG,
              "cue_probe stage=post_write_replay_trigger success=$success replayAttempt=$replayAttempt reason=head_not_advancing",
            )
            stopTrackOnlyNoLock()
            if (!ensureTrack(outputRate)) {
              logCueProbeState("replay_track_unavailable", success, null, probeGain)
              return@synchronized
            }
            val replayBytes = applySoftwareGain(generateCueProbePcm(outputRate, success), probeGain)
            val replayWrite = track?.write(replayBytes, 0, replayBytes.size) ?: -1
            logCueProbeState("replay_write", success, replayWrite, probeGain)
            if (replayWrite > 0) {
              notePlaybackWriteNoLock(replayBytes.size, outputRate)
              scheduleCueProbePostWriteCheckNoLock(
                success = success,
                expectedFrames = replayWrite / 2,
                outputRate = outputRate,
                probeGain = probeGain,
                replayAttempt = replayAttempt + 1,
              )
              schedulePlaybackFocusRelease()
            }
          }
        }
      },
      CUE_PROBE_POST_WRITE_CHECK_DELAY_MS,
    )
  }

  companion object {
    private const val TAG = "PcmAudioPlayer"
    private const val CUE_PROBE_POST_WRITE_CHECK_DELAY_MS = 220L
    private const val CUE_PROBE_MAX_REPLAY_ATTEMPTS = 1
    private const val PLAYBACK_QUEUE_WAIT_STEP_MS = 80L
    private const val PLAYBACK_TRACK_RETRY_DELAY_MS = 24L
    private const val PLAYBACK_TRACK_UNAVAILABLE_LOG_LIMIT = 6
    private const val PLAYBACK_DRAIN_CHECK_INTERVAL_MS = 70L
    private const val PLAYBACK_DRAIN_TIMEOUT_PADDING_MS = 320L
    private const val PLAYBACK_DRAIN_TIMEOUT_MIN_MS = 450L
    private const val PLAYBACK_DRAIN_TIMEOUT_MAX_MS = 8_000L
    private const val MIN_PLAYBACK_QUEUE_CAPACITY_BYTES = 256 * 1024
    private const val PLAYBACK_QUEUE_CAPACITY_MULTIPLIER = 6
    private const val MIN_PLAYBACK_QUEUE_CAPACITY_MS = 5_000
    private const val MAX_PLAYBACK_QUEUE_CAPACITY_MS = 120_000
    private const val PLAYBACK_WORKER_JOIN_TIMEOUT_MS = 1_000L
    private const val UNKNOWN_TTS_TURN_KEY = "__unknown_tts_turn__"

    internal fun resolvePlaybackQueueCapacityMs(playbackBufferMs: Int): Int {
      return (playbackBufferMs * PLAYBACK_QUEUE_CAPACITY_MULTIPLIER)
        .coerceIn(MIN_PLAYBACK_QUEUE_CAPACITY_MS, MAX_PLAYBACK_QUEUE_CAPACITY_MS)
    }

    internal fun resolvePlaybackQueueCapacityBytes(
      sampleRate: Int,
      playbackQueueCapacityMs: Int,
    ): Int {
      val resolvedRate = if (sampleRate > 0) sampleRate else 24_000
      val candidate = ((resolvedRate.toLong() * 2L * playbackQueueCapacityMs.toLong()) / 1_000L)
        .coerceIn(MIN_PLAYBACK_QUEUE_CAPACITY_BYTES.toLong(), Int.MAX_VALUE.toLong())
      return candidate.toInt()
    }

    internal fun estimateDurationMsForPcm16(byteCount: Int, sampleRate: Int): Long {
      if (byteCount <= 0 || sampleRate <= 0) {
        return 0L
      }
      val sampleCount = byteCount / 2L
      if (sampleCount <= 0L) {
        return 0L
      }
      return ((sampleCount * 1_000L) / sampleRate.toLong()).coerceAtLeast(1L)
    }

    internal fun resolvePlaybackDrainTimeoutMs(remainingMs: Long): Long {
      return (remainingMs + PLAYBACK_DRAIN_TIMEOUT_PADDING_MS)
        .coerceIn(PLAYBACK_DRAIN_TIMEOUT_MIN_MS, PLAYBACK_DRAIN_TIMEOUT_MAX_MS)
    }

    internal fun resolveRecognitionCueProbeGain(recognitionCueGain: Float): Float {
      val normalized = ((recognitionCueGain.coerceIn(0.25f, 5.0f) - 0.25f) / 4.75f)
        .coerceIn(0f, 1f)
      val cueGainDb = -16.0 + (normalized.toDouble() * 28.0)
      return 10.0.pow(cueGainDb / 20.0).toFloat().coerceIn(0.15f, 4.0f)
    }

    internal fun resolveCueOutputRate(rawSampleRate: String?): Int {
      val parsed = rawSampleRate?.toIntOrNull()
      return parsed?.coerceIn(16_000, 48_000) ?: 48_000
    }

    internal fun applySoftwareGainPcm16(input: ByteArray, gain: Float): ByteArray {
      if (abs(gain - 1f) < 0.001f) {
        return input
      }

      val output = input.copyOf()
      var index = 0
      while (index + 1 < output.size) {
        val low = output[index].toInt() and 0xFF
        val high = output[index + 1].toInt()
        val sample = (high shl 8) or low
        val scaled = (sample * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
        output[index] = (scaled and 0xFF).toByte()
        output[index + 1] = ((scaled shr 8) and 0xFF).toByte()
        index += 2
      }

      return output
    }

    internal fun generateCueProbePcmData(sampleRate: Int, success: Boolean): ByteArray {
      if (sampleRate <= 0) {
        return ByteArray(0)
      }

      val segments =
        if (success) {
          listOf(
            Triple(523.25, 95, 0.14f),
            Triple(0.0, 55, 0.0f),
            Triple(659.25, 140, 0.16f),
          )
        } else {
          listOf(
            Triple(659.25, 105, 0.14f),
            Triple(0.0, 55, 0.0f),
            Triple(493.88, 140, 0.16f),
          )
        }

      val totalSamples = segments.sumOf { (_, durationMs, _) ->
        (sampleRate * durationMs) / 1000
      }
      val pcm = ByteArray(totalSamples * 2)
      var sampleOffset = 0

      segments.forEach { (frequency, durationMs, amplitude) ->
        val segmentSamples = (sampleRate * durationMs) / 1000
        for (index in 0 until segmentSamples) {
          val fadeWindow = (sampleRate / 80).coerceAtLeast(12)
          val fadeIn = (index.toFloat() / fadeWindow.toFloat()).coerceIn(0f, 1f)
          val fadeOut = ((segmentSamples - index).toFloat() / fadeWindow.toFloat()).coerceIn(0f, 1f)
          val envelope = minOf(fadeIn, fadeOut)
          val value =
            if (frequency <= 0.0 || amplitude <= 0f) {
              0.0
            } else {
              sin((2.0 * PI * frequency * index.toDouble()) / sampleRate.toDouble()) *
                (Short.MAX_VALUE.toDouble() * amplitude.toDouble() * envelope.toDouble())
            }
          val sample = value.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
          val byteIndex = (sampleOffset + index) * 2
          pcm[byteIndex] = (sample and 0xFF).toByte()
          pcm[byteIndex + 1] = ((sample shr 8) and 0xFF).toByte()
        }
        sampleOffset += segmentSamples
      }

      return pcm
    }
  }
}
