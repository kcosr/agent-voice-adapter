package com.agentvoiceadapter.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import kotlin.math.max

class MicPcmStreamer(private val context: Context) {
  companion object {
    private const val TAG = "MicPcmStreamer"
  }

  private data class CaptureResources(
    val token: MicCaptureSessionGate.Token,
    val audioRecord: AudioRecord,
    val shouldUseCommunicationSource: Boolean,
    val onStopped: () -> Unit,
    @Volatile var thread: Thread? = null,
  )

  private val sessionGate = MicCaptureSessionGate()
  private val resourcesLock = Any()
  private val resourcesBySequence = mutableMapOf<Long, CaptureResources>()
  private var preferredDeviceId: Int? = null
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  fun isRunningFor(requestId: String): Boolean {
    return sessionGate.isRunningFor(requestId)
  }

  fun setPreferredDeviceId(deviceId: String) {
    preferredDeviceId = deviceId.toIntOrNull()
  }

  fun start(
    requestId: String,
    onStarted: (sampleRate: Int, channels: Int, encoding: String) -> Unit,
    onRouteResolved: (String) -> Unit,
    onChunk: (ByteArray) -> Unit,
    onStopped: () -> Unit,
  ): Boolean {
    if (
      ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.RECORD_AUDIO,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }

    val token = sessionGate.tryStart(requestId) ?: return false

    val sampleRate = 16_000
    val channelConfig = AudioFormat.CHANNEL_IN_MONO
    val encoding = AudioFormat.ENCODING_PCM_16BIT
    val preferredDevice = preferredDeviceId?.let { AudioDeviceUtils.findInputDevice(context, it) }
    val shouldUseCommunicationSource = preferredDevice?.let { device ->
      device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
        device.type == AudioDeviceInfo.TYPE_BLE_HEADSET
    } == true
    val audioSource = if (shouldUseCommunicationSource) {
      MediaRecorder.AudioSource.VOICE_COMMUNICATION
    } else {
      MediaRecorder.AudioSource.VOICE_RECOGNITION
    }

    if (shouldUseCommunicationSource) {
      try {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isBluetoothScoOn = true
        audioManager.startBluetoothSco()
      } catch (error: Exception) {
        Log.w(TAG, "failed to start bluetooth SCO", error)
      }
    }

    val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfig, encoding)
    if (minBuffer <= 0) {
      sessionGate.finish(token)
      if (shouldUseCommunicationSource) {
        stopScoRouting()
      }
      return false
    }

    val bufferSize = max(minBuffer, sampleRate / 5)
    val audioRecord = AudioRecord(
      audioSource,
      sampleRate,
      channelConfig,
      encoding,
      bufferSize,
    )

    if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
      audioRecord.release()
      sessionGate.finish(token)
      if (shouldUseCommunicationSource) {
        stopScoRouting()
      }
      return false
    }

    if (preferredDevice != null) {
      try {
        val assigned = audioRecord.setPreferredDevice(preferredDevice)
        if (!assigned) {
          Log.w(TAG, "preferred mic device was not applied: $preferredDeviceId")
        }
      } catch (error: Exception) {
        Log.w(TAG, "failed to apply preferred mic device: $preferredDeviceId", error)
      }
    }

    val resources = CaptureResources(
      token = token,
      audioRecord = audioRecord,
      shouldUseCommunicationSource = shouldUseCommunicationSource,
      onStopped = onStopped,
    )
    synchronized(resourcesLock) {
      resourcesBySequence[token.sequence] = resources
    }

    resources.thread = Thread {
      val readBuffer = ByteArray(bufferSize)
      try {
        audioRecord.startRecording()
        onStarted(sampleRate, 1, "pcm_s16le")
        onRouteResolved(AudioDeviceUtils.describeInputDevice(audioRecord.routedDevice))

        while (sessionGate.shouldContinue(token)) {
          val count = audioRecord.read(readBuffer, 0, readBuffer.size)
          if (count <= 0) {
            Log.w(TAG, "mic capture read ended requestId=$requestId count=$count")
            break
          }
          val chunk = readBuffer.copyOf(count)
          onChunk(chunk)
        }
      } catch (_: Exception) {
        // no-op
      } finally {
        completeCapture(resources)
      }
    }.apply {
      name = "mic-stream-$requestId"
      isDaemon = true
      start()
    }

    return true
  }

  fun stop(requestId: String? = null) {
    val token = sessionGate.requestStop(requestId) ?: return
    val resources = synchronized(resourcesLock) {
      resourcesBySequence[token.sequence]
    } ?: return

    val captureThread = resources.thread
    try {
      captureThread?.join(600)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }

    // Some devices can leave AudioRecord.read blocked past the normal stop window.
    // If that happens, force-close the recorder so the mic indicator and input path recover.
    if (captureThread == null || !captureThread.isAlive) {
      return
    }

    Log.w(TAG, "force-stopping stuck capture thread requestId=${token.requestId}")
    try {
      resources.audioRecord.stop()
    } catch (_: Exception) {
      // no-op
    }
    try {
      resources.audioRecord.release()
    } catch (_: Exception) {
      // no-op
    }

    if (resources.shouldUseCommunicationSource) {
      stopScoRouting()
    }
    synchronized(resourcesLock) {
      resourcesBySequence.remove(token.sequence)
    }
    if (sessionGate.finish(token)) {
      try {
        resources.onStopped()
      } catch (_: Exception) {
        // no-op
      }
    }
  }

  private fun completeCapture(resources: CaptureResources) {
    try {
      resources.audioRecord.stop()
    } catch (_: Exception) {
      // no-op
    }
    try {
      resources.audioRecord.release()
    } catch (_: Exception) {
      // no-op
    }
    if (resources.shouldUseCommunicationSource) {
      stopScoRouting()
    }
    synchronized(resourcesLock) {
      resourcesBySequence.remove(resources.token.sequence)
    }
    if (sessionGate.finish(resources.token)) {
      try {
        resources.onStopped()
      } catch (_: Exception) {
        // no-op
      }
    }
  }

  private fun stopScoRouting() {
    try {
      audioManager.stopBluetoothSco()
      audioManager.isBluetoothScoOn = false
      audioManager.mode = AudioManager.MODE_NORMAL
    } catch (_: Exception) {
      // no-op
    }
  }
}
