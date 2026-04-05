package com.agentvoiceadapter.android

import android.content.Context

data class AdapterRuntimeConfig(
  val apiBaseUrl: String,
  val acceptingTurns: Boolean,
  val speechEnabled: Boolean,
  val listeningEnabled: Boolean,
  val wakeEnabled: Boolean,
  val selectedMicDeviceId: String,
  val continuousFocusEnabled: Boolean,
  val pauseExternalMediaEnabled: Boolean,
  val recognitionCueMode: String,
  val ttsGain: Float,
  val recognitionCueGain: Float,
  val playbackStartupPrerollMs: Int,
  val playbackBufferMs: Int,
)

object RecognitionCueModes {
  const val OFF = "off"
  const val ALWAYS = "always"
  const val MEDIA_INACTIVE_ONLY = "media_inactive_only"

  fun normalize(raw: String?): String {
    return when (raw?.trim()?.lowercase()) {
      OFF -> OFF
      ALWAYS -> ALWAYS
      MEDIA_INACTIVE_ONLY -> MEDIA_INACTIVE_ONLY
      else -> AdapterDefaults.RECOGNITION_CUE_MODE
    }
  }
}

object AdapterDefaults {
  const val API_BASE_URL = "http://10.0.2.2:4300"
  const val ACCEPTING_TURNS = true
  const val SPEECH_ENABLED = true
  const val LISTENING_ENABLED = true
  const val WAKE_ENABLED = false
  const val SELECTED_MIC_DEVICE_ID = ""
  const val CONTINUOUS_FOCUS_ENABLED = true
  const val PAUSE_EXTERNAL_MEDIA_ENABLED = false
  const val RECOGNITION_CUE_MODE = RecognitionCueModes.MEDIA_INACTIVE_ONLY
  const val TTS_GAIN = 1.0f
  const val RECOGNITION_CUE_GAIN = 1.0f
  const val PLAYBACK_STARTUP_PREROLL_MS = 200
  const val PLAYBACK_BUFFER_MS = 500
}

object AdapterPrefs {
  private const val FILE_NAME = "agent_voice_adapter_prefs"
  private const val KEY_API_BASE_URL = "api_base_url"
  private const val KEY_ACCEPTING_TURNS = "accepting_turns"
  private const val KEY_SPEECH_ENABLED = "speech_enabled"
  private const val KEY_LISTENING_ENABLED = "listening_enabled"
  private const val KEY_WAKE_ENABLED = "wake_enabled"
  private const val KEY_SELECTED_MIC_DEVICE_ID = "selected_mic_device_id"
  private const val KEY_CONTINUOUS_FOCUS_ENABLED = "continuous_focus_enabled"
  private const val KEY_PAUSE_EXTERNAL_MEDIA_ENABLED = "pause_external_media_enabled"
  private const val KEY_RECOGNITION_CUE_MODE = "recognition_cue_mode"
  private const val KEY_TTS_GAIN = "tts_gain"
  private const val KEY_RECOGNITION_CUE_GAIN = "recognition_cue_gain"
  private const val KEY_PLAYBACK_STARTUP_PREROLL_MS = "playback_startup_preroll_ms"
  private const val KEY_PLAYBACK_BUFFER_MS = "playback_buffer_ms"

  fun load(context: Context): AdapterRuntimeConfig {
    val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    return AdapterRuntimeConfig(
      apiBaseUrl = prefs.getString(KEY_API_BASE_URL, AdapterDefaults.API_BASE_URL)
        ?.trim()
        ?.ifEmpty { AdapterDefaults.API_BASE_URL }
        ?: AdapterDefaults.API_BASE_URL,
      acceptingTurns = prefs.getBoolean(KEY_ACCEPTING_TURNS, AdapterDefaults.ACCEPTING_TURNS),
      speechEnabled = prefs.getBoolean(KEY_SPEECH_ENABLED, AdapterDefaults.SPEECH_ENABLED),
      listeningEnabled = prefs.getBoolean(KEY_LISTENING_ENABLED, AdapterDefaults.LISTENING_ENABLED),
      wakeEnabled = prefs.getBoolean(KEY_WAKE_ENABLED, AdapterDefaults.WAKE_ENABLED),
      selectedMicDeviceId = prefs.getString(
        KEY_SELECTED_MIC_DEVICE_ID,
        AdapterDefaults.SELECTED_MIC_DEVICE_ID,
      )?.trim().orEmpty(),
      continuousFocusEnabled = prefs.getBoolean(
        KEY_CONTINUOUS_FOCUS_ENABLED,
        AdapterDefaults.CONTINUOUS_FOCUS_ENABLED,
      ),
      pauseExternalMediaEnabled = prefs.getBoolean(
        KEY_PAUSE_EXTERNAL_MEDIA_ENABLED,
        AdapterDefaults.PAUSE_EXTERNAL_MEDIA_ENABLED,
      ),
      recognitionCueMode = RecognitionCueModes.normalize(
        prefs.getString(KEY_RECOGNITION_CUE_MODE, AdapterDefaults.RECOGNITION_CUE_MODE),
      ),
      ttsGain = prefs.getFloat(KEY_TTS_GAIN, AdapterDefaults.TTS_GAIN).coerceIn(0.25f, 5.0f),
      recognitionCueGain = prefs.getFloat(
        KEY_RECOGNITION_CUE_GAIN,
        AdapterDefaults.RECOGNITION_CUE_GAIN,
      ).coerceIn(0.25f, 5.0f),
      playbackStartupPrerollMs = prefs.getInt(
        KEY_PLAYBACK_STARTUP_PREROLL_MS,
        AdapterDefaults.PLAYBACK_STARTUP_PREROLL_MS,
      ).coerceIn(0, 2_000),
      playbackBufferMs = prefs.getInt(
        KEY_PLAYBACK_BUFFER_MS,
        AdapterDefaults.PLAYBACK_BUFFER_MS,
      ).coerceIn(100, 30_000),
    )
  }

  fun save(context: Context, config: AdapterRuntimeConfig) {
    val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    prefs.edit()
      .putString(KEY_API_BASE_URL, config.apiBaseUrl)
      .putBoolean(KEY_ACCEPTING_TURNS, config.acceptingTurns)
      .putBoolean(KEY_SPEECH_ENABLED, config.speechEnabled)
      .putBoolean(KEY_LISTENING_ENABLED, config.listeningEnabled)
      .putBoolean(KEY_WAKE_ENABLED, config.wakeEnabled)
      .putString(KEY_SELECTED_MIC_DEVICE_ID, config.selectedMicDeviceId)
      .putBoolean(KEY_CONTINUOUS_FOCUS_ENABLED, config.continuousFocusEnabled)
      .putBoolean(KEY_PAUSE_EXTERNAL_MEDIA_ENABLED, config.pauseExternalMediaEnabled)
      .putString(KEY_RECOGNITION_CUE_MODE, RecognitionCueModes.normalize(config.recognitionCueMode))
      .putFloat(KEY_TTS_GAIN, config.ttsGain.coerceIn(0.25f, 5.0f))
      .putFloat(KEY_RECOGNITION_CUE_GAIN, config.recognitionCueGain.coerceIn(0.25f, 5.0f))
      .putInt(
        KEY_PLAYBACK_STARTUP_PREROLL_MS,
        config.playbackStartupPrerollMs.coerceIn(0, 2_000),
      )
      .putInt(
        KEY_PLAYBACK_BUFFER_MS,
        config.playbackBufferMs.coerceIn(100, 30_000),
      )
      .apply()
  }
}
