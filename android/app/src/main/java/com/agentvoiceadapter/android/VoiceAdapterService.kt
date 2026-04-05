package com.agentvoiceadapter.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

class VoiceAdapterService : Service() {
  companion object {
    private const val TAG = "VoiceAdapterService"
    private const val CHANNEL_ID = "agent_voice_adapter_channel"
    private const val NOTIFICATION_ID = 4301

    private const val EXTRA_API_BASE_URL = "api_base_url"
    private const val EXTRA_ACCEPTING_TURNS = "accepting_turns"
    private const val EXTRA_SPEECH_ENABLED = "speech_enabled"
    private const val EXTRA_LISTENING_ENABLED = "listening_enabled"
    private const val EXTRA_WAKE_ENABLED = "wake_enabled"
    private const val EXTRA_SELECTED_MIC_DEVICE_ID = "selected_mic_device_id"
    private const val EXTRA_CONTINUOUS_FOCUS_ENABLED = "continuous_focus_enabled"
    private const val EXTRA_PAUSE_EXTERNAL_MEDIA_ENABLED = "pause_external_media_enabled"
    private const val EXTRA_RECOGNITION_CUE_MODE = "recognition_cue_mode"
    private const val EXTRA_TTS_GAIN = "tts_gain"
    private const val EXTRA_RECOGNITION_CUE_GAIN = "recognition_cue_gain"
    private const val EXTRA_PLAYBACK_STARTUP_PREROLL_MS = "playback_startup_preroll_ms"
    private const val EXTRA_PLAYBACK_BUFFER_MS = "playback_buffer_ms"
    private const val EXTRA_ABORT_TURN_ID = "abort_turn_id"
    private const val EXTRA_STOP_TTS_TURN_ID = "stop_tts_turn_id"
    private const val EXTRA_QUICK_REPLY_TURN_ID = "quick_reply_turn_id"
    private const val EXTRA_QUICK_REPLY_TEXT = "quick_reply_text"
    private const val EXTRA_QUICK_REPLY_ID = "quick_reply_id"
    private const val EXTRA_ACTIVE_AGENT_SESSION_ID = "active_agent_session_id"
    private const val EXTRA_ACTIVE_AGENT_WORKSPACE = "active_agent_workspace"
    private const val EXTRA_ACTIVE_AGENT_TITLE = "active_agent_title"
    private const val EXTRA_ACTIVE_AGENT_QUOTED_ASSISTANT_TEXT = "active_agent_quoted_assistant_text"
    private const val EXTRA_ACTIVE_AGENT_SEND_VERBATIM = "active_agent_send_verbatim"

    const val ACTION_START = "com.agentvoiceadapter.android.action.START"
    const val ACTION_STOP = "com.agentvoiceadapter.android.action.STOP"
    const val ACTION_UPDATE = "com.agentvoiceadapter.android.action.UPDATE"
    const val ACTION_SNAPSHOT = "com.agentvoiceadapter.android.action.SNAPSHOT"
    const val ACTION_CAPTURE_ACTIVE_AGENT = "com.agentvoiceadapter.android.action.CAPTURE_ACTIVE_AGENT"
    const val ACTION_LOOPBACK = "com.agentvoiceadapter.android.action.LOOPBACK"
    const val ACTION_TEST_CUE = "com.agentvoiceadapter.android.action.TEST_CUE"
    const val ACTION_ABORT_TURN = "com.agentvoiceadapter.android.action.ABORT_TURN"
    const val ACTION_STOP_TTS = "com.agentvoiceadapter.android.action.STOP_TTS"
    const val ACTION_SEND_QUICK_REPLY = "com.agentvoiceadapter.android.action.SEND_QUICK_REPLY"
    const val ACTION_ACTIVATE_CLIENT = "com.agentvoiceadapter.android.action.ACTIVATE_CLIENT"
    const val ACTION_DEACTIVATE_CLIENT = "com.agentvoiceadapter.android.action.DEACTIVATE_CLIENT"
    const val ACTION_EVENT = "com.agentvoiceadapter.android.action.EVENT"

    const val EVENT_TYPE_STATUS = "status"
    const val EVENT_TYPE_BUBBLE = "bubble"
    const val EVENT_TYPE_MIC_ROUTE = "mic_route"
    const val EVENT_TYPE_LISTENING_STATE = "listening_state"
    const val EVENT_TYPE_RUNTIME_STATE = "runtime_state"
    const val EVENT_TYPE_ACTIVE_CLIENT_STATE = "active_client_state"
    const val EVENT_TYPE_ACTIVE_AGENT_CAPTURE_STATE = "active_agent_capture_state"

    const val EXTRA_EVENT_TYPE = "event_type"
    const val EXTRA_EVENT_MESSAGE = "event_message"
    private const val WS_IDLE_HEARTBEAT_ENABLED = true
    private const val WS_IDLE_HEARTBEAT_CHECK_MS = 5_000L
    private const val WS_IDLE_HEARTBEAT_IDLE_MS = 20_000L
    private const val WS_IDLE_HEARTBEAT_TIMEOUT_MS = 10_000L
    private const val WS_IDLE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 2
    private const val WS_IDLE_HEARTBEAT_STATUS_THROTTLE_MS = 30_000L
    private const val RETRY_CAPTURE_RESTART_DELAY_MS = 140L
    private const val RETRY_CAPTURE_RESTART_MAX_ATTEMPTS = 4
    private const val CAPTURE_SEND_FAILURE_RESTART_THRESHOLD = 3
    private const val CAPTURE_RECOVERY_DELAY_MS = 220L
    private const val CAPTURE_RECOVERY_MAX_ATTEMPTS = 3
    private const val TURN_CAPTURE_WATCHDOG_MS = 70_000L
    private const val TURN_START_MAIN_SYNC_TIMEOUT_MS = 1_500L
    private const val STOP_TTS_SUPPRESSION_TTL_MS = 5 * 60_000L
    private const val STOP_TTS_SUPPRESSION_MAX_ENTRIES = 256

    internal fun foregroundServiceTypeForCapture(hasActiveCapture: Boolean): Int {
      val playback = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      return if (hasActiveCapture) {
        playback or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      } else {
        playback
      }
    }

    internal fun shouldEndExternalMediaSessionOnConfigUpdate(
      wasPauseExternalMediaEnabled: Boolean,
      isPauseExternalMediaEnabled: Boolean,
    ): Boolean = wasPauseExternalMediaEnabled && !isPauseExternalMediaEnabled

    internal fun listeningSnapshotState(
      activeTurnCaptureId: String?,
      activeAmbientCaptureId: String? = null,
      activeAgentCaptureId: String? = null,
    ): String =
      if (activeTurnCaptureId != null || activeAmbientCaptureId != null || activeAgentCaptureId != null) {
        "active"
      } else {
        "inactive"
      }

    internal fun cancellationReasonFromListenResult(
      success: Boolean,
      canceled: Boolean,
      cancelReason: String,
      rawError: String,
    ): String? {
      if (success) {
        return null
      }

      val normalizedCancelReason = cancelReason.trim()
      if (canceled || normalizedCancelReason.isNotEmpty()) {
        if (normalizedCancelReason.isNotEmpty()) {
          return normalizedCancelReason
        }
        return "canceled"
      }

      if (rawError.equals("canceled", ignoreCase = true)) {
        return "request_disconnected"
      }
      if (rawError.equals("Turn owner socket closed before completion", ignoreCase = true)) {
        return "owner_socket_closed"
      }
      return null
    }

    internal fun stopTtsSuppressionTurnIdsToClear(
      markedAtByTurnId: Map<String, Long>,
      nowElapsedMs: Long,
      ttlMs: Long = STOP_TTS_SUPPRESSION_TTL_MS,
      maxEntries: Int = STOP_TTS_SUPPRESSION_MAX_ENTRIES,
    ): Set<String> {
      if (markedAtByTurnId.isEmpty()) {
        return emptySet()
      }

      val normalizedTtlMs = ttlMs.coerceAtLeast(0L)
      val normalizedMaxEntries = maxEntries.coerceAtLeast(0)
      val turnIdsToClear = linkedSetOf<String>()

      for ((turnId, markedAtMs) in markedAtByTurnId) {
        if (nowElapsedMs - markedAtMs >= normalizedTtlMs) {
          turnIdsToClear.add(turnId)
        }
      }

      val remainingEntries = markedAtByTurnId.entries
        .asSequence()
        .filter { entry -> !turnIdsToClear.contains(entry.key) }
        .sortedBy { entry -> entry.value }
        .toList()

      val overflow = remainingEntries.size - normalizedMaxEntries
      if (overflow > 0) {
        remainingEntries
          .take(overflow)
          .forEach { entry -> turnIdsToClear.add(entry.key) }
      }

      return turnIdsToClear
    }

    internal fun resolveRuntimeWsActiveTurnId(
      activeTurnCaptureId: String?,
      activeExternalMediaTurnId: String?,
      pendingTurnRecognitionIds: Collection<String>,
    ): String? {
      val candidate = activeTurnCaptureId ?: activeExternalMediaTurnId
      if (!candidate.isNullOrBlank()) {
        return candidate
      }
      return pendingTurnRecognitionIds.firstOrNull()
    }

    internal fun isInTurnFlowActive(
      activeTurnCaptureId: String?,
      activeAgentCaptureId: String?,
      activeExternalMediaTurnId: String?,
      pendingActiveAgentResultTurnId: String?,
      pendingTurnRecognitionIds: Collection<String>,
    ): Boolean {
      return activeTurnCaptureId != null ||
        activeAgentCaptureId != null ||
        activeExternalMediaTurnId != null ||
        pendingActiveAgentResultTurnId != null ||
        pendingTurnRecognitionIds.isNotEmpty()
    }

    internal fun resolveStopTtsTurnId(
      requestedTurnId: String,
      activeExternalMediaTurnId: String?,
      runtimeWsActiveTurnId: String?,
    ): String? {
      val explicitTurnId = requestedTurnId.trim()
      if (explicitTurnId.isNotEmpty()) {
        return explicitTurnId
      }
      return activeExternalMediaTurnId ?: runtimeWsActiveTurnId
    }

    internal fun resolveAbortTurnId(
      requestedTurnId: String,
      activeTurnCaptureId: String?,
      activeExternalMediaTurnId: String?,
      pendingTurnRecognitionIds: Collection<String>,
    ): String? {
      val explicitTurnId = requestedTurnId.trim()
      if (explicitTurnId.isNotEmpty()) {
        return explicitTurnId
      }
      return activeTurnCaptureId
        ?: activeExternalMediaTurnId
        ?: pendingTurnRecognitionIds.firstOrNull()
    }

    internal fun playbackTerminalTurnIdsToAbortForNewTurn(
      pendingTurnIds: Collection<String>,
      nextTurnId: String,
    ): List<String> {
      return pendingTurnIds.filter { pendingTurnId -> pendingTurnId != nextTurnId }
    }

    internal fun formatLinkedSessionLabel(workspace: String, resolvedTitle: String): String {
      val normalizedWorkspace = workspace.trim()
      val normalizedTitle = resolvedTitle.trim().ifEmpty { "(no title)" }
      return if (normalizedWorkspace.isNotEmpty()) {
        "$normalizedWorkspace, $normalizedTitle"
      } else {
        normalizedTitle
      }
    }

    fun startIntent(context: Context, config: AdapterRuntimeConfig): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_START
        putExtras(config)
      }
    }

    fun updateIntent(context: Context, config: AdapterRuntimeConfig): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_UPDATE
        putExtras(config)
      }
    }

    fun stopIntent(context: Context): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_STOP
      }
    }

    fun snapshotIntent(context: Context): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_SNAPSHOT
      }
    }

    fun loopbackIntent(context: Context, config: AdapterRuntimeConfig): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_LOOPBACK
        putExtras(config)
      }
    }

    fun captureActiveAgentIntent(
      context: Context,
      config: AdapterRuntimeConfig,
      sessionId: String,
      workspace: String,
      resolvedTitle: String,
      quotedAssistantText: String? = null,
      sendVerbatim: Boolean = false,
    ): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_CAPTURE_ACTIVE_AGENT
        putExtras(config)
        putExtra(EXTRA_ACTIVE_AGENT_SESSION_ID, sessionId)
        putExtra(EXTRA_ACTIVE_AGENT_WORKSPACE, workspace)
        putExtra(EXTRA_ACTIVE_AGENT_TITLE, resolvedTitle)
        if (!quotedAssistantText.isNullOrBlank()) {
          putExtra(EXTRA_ACTIVE_AGENT_QUOTED_ASSISTANT_TEXT, quotedAssistantText)
        }
        putExtra(EXTRA_ACTIVE_AGENT_SEND_VERBATIM, sendVerbatim)
      }
    }

    fun testCueIntent(context: Context, config: AdapterRuntimeConfig): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_TEST_CUE
        putExtras(config)
      }
    }

    fun abortTurnIntent(context: Context, config: AdapterRuntimeConfig, turnId: String): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_ABORT_TURN
        putExtras(config)
        putExtra(EXTRA_ABORT_TURN_ID, turnId)
      }
    }

    fun stopTtsIntent(context: Context, config: AdapterRuntimeConfig, turnId: String): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_STOP_TTS
        putExtras(config)
        putExtra(EXTRA_STOP_TTS_TURN_ID, turnId)
      }
    }

    fun quickReplyIntent(
      context: Context,
      config: AdapterRuntimeConfig,
      turnId: String,
      text: String,
      quickReplyId: String? = null,
    ): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_SEND_QUICK_REPLY
        putExtras(config)
        putExtra(EXTRA_QUICK_REPLY_TURN_ID, turnId)
        putExtra(EXTRA_QUICK_REPLY_TEXT, text)
        putExtra(EXTRA_QUICK_REPLY_ID, quickReplyId)
      }
    }

    fun activateClientIntent(context: Context, config: AdapterRuntimeConfig): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_ACTIVATE_CLIENT
        putExtras(config)
      }
    }

    fun deactivateClientIntent(context: Context, config: AdapterRuntimeConfig): Intent {
      return Intent(context, VoiceAdapterService::class.java).apply {
        action = ACTION_DEACTIVATE_CLIENT
        putExtras(config)
      }
    }

    private fun Intent.putExtras(config: AdapterRuntimeConfig) {
      putExtra(EXTRA_API_BASE_URL, config.apiBaseUrl)
      putExtra(EXTRA_ACCEPTING_TURNS, config.acceptingTurns)
      putExtra(EXTRA_SPEECH_ENABLED, config.speechEnabled)
      putExtra(EXTRA_LISTENING_ENABLED, config.listeningEnabled)
      putExtra(EXTRA_WAKE_ENABLED, config.wakeEnabled)
      putExtra(EXTRA_SELECTED_MIC_DEVICE_ID, config.selectedMicDeviceId)
      putExtra(EXTRA_CONTINUOUS_FOCUS_ENABLED, config.continuousFocusEnabled)
      putExtra(EXTRA_PAUSE_EXTERNAL_MEDIA_ENABLED, config.pauseExternalMediaEnabled)
      putExtra(EXTRA_RECOGNITION_CUE_MODE, config.recognitionCueMode)
      putExtra(EXTRA_TTS_GAIN, config.ttsGain)
      putExtra(EXTRA_RECOGNITION_CUE_GAIN, config.recognitionCueGain)
      putExtra(EXTRA_PLAYBACK_STARTUP_PREROLL_MS, config.playbackStartupPrerollMs)
      putExtra(EXTRA_PLAYBACK_BUFFER_MS, config.playbackBufferMs)
    }
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val reconnectRunnable = Runnable { connectWebSocket() }
  private val idleHeartbeatRunnable = Runnable { runIdleHeartbeatCheck() }
  private val restartAmbientRunnable = Runnable { maybeStartAmbientCapture() }
  private val wakeTriggerPattern = Pattern.compile("\\b(agent|assistant)\\b", Pattern.CASE_INSENSITIVE)

  private val httpClient = OkHttpClient.Builder()
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .pingInterval(0, TimeUnit.MILLISECONDS)
    .build()

  private val wakeIntentClient = OkHttpClient.Builder()
    .callTimeout(8, TimeUnit.SECONDS)
    .build()
  private val turnRequestClient = OkHttpClient.Builder()
    .readTimeout(5, TimeUnit.MINUTES)
    .callTimeout(5, TimeUnit.MINUTES)
    .build()
  private val mediaPauseExecutor = Executors.newSingleThreadExecutor()
  private val playbackControlExecutor = Executors.newSingleThreadExecutor()

  private lateinit var player: PcmAudioPlayer
  private lateinit var externalMediaController: ExternalMediaController
  private lateinit var cuePlayer: CuePlayer
  private lateinit var micStreamer: MicPcmStreamer

  private var runtimeConfig = AdapterRuntimeConfig(
    apiBaseUrl = AdapterDefaults.API_BASE_URL,
    acceptingTurns = AdapterDefaults.ACCEPTING_TURNS,
    speechEnabled = AdapterDefaults.SPEECH_ENABLED,
    listeningEnabled = AdapterDefaults.LISTENING_ENABLED,
    wakeEnabled = AdapterDefaults.WAKE_ENABLED,
    selectedMicDeviceId = AdapterDefaults.SELECTED_MIC_DEVICE_ID,
    continuousFocusEnabled = AdapterDefaults.CONTINUOUS_FOCUS_ENABLED,
    pauseExternalMediaEnabled = AdapterDefaults.PAUSE_EXTERNAL_MEDIA_ENABLED,
    recognitionCueMode = AdapterDefaults.RECOGNITION_CUE_MODE,
    ttsGain = AdapterDefaults.TTS_GAIN,
    recognitionCueGain = AdapterDefaults.RECOGNITION_CUE_GAIN,
    playbackStartupPrerollMs = AdapterDefaults.PLAYBACK_STARTUP_PREROLL_MS,
    playbackBufferMs = AdapterDefaults.PLAYBACK_BUFFER_MS,
  )

  private var ws: WebSocket? = null
  private var wsConnected = false
  private var lastSentInTurnState: Boolean? = null
  private var lastSocketActivityElapsedMs = 0L
  private var heartbeatProbeInFlight = false
  private var heartbeatProbeStartedElapsedMs = 0L
  private var heartbeatProbeGeneration = 0L
  private var heartbeatStateGeneration = 0L
  private var heartbeatProbeSentCount = 0
  private var heartbeatProbeResolvedCount = 0
  private var heartbeatProbeTimeoutCount = 0
  private var heartbeatProbeSendFailureCount = 0
  private var heartbeatConsecutiveFailureCount = 0
  private var lastHeartbeatStatusElapsedMs = 0L
  private var stopping = false
  private var runtimeWsState = "stopped"
  private var runtimeAudioState = "idle"
  private var runtimeMediaState = "passthrough"
  private var runtimeMusicState = "unknown"
  private var runtimeClientActive = false
  private var wantActive = false
  private var runtimeActiveClientConnected = false
  private var runtimeConnectedClients = 0
  private var currentForegroundServiceType = -1

  private val turnListenModelById = mutableMapOf<String, String?>()
  private val pendingTurnRecognitionIds = mutableSetOf<String>()
  private val pendingRecognitionCueByTurnId = mutableMapOf<String, Boolean>()
  private val handledRecognitionCueTurnIds = mutableSetOf<String>()
  private val suppressSuccessCueTurnIds = mutableSetOf<String>()
  private val quickReplyCaptureSuppressedTurnIds = mutableSetOf<String>()
  private val locallyCanceledTurnIds = mutableSetOf<String>()
  private val turnsStartedWithMediaActive = mutableSetOf<String>()
  private val externalMediaSessionIdByTurnId = mutableMapOf<String, Long>()
  private val linkedSessionIdByTurnId = mutableMapOf<String, String>()
  private val linkedSessionTitleByTurnId = mutableMapOf<String, String>()
  private val activeAgentSessionIdByCaptureTurnId = mutableMapOf<String, String>()
  private val activeAgentSessionLabelByCaptureTurnId = mutableMapOf<String, String>()
  private val activeAgentQuotedAssistantTextByCaptureTurnId = mutableMapOf<String, String>()
  private val activeAgentSendVerbatimByCaptureTurnId = mutableMapOf<String, Boolean>()
  private val pendingRetryCaptureTurnIds = mutableSetOf<String>()
  private val pendingRetryCaptureAttemptsByTurnId = mutableMapOf<String, Int>()
  private val pendingPlaybackTerminalAckTurnIds = mutableSetOf<String>()
  private val expectedTurnCaptureStopIds = mutableSetOf<String>()
  private val captureChunkSendFailureCountByTurnId = mutableMapOf<String, Int>()
  private val captureRecoveryAttemptsByTurnId = mutableMapOf<String, Int>()
  private val captureRecoveryRunnableByTurnId = mutableMapOf<String, Runnable>()
  private val turnCaptureWatchdogRunnableByTurnId = mutableMapOf<String, Runnable>()
  private val stopTtsTurnIds = ConcurrentHashMap.newKeySet<String>()
  private val stopTtsTurnIdTimestampById = ConcurrentHashMap<String, Long>()
  private var activeTurnCaptureId: String? = null
  private var activeAmbientCaptureId: String? = null
  private var activeAgentCaptureId: String? = null
  private var pendingActiveAgentResultTurnId: String? = null
  private var activeAgentSessionId: String? = null
  private var activeAgentSessionLabel: String = ""
  private var activeAgentQuotedAssistantText: String = ""
  private var activeAgentSendVerbatim: Boolean = false
  private var activeExternalMediaTurnId: String? = null
  private var loopbackTurnInFlight = false
  private val loopbackPromptText =
    "Loopback test. You should hear this assistant message, then speak your response after playback ends."
  private val activeAgentVoiceInstruction =
    "Use the agent-voice-adapter-cli skill to continue the conversation with the user."

  override fun onCreate() {
    super.onCreate()
    lastSocketActivityElapsedMs = SystemClock.elapsedRealtime()
    player = PcmAudioPlayer(this)
    externalMediaController = ExternalMediaController(this)
    cuePlayer = CuePlayer(this)
    micStreamer = MicPcmStreamer(this)
    runtimeConfig = AdapterPrefs.load(this)
    createNotificationChannel()
    val foregroundStarted = applyForegroundServiceType(hasActiveCapture = false, reason = "service_start")
    if (!foregroundStarted) {
      Log.e(TAG, "Failed to enter foreground mode on startup; stopping service")
      stopSelf()
      return
    }
    applyRuntimeConfig(runtimeConfig)
    updateRuntimeState(
      wsState = "connecting",
      audioState = "idle",
      mediaState = "passthrough",
      musicState = "unknown",
      turnId = "",
    )
    emitActiveClientState()
    connectWebSocket()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopSelf()
        return START_NOT_STICKY
      }

      ACTION_START,
      ACTION_UPDATE -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        emitActiveClientState()
        if (ws == null) {
          connectWebSocket()
        } else {
          sendClientState()
          maybeStartAmbientCapture()
        }
        emitRuntimeState()
        emitEvent(
          EVENT_TYPE_LISTENING_STATE,
          listeningSnapshotState(
            activeTurnCaptureId = activeTurnCaptureId,
            activeAmbientCaptureId = activeAmbientCaptureId,
            activeAgentCaptureId = activeAgentCaptureId,
          ),
        )
        emitActiveAgentCaptureState()
      }

      ACTION_SNAPSHOT -> {
        emitActiveClientState()
        emitRuntimeState()
        emitEvent(
          EVENT_TYPE_LISTENING_STATE,
          listeningSnapshotState(
            activeTurnCaptureId = activeTurnCaptureId,
            activeAmbientCaptureId = activeAmbientCaptureId,
            activeAgentCaptureId = activeAgentCaptureId,
          ),
        )
        emitActiveAgentCaptureState()
      }

      ACTION_CAPTURE_ACTIVE_AGENT -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        val requestedSessionId = intent.getStringExtra(EXTRA_ACTIVE_AGENT_SESSION_ID)?.trim().orEmpty()
        val requestedWorkspace = intent.getStringExtra(EXTRA_ACTIVE_AGENT_WORKSPACE)?.trim().orEmpty()
        val requestedTitle = intent.getStringExtra(EXTRA_ACTIVE_AGENT_TITLE)?.trim().orEmpty()
        activeAgentQuotedAssistantText =
          intent.getStringExtra(EXTRA_ACTIVE_AGENT_QUOTED_ASSISTANT_TEXT)?.trim().orEmpty()
        activeAgentSendVerbatim = intent.getBooleanExtra(EXTRA_ACTIVE_AGENT_SEND_VERBATIM, false)
        if (requestedSessionId.isNotEmpty()) {
          activeAgentSessionId = requestedSessionId
          activeAgentSessionLabel = buildActiveAgentLabel(requestedWorkspace, requestedTitle)
        }
        requestActiveAgentCaptureToggle()
      }

      ACTION_LOOPBACK -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        if (ws == null) {
          connectWebSocket()
        } else {
          sendClientState()
          maybeStartAmbientCapture()
        }
        submitLoopbackTurn()
      }

      ACTION_TEST_CUE -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        playManualCue()
      }

      ACTION_ABORT_TURN -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        requestTurnAbort(intent.getStringExtra(EXTRA_ABORT_TURN_ID).orEmpty())
      }

      ACTION_STOP_TTS -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        requestTurnStopTts(intent.getStringExtra(EXTRA_STOP_TTS_TURN_ID).orEmpty())
      }

      ACTION_SEND_QUICK_REPLY -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        requestTurnQuickReply(
          requestedTurnId = intent.getStringExtra(EXTRA_QUICK_REPLY_TURN_ID).orEmpty(),
          quickReplyText = intent.getStringExtra(EXTRA_QUICK_REPLY_TEXT).orEmpty(),
          quickReplyId = intent.getStringExtra(EXTRA_QUICK_REPLY_ID),
        )
      }

      ACTION_ACTIVATE_CLIENT -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        wantActive = true
        requestClientActivation(activate = true)
      }

      ACTION_DEACTIVATE_CLIENT -> {
        val updated = runtimeConfigFromIntent(intent, runtimeConfig)
        AdapterPrefs.save(this, updated)
        applyRuntimeConfig(updated)
        wantActive = false
        forceReleaseLocalCaptureState(
          reason = "manual_deactivate_action",
          requestServerCancel = true,
        )
        requestClientActivation(activate = false)
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    stopping = true
    mainHandler.removeCallbacksAndMessages(null)
    clearIdleHeartbeatState()
    micStreamer.stop()
    pendingRecognitionCueByTurnId.clear()
    handledRecognitionCueTurnIds.clear()
    suppressSuccessCueTurnIds.clear()
    quickReplyCaptureSuppressedTurnIds.clear()
    locallyCanceledTurnIds.clear()
    turnsStartedWithMediaActive.clear()
    externalMediaSessionIdByTurnId.clear()
    linkedSessionIdByTurnId.clear()
    linkedSessionTitleByTurnId.clear()
    activeAgentQuotedAssistantTextByCaptureTurnId.clear()
    activeAgentSendVerbatimByCaptureTurnId.clear()
    pendingRetryCaptureTurnIds.clear()
    pendingRetryCaptureAttemptsByTurnId.clear()
    pendingPlaybackTerminalAckTurnIds.clear()
    stopTtsTurnIds.clear()
    stopTtsTurnIdTimestampById.clear()
    activeAgentCaptureId = null
    pendingActiveAgentResultTurnId = null
    activeAgentQuotedAssistantText = ""
    activeAgentSendVerbatim = false
    clearAllCaptureRecoveryState()
    clearAllTurnCaptureWatchdogs()
    ws?.close(1000, "service destroyed")
    ws = null
    endExternalMediaSession()
    player.release()
    cuePlayer.release()
    wakeIntentClient.dispatcher.executorService.shutdown()
    turnRequestClient.dispatcher.cancelAll()
    turnRequestClient.dispatcher.executorService.shutdown()
    httpClient.dispatcher.executorService.shutdown()
    mediaPauseExecutor.shutdownNow()
    playbackControlExecutor.shutdownNow()
    updateRuntimeState(
      wsState = "stopped",
      audioState = "idle",
      mediaState = "passthrough",
      musicState = "unknown",
      turnId = "",
    )
    runtimeClientActive = false
    runtimeActiveClientConnected = false
    runtimeConnectedClients = 0
    emitActiveClientState()
    emitActiveAgentCaptureState()
    super.onDestroy()
  }

  private fun runtimeConfigFromIntent(
    intent: Intent,
    fallback: AdapterRuntimeConfig,
  ): AdapterRuntimeConfig {
    val url = intent.getStringExtra(EXTRA_API_BASE_URL)?.trim().orEmpty()
    return AdapterRuntimeConfig(
      apiBaseUrl = UrlUtils.normalizeBaseUrl(if (url.isEmpty()) fallback.apiBaseUrl else url),
      acceptingTurns = intent.getBooleanExtra(EXTRA_ACCEPTING_TURNS, fallback.acceptingTurns),
      speechEnabled = intent.getBooleanExtra(EXTRA_SPEECH_ENABLED, fallback.speechEnabled),
      listeningEnabled = intent.getBooleanExtra(EXTRA_LISTENING_ENABLED, fallback.listeningEnabled),
      wakeEnabled = intent.getBooleanExtra(EXTRA_WAKE_ENABLED, fallback.wakeEnabled),
      selectedMicDeviceId = intent.getStringExtra(EXTRA_SELECTED_MIC_DEVICE_ID)?.trim().orEmpty(),
      continuousFocusEnabled = intent.getBooleanExtra(
        EXTRA_CONTINUOUS_FOCUS_ENABLED,
        fallback.continuousFocusEnabled,
      ),
      pauseExternalMediaEnabled = intent.getBooleanExtra(
        EXTRA_PAUSE_EXTERNAL_MEDIA_ENABLED,
        fallback.pauseExternalMediaEnabled,
      ),
      recognitionCueMode = RecognitionCueModes.normalize(
        intent.getStringExtra(EXTRA_RECOGNITION_CUE_MODE) ?: fallback.recognitionCueMode,
      ),
      ttsGain = intent.getFloatExtra(EXTRA_TTS_GAIN, fallback.ttsGain).coerceIn(0.25f, 5.0f),
      recognitionCueGain = intent.getFloatExtra(
        EXTRA_RECOGNITION_CUE_GAIN,
        fallback.recognitionCueGain,
      ).coerceIn(0.25f, 5.0f),
      playbackStartupPrerollMs = intent.getIntExtra(
        EXTRA_PLAYBACK_STARTUP_PREROLL_MS,
        fallback.playbackStartupPrerollMs,
      ).coerceIn(0, 2_000),
      playbackBufferMs = intent.getIntExtra(
        EXTRA_PLAYBACK_BUFFER_MS,
        fallback.playbackBufferMs,
      ).coerceIn(100, 30_000),
    )
  }

  private fun applyRuntimeConfig(config: AdapterRuntimeConfig) {
    val previousConfig = runtimeConfig
    runtimeConfig = config
    player.speechEnabled = config.speechEnabled
    player.setContinuousReservationEnabled(config.continuousFocusEnabled)
    player.setTtsGain(config.ttsGain)
    player.setRecognitionCueGain(config.recognitionCueGain)
    player.setPlaybackStartupPrerollMs(config.playbackStartupPrerollMs)
    player.setPlaybackBufferMs(config.playbackBufferMs)
    cuePlayer.setGainMultiplier(config.ttsGain)
    micStreamer.setPreferredDeviceId(config.selectedMicDeviceId)
    if (
      shouldEndExternalMediaSessionOnConfigUpdate(
        wasPauseExternalMediaEnabled = previousConfig.pauseExternalMediaEnabled,
        isPauseExternalMediaEnabled = config.pauseExternalMediaEnabled,
      )
    ) {
      endExternalMediaSession()
    }
    updateNotificationText()

    if (!config.listeningEnabled) {
      forceReleaseLocalCaptureState(
        reason = "listening_disabled",
        requestServerCancel = false,
      )
    } else {
      maybeStartAmbientCapture()
    }
  }

  private fun updateNotificationText() {
    val state = notificationStateSummary()
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(NOTIFICATION_ID, buildNotification(state))
  }

  private fun notificationStateSummary(): String {
    return "speech=${runtimeConfig.speechEnabled} listen=${runtimeConfig.listeningEnabled} wake=${runtimeConfig.wakeEnabled} focus=${runtimeConfig.continuousFocusEnabled} mediaPause=${runtimeConfig.pauseExternalMediaEnabled} cueMode=${runtimeConfig.recognitionCueMode} gain=${(runtimeConfig.ttsGain * 100f).toInt()}% cueGain=${(runtimeConfig.recognitionCueGain * 100f).toInt()}% preroll=${runtimeConfig.playbackStartupPrerollMs}ms buffer=${runtimeConfig.playbackBufferMs}ms"
  }

  private fun hasAnyActiveCapture(): Boolean {
    return activeTurnCaptureId != null || activeAmbientCaptureId != null || activeAgentCaptureId != null
  }

  private fun applyForegroundServiceType(hasActiveCapture: Boolean, reason: String): Boolean {
    val targetType = foregroundServiceTypeForCapture(hasActiveCapture)
    if (currentForegroundServiceType == targetType) {
      return true
    }
    val notification = buildNotification(notificationStateSummary())
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, targetType)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      currentForegroundServiceType = targetType
      true
    } catch (error: SecurityException) {
      Log.e(
        TAG,
        "fgs_type_switch_failed reason=$reason targetType=$targetType sdk=${Build.VERSION.SDK_INT}",
        error,
      )
      false
    }
  }

  private fun ensureMicrophoneForegroundType(reason: String): Boolean {
    val applied = applyForegroundServiceType(hasActiveCapture = true, reason = reason)
    if (!applied) {
      emitEvent(
        EVENT_TYPE_STATUS,
        "Microphone capture unavailable (foreground permission/state). Open app and retry.",
      )
    }
    return applied
  }

  private fun maybeDemoteForegroundServiceType(reason: String) {
    if (hasAnyActiveCapture()) {
      return
    }
    applyForegroundServiceType(hasActiveCapture = false, reason = reason)
  }

  private fun buildNotification(state: String): Notification {
    val openAppIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
        Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val openAppPendingIntent = PendingIntent.getActivity(
      this,
      0,
      openAppIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(getString(R.string.notification_title))
      .setContentText("${getString(R.string.notification_text)} ($state)")
      .setContentIntent(openAppPendingIntent)
      .setAutoCancel(false)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }

    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.notification_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.notification_channel_description)
    }
    nm.createNotificationChannel(channel)
  }

  private fun connectWebSocket() {
    if (wsConnected) {
      return
    }
    if (ws != null) {
      return
    }
    mainHandler.removeCallbacks(reconnectRunnable)
    clearIdleHeartbeatState()
    updateRuntimeState(wsState = "connecting")

    val wsUrl = try {
      UrlUtils.websocketUrl(runtimeConfig.apiBaseUrl)
    } catch (error: IllegalArgumentException) {
      Log.e(TAG, "invalid base URL", error)
      scheduleReconnect()
      return
    }

    val request = Request.Builder().url(wsUrl).build()
    ws = httpClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        runOnMain {
          if (ws !== webSocket) {
            return@runOnMain
          }
          wsConnected = true
          markSocketActivity()
          scheduleIdleHeartbeatCheck()
          updateRuntimeState(wsState = "connected")
          syncClientTurnState(force = true)
          if (wantActive) {
            requestClientActivation(activate = true)
          }
          maybeStartAmbientCapture()
          Log.i(TAG, "websocket connected")
          emitEvent(EVENT_TYPE_STATUS, "Connected to ${runtimeConfig.apiBaseUrl}")
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (ws !== webSocket) {
          return
        }
        runOnMain {
          if (ws !== webSocket) {
            return@runOnMain
          }
          markSocketActivity(inbound = true)
        }
        dispatchServerMessage(text)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        runOnMain {
          if (ws !== webSocket) {
            return@runOnMain
          }
          wsConnected = false
          lastSentInTurnState = null
          ws = null
          clearIdleHeartbeatState()
          pendingTurnRecognitionIds.clear()
          turnListenModelById.clear()
          pendingRecognitionCueByTurnId.clear()
          handledRecognitionCueTurnIds.clear()
          suppressSuccessCueTurnIds.clear()
          externalMediaSessionIdByTurnId.clear()
          linkedSessionIdByTurnId.clear()
          linkedSessionTitleByTurnId.clear()
          pendingRetryCaptureTurnIds.clear()
          pendingRetryCaptureAttemptsByTurnId.clear()
          pendingPlaybackTerminalAckTurnIds.clear()
          clearAllCaptureRecoveryState()
          stopActiveCapture()
          endExternalMediaSession()
          updateRuntimeState(
            wsState = "reconnecting",
            audioState = "idle",
            mediaState = "passthrough",
            turnId = "",
          )
          runtimeClientActive = false
          runtimeActiveClientConnected = false
          runtimeConnectedClients = 0
          emitActiveClientState()
          emitEvent(EVENT_TYPE_STATUS, "Disconnected ($code)")
          if (!stopping) {
            scheduleReconnect()
          }
        }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        runOnMain {
          if (ws !== webSocket) {
            return@runOnMain
          }
          wsConnected = false
          lastSentInTurnState = null
          ws = null
          clearIdleHeartbeatState()
          Log.e(TAG, "websocket failure", t)
          pendingTurnRecognitionIds.clear()
          turnListenModelById.clear()
          pendingRecognitionCueByTurnId.clear()
          handledRecognitionCueTurnIds.clear()
          suppressSuccessCueTurnIds.clear()
          externalMediaSessionIdByTurnId.clear()
          linkedSessionIdByTurnId.clear()
          linkedSessionTitleByTurnId.clear()
          pendingRetryCaptureTurnIds.clear()
          pendingRetryCaptureAttemptsByTurnId.clear()
          pendingPlaybackTerminalAckTurnIds.clear()
          clearAllCaptureRecoveryState()
          stopActiveCapture()
          endExternalMediaSession()
          updateRuntimeState(
            wsState = "reconnecting",
            audioState = "idle",
            mediaState = "passthrough",
            turnId = "",
          )
          runtimeClientActive = false
          runtimeActiveClientConnected = false
          runtimeConnectedClients = 0
          emitActiveClientState()
          emitEvent(EVENT_TYPE_STATUS, "WebSocket error: ${t.message ?: "unknown error"}")
          if (!stopping) {
            scheduleReconnect()
          }
        }
      }
    })
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
  }

  private fun dispatchServerMessage(rawText: String) {
    val type = try {
      JSONObject(rawText).optString("type", "")
    } catch (_: Exception) {
      return
    }

    if (type == "turn_audio_chunk") {
      handleTurnAudioChunkMessage(rawText)
      return
    }

    if (type == "turn_start") {
      runOnMainAndWait(TURN_START_MAIN_SYNC_TIMEOUT_MS) {
        handleServerMessage(rawText)
      }
      return
    }

    runOnMain {
      handleServerMessage(rawText)
    }
  }

  private fun runOnMainAndWait(timeoutMs: Long, block: () -> Unit): Boolean {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
      return true
    }

    val latch = CountDownLatch(1)
    mainHandler.post {
      try {
        block()
      } finally {
        latch.countDown()
      }
    }

    val completed = try {
      latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    }

    if (!completed) {
      Log.w(TAG, "turn_start_dispatch_wait_timeout timeoutMs=$timeoutMs")
    }
    return completed
  }

  private fun handleTurnAudioChunkMessage(rawText: String) {
    val payload = try {
      JSONObject(rawText)
    } catch (_: Exception) {
      return
    }

    if (!runtimeClientActive || !runtimeConfig.speechEnabled) {
      return
    }

    val turnId = payload.optString("turnId", "")
    pruneStopTtsSuppression()
    if (turnId.isNotBlank() && stopTtsTurnIds.contains(turnId)) {
      Log.i(TAG, "turn_stop_tts drop_chunk turnId=$turnId")
      return
    }
    val chunkBase64 = payload.optString("chunkBase64", "")
    val sampleRate = payload.optInt("sampleRate", 24_000)
    player.playBase64Chunk(turnId = turnId, chunkBase64 = chunkBase64, requestedSampleRate = sampleRate)
    runOnMain {
      updateRuntimeState(audioState = "playback")
    }
  }

  private fun shouldHandleTurnPlayback(): Boolean {
    return runtimeClientActive && runtimeConfig.speechEnabled
  }

  private fun shouldHandleTurnRecognition(): Boolean {
    return runtimeClientActive && runtimeConfig.speechEnabled && runtimeConfig.listeningEnabled
  }

  private fun assertMainThread(operation: String) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      return
    }
    Log.w(TAG, "state_thread_violation operation=$operation thread=${Thread.currentThread().name}")
  }

  private fun scheduleReconnect() {
    clearIdleHeartbeatState()
    mainHandler.removeCallbacks(reconnectRunnable)
    updateRuntimeState(wsState = "reconnecting")
    mainHandler.postDelayed(reconnectRunnable, 2_000)
  }

  private fun clearIdleHeartbeatState() {
    mainHandler.removeCallbacks(idleHeartbeatRunnable)
    heartbeatProbeInFlight = false
    heartbeatProbeStartedElapsedMs = 0L
    heartbeatProbeGeneration = 0L
    heartbeatStateGeneration = 0L
    heartbeatProbeSentCount = 0
    heartbeatProbeResolvedCount = 0
    heartbeatProbeTimeoutCount = 0
    heartbeatProbeSendFailureCount = 0
    heartbeatConsecutiveFailureCount = 0
    lastHeartbeatStatusElapsedMs = 0L
  }

  private fun invalidateHeartbeatProbe(reason: String, resolvedByActivity: Boolean = false) {
    if (!heartbeatProbeInFlight) {
      return
    }
    heartbeatProbeInFlight = false
    heartbeatProbeStartedElapsedMs = 0L
    heartbeatProbeGeneration = 0L
    if (resolvedByActivity) {
      heartbeatProbeResolvedCount += 1
    }
    Log.i(
      TAG,
      "ws_heartbeat_probe_invalidated reason=$reason resolved=$heartbeatProbeResolvedCount sent=$heartbeatProbeSentCount timeouts=$heartbeatProbeTimeoutCount sendFailures=$heartbeatProbeSendFailureCount consecutiveFailures=$heartbeatConsecutiveFailureCount generation=$heartbeatStateGeneration",
    )
  }

  private fun resetHeartbeatFailureCounter(reason: String) {
    if (heartbeatConsecutiveFailureCount <= 0) {
      return
    }
    Log.i(
      TAG,
      "ws_heartbeat_failure_reset reason=$reason previousConsecutiveFailures=$heartbeatConsecutiveFailureCount",
    )
    heartbeatConsecutiveFailureCount = 0
  }

  private fun markSocketActivity(inbound: Boolean = false) {
    lastSocketActivityElapsedMs = SystemClock.elapsedRealtime()
    heartbeatStateGeneration += 1L
    if (heartbeatProbeInFlight) {
      invalidateHeartbeatProbe(
        reason = if (inbound) "socket_activity_inbound" else "socket_activity_outbound",
        resolvedByActivity = inbound,
      )
    }
    resetHeartbeatFailureCounter(reason = if (inbound) "inbound_activity" else "outbound_activity")
  }

  private fun emitHeartbeatStatus(message: String) {
    val now = SystemClock.elapsedRealtime()
    if (now - lastHeartbeatStatusElapsedMs < WS_IDLE_HEARTBEAT_STATUS_THROTTLE_MS) {
      return
    }
    lastHeartbeatStatusElapsedMs = now
    emitEvent(EVENT_TYPE_STATUS, message)
  }

  private fun shouldProbeHeartbeat(now: Long): Boolean {
    if (!WS_IDLE_HEARTBEAT_ENABLED || !wsConnected || ws == null || stopping) {
      return false
    }
    if (activeTurnCaptureId != null || activeAmbientCaptureId != null) {
      return false
    }
    if (activeExternalMediaTurnId != null) {
      return false
    }
    if (pendingTurnRecognitionIds.isNotEmpty() || turnListenModelById.isNotEmpty()) {
      return false
    }
    if (runtimeAudioState != "idle") {
      return false
    }
    val idleMs = now - lastSocketActivityElapsedMs
    return idleMs >= WS_IDLE_HEARTBEAT_IDLE_MS
  }

  private fun reconnectFromHeartbeatFailure(reason: String, idleMs: Long) {
    Log.w(
      TAG,
      "ws_heartbeat_reconnect reason=$reason idleMs=$idleMs consecutiveFailures=$heartbeatConsecutiveFailureCount sent=$heartbeatProbeSentCount resolved=$heartbeatProbeResolvedCount timeouts=$heartbeatProbeTimeoutCount sendFailures=$heartbeatProbeSendFailureCount generation=$heartbeatStateGeneration",
    )
    emitHeartbeatStatus("WebSocket heartbeat degraded. Reconnecting...")
    val socket = ws
    ws = null
    wsConnected = false
    lastSentInTurnState = null
    clearIdleHeartbeatState()
    updateRuntimeState(wsState = "reconnecting")
    socket?.cancel()
    if (!stopping) {
      scheduleReconnect()
    }
  }

  private fun scheduleIdleHeartbeatCheck() {
    mainHandler.removeCallbacks(idleHeartbeatRunnable)
    if (!WS_IDLE_HEARTBEAT_ENABLED || !wsConnected || ws == null || stopping) {
      return
    }
    mainHandler.postDelayed(idleHeartbeatRunnable, WS_IDLE_HEARTBEAT_CHECK_MS)
  }

  private fun runIdleHeartbeatCheck() {
    if (!WS_IDLE_HEARTBEAT_ENABLED || !wsConnected || ws == null || stopping) {
      return
    }

    val now = SystemClock.elapsedRealtime()
    if (heartbeatProbeInFlight) {
      if (!shouldProbeHeartbeat(now)) {
        invalidateHeartbeatProbe(reason = "idle_state_exited")
        resetHeartbeatFailureCounter(reason = "idle_state_exited")
        scheduleIdleHeartbeatCheck()
        return
      }
      if (heartbeatProbeGeneration != heartbeatStateGeneration) {
        invalidateHeartbeatProbe(reason = "probe_generation_stale")
        scheduleIdleHeartbeatCheck()
        return
      }
      val probeAgeMs = now - heartbeatProbeStartedElapsedMs
      if (probeAgeMs >= WS_IDLE_HEARTBEAT_TIMEOUT_MS) {
        heartbeatProbeInFlight = false
        heartbeatProbeStartedElapsedMs = 0L
        heartbeatProbeGeneration = 0L
        heartbeatProbeTimeoutCount += 1
        heartbeatConsecutiveFailureCount += 1
        val idleMs = now - lastSocketActivityElapsedMs
        Log.w(
          TAG,
          "ws_heartbeat_probe_timeout_nonfatal probeAgeMs=$probeAgeMs idleMs=$idleMs sent=$heartbeatProbeSentCount resolved=$heartbeatProbeResolvedCount timeouts=$heartbeatProbeTimeoutCount sendFailures=$heartbeatProbeSendFailureCount consecutiveFailures=$heartbeatConsecutiveFailureCount generation=$heartbeatStateGeneration",
        )
        if (heartbeatConsecutiveFailureCount >= WS_IDLE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES) {
          reconnectFromHeartbeatFailure(reason = "probe_timeout", idleMs = idleMs)
          return
        }
        emitHeartbeatStatus("WebSocket heartbeat probe timed out; monitoring connection.")
        scheduleIdleHeartbeatCheck()
        return
      }
      scheduleIdleHeartbeatCheck()
      return
    }

    if (!shouldProbeHeartbeat(now)) {
      resetHeartbeatFailureCounter(reason = "idle_state_exited")
      scheduleIdleHeartbeatCheck()
      return
    }

    val idleMs = now - lastSocketActivityElapsedMs
    val ping = JSONObject()
      .put("type", "client_ping")
      .put("sentAtMs", now)
    val sent = sendSocketText(ping.toString(), markActivity = false)
    if (sent) {
      heartbeatProbeInFlight = true
      heartbeatProbeStartedElapsedMs = now
      heartbeatProbeGeneration = heartbeatStateGeneration
      heartbeatProbeSentCount += 1
      Log.i(
        TAG,
        "ws_heartbeat_probe_sent idleMs=$idleMs sent=$heartbeatProbeSentCount generation=$heartbeatStateGeneration",
      )
    } else {
      heartbeatProbeSendFailureCount += 1
      heartbeatConsecutiveFailureCount += 1
      Log.w(
        TAG,
        "ws_heartbeat_probe_send_failed_nonfatal idleMs=$idleMs sent=$heartbeatProbeSentCount resolved=$heartbeatProbeResolvedCount timeouts=$heartbeatProbeTimeoutCount sendFailures=$heartbeatProbeSendFailureCount consecutiveFailures=$heartbeatConsecutiveFailureCount generation=$heartbeatStateGeneration",
      )
      if (heartbeatConsecutiveFailureCount >= WS_IDLE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES) {
        reconnectFromHeartbeatFailure(reason = "probe_send_failed", idleMs = idleMs)
        return
      }
      emitHeartbeatStatus("WebSocket heartbeat send failed; monitoring connection.")
      scheduleIdleHeartbeatCheck()
      return
    }
    scheduleIdleHeartbeatCheck()
  }

  private fun updateRuntimeState(
    wsState: String? = null,
    audioState: String? = null,
    mediaState: String? = null,
    musicState: String? = null,
    turnId: String? = null,
  ) {
    var changed = false
    if (wsState != null && runtimeWsState != wsState) {
      runtimeWsState = wsState
      changed = true
    }
    if (audioState != null && runtimeAudioState != audioState) {
      runtimeAudioState = audioState
      changed = true
    }
    if (mediaState != null && runtimeMediaState != mediaState) {
      runtimeMediaState = mediaState
      changed = true
    }
    if (musicState != null && runtimeMusicState != musicState) {
      runtimeMusicState = musicState
      changed = true
    }
    if (changed || turnId != null) {
      emitRuntimeState(turnId)
    }
    syncClientTurnState()
  }

  private fun emitRuntimeState(turnIdOverride: String? = null) {
    val activeTurnId = turnIdOverride ?: activeTurnCaptureId ?: activeExternalMediaTurnId ?: ""
    val payload = JSONObject()
      .put("ws", runtimeWsState)
      .put("audio", runtimeAudioState)
      .put("media", runtimeMediaState)
      .put("music", runtimeMusicState)
      .put("turnId", activeTurnId)
    emitEvent(EVENT_TYPE_RUNTIME_STATE, payload.toString())
  }

  private fun emitEvent(eventType: String, message: String) {
    if (eventType == EVENT_TYPE_BUBBLE) {
      BubbleHistoryStore.append(this, message)
    }

    val intent = Intent(ACTION_EVENT).apply {
      `package` = packageName
      putExtra(EXTRA_EVENT_TYPE, eventType)
      putExtra(EXTRA_EVENT_MESSAGE, message)
    }
    sendBroadcast(intent)
  }

  private fun emitBubble(
    role: String,
    body: String,
    noWait: Boolean = false,
    turnId: String? = null,
    linkedSessionId: String? = null,
    linkedSessionTitle: String? = null,
    attachment: JSONObject? = null,
    quickReplies: org.json.JSONArray? = null,
  ) {
    val normalizedRole = when (role.lowercase()) {
      "assistant" -> "assistant"
      "user" -> "user"
      else -> "system"
    }
    val payload = JSONObject()
      .put("kind", "bubble")
      .put("role", normalizedRole)
      .put("body", body)
    if (!turnId.isNullOrBlank()) {
      payload.put("turnId", turnId)
    }
    if (!linkedSessionId.isNullOrBlank()) {
      payload.put("linkedSessionId", linkedSessionId)
    }
    if (!linkedSessionTitle.isNullOrBlank()) {
      payload.put("linkedSessionTitle", linkedSessionTitle)
    }
    if (attachment != null) {
      val attachmentDataBase64 = attachment.optString("dataBase64", "").trim()
      val attachmentContentType = attachment.optString("contentType", "").trim()
      if (attachmentDataBase64.isNotEmpty() && attachmentContentType.isNotEmpty()) {
        val normalizedAttachment = JSONObject()
          .put("dataBase64", attachmentDataBase64)
          .put("contentType", attachmentContentType)
        val attachmentFileName = attachment.optString("fileName", "").trim()
        if (attachmentFileName.isNotEmpty()) {
          normalizedAttachment.put("fileName", attachmentFileName)
        }
        payload.put("attachment", normalizedAttachment)
      }
    }
    if (quickReplies != null) {
      val normalizedQuickReplies = org.json.JSONArray()
      for (index in 0 until quickReplies.length()) {
        val quickReply = quickReplies.optJSONObject(index) ?: continue
        val label = quickReply.optString("label", "").trim()
        val text = quickReply.optString("text", "").trim()
        if (label.isEmpty() || text.isEmpty()) {
          continue
        }
        val normalizedQuickReply = JSONObject()
          .put("label", label)
          .put("text", text)
        val id = quickReply.optString("id", "").trim()
        if (id.isNotEmpty()) {
          normalizedQuickReply.put("id", id)
        }
        if (quickReply.optBoolean("defaultResume", false)) {
          normalizedQuickReply.put("defaultResume", true)
        }
        normalizedQuickReplies.put(normalizedQuickReply)
      }
      if (normalizedQuickReplies.length() > 0) {
        payload.put("quickReplies", normalizedQuickReplies)
      }
    }
    if (noWait) {
      payload.put("noWait", true)
    }
    emitEvent(EVENT_TYPE_BUBBLE, payload.toString())
  }

  private fun isInTurnFlowActive(): Boolean {
    return isInTurnFlowActive(
      activeTurnCaptureId = activeTurnCaptureId,
      activeAgentCaptureId = activeAgentCaptureId,
      activeExternalMediaTurnId = activeExternalMediaTurnId,
      pendingActiveAgentResultTurnId = pendingActiveAgentResultTurnId,
      pendingTurnRecognitionIds = pendingTurnRecognitionIds,
    )
  }

  private fun syncClientTurnState(force: Boolean = false) {
    val inTurn = isInTurnFlowActive()
    if (!force && lastSentInTurnState == inTurn) {
      return
    }
    sendClientState(inTurnOverride = inTurn)
  }

  private fun setPendingActiveAgentResultTurnId(turnId: String?) {
    if (pendingActiveAgentResultTurnId == turnId) {
      return
    }
    pendingActiveAgentResultTurnId = turnId
    syncClientTurnState()
  }

  private fun sendClientState(inTurnOverride: Boolean? = null): Boolean {
    val inTurn = inTurnOverride ?: isInTurnFlowActive()
    val message = JSONObject()
      .put("type", "client_state_update")
      .put("acceptingTurns", runtimeConfig.acceptingTurns)
      .put("speechEnabled", runtimeConfig.speechEnabled)
      .put("listeningEnabled", runtimeConfig.listeningEnabled)
      .put("inTurn", inTurn)

    val sent = sendSocketText(message.toString(), markActivity = true)
    if (sent) {
      lastSentInTurnState = inTurn
    }
    return sent
  }

  private fun requestClientActivation(activate: Boolean) {
    val message = JSONObject()
      .put("type", if (activate) "client_activate" else "client_deactivate")
    val sent = sendSocketText(message.toString(), markActivity = true)
    if (!sent) {
      val action = if (activate) "Activation" else "Deactivation"
      emitEvent(EVENT_TYPE_STATUS, "$action failed: websocket is not connected.")
      return
    }
    emitEvent(
      EVENT_TYPE_STATUS,
      if (activate) "Activation requested." else "Deactivation requested.",
    )
  }

  private fun maybeHandleLostActiveOwnership(wasActive: Boolean, source: String) {
    if (!wasActive || runtimeClientActive) {
      return
    }
    forceReleaseLocalCaptureState(
      reason = "lost_active_ownership_$source",
      requestServerCancel = true,
    )
    emitEvent(EVENT_TYPE_STATUS, "Active ownership moved to another device. Releasing local capture.")
  }

  private fun forceReleaseLocalCaptureState(reason: String, requestServerCancel: Boolean) {
    assertMainThread("forceReleaseLocalCaptureState")
    val serverTurnId = resolveAbortTurnId("")
    Log.i(
      TAG,
      "capture_force_release_begin reason=$reason requestServerCancel=$requestServerCancel serverTurnId=$serverTurnId activeTurnCaptureId=$activeTurnCaptureId activeAmbientCaptureId=$activeAmbientCaptureId pendingRecognitions=${pendingTurnRecognitionIds.size} runtimeClientActive=$runtimeClientActive listeningEnabled=${runtimeConfig.listeningEnabled}",
    )

    stopActiveCapture()
    // Force-stop any recorder thread even if service state lost track of its request id.
    micStreamer.stop()
    activeTurnCaptureId = null
    activeAmbientCaptureId = null
    activeAgentCaptureId = null
    setPendingActiveAgentResultTurnId(null)
    emitActiveAgentCaptureState()
    emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")
    updateRuntimeState(audioState = "idle", turnId = "")

    if (requestServerCancel && !serverTurnId.isNullOrBlank()) {
      postTurnCancel(serverTurnId)
      emitEvent(EVENT_TYPE_STATUS, "Cancel requested for turn $serverTurnId.")
    }

    Log.i(
      TAG,
      "capture_force_release_end reason=$reason serverTurnId=$serverTurnId activeTurnCaptureId=$activeTurnCaptureId activeAmbientCaptureId=$activeAmbientCaptureId pendingRecognitions=${pendingTurnRecognitionIds.size}",
    )
  }

  private fun emitActiveClientState() {
    val payload = JSONObject()
      .put("active", runtimeClientActive)
      .put("activeClientConnected", runtimeActiveClientConnected)
      .put("connectedClients", runtimeConnectedClients)
    emitEvent(EVENT_TYPE_ACTIVE_CLIENT_STATE, payload.toString())
  }

  private fun emitActiveAgentCaptureState() {
    val payload = JSONObject()
      .put("active", activeAgentCaptureId != null)
      .put("sessionId", activeAgentSessionId.orEmpty())
      .put("label", activeAgentSessionLabel)
    emitEvent(EVENT_TYPE_ACTIVE_AGENT_CAPTURE_STATE, payload.toString())
  }

  private fun sendSocketText(text: String, markActivity: Boolean = true): Boolean {
    val socket = ws ?: return false
    if (!wsConnected) {
      return false
    }
    val sent = socket.send(text)
    if (!sent) {
      Log.w(TAG, "ws_send_failed")
      runOnMain {
        handleSocketSendFailure("send_returned_false")
      }
      return false
    }
    if (markActivity) {
      markSocketActivity()
    }
    return true
  }

  private fun handleSocketSendFailure(reason: String) {
    assertMainThread("handleSocketSendFailure")
    if (stopping) {
      return
    }
    val socket = ws
    wsConnected = false
    lastSentInTurnState = null
    ws = null
    clearIdleHeartbeatState()
    socket?.cancel()
    Log.w(TAG, "ws_send_reset reason=$reason")
    connectWebSocket()
  }

  private fun abortPendingPlaybackTerminalAcksForNewTurn(nextTurnId: String) {
    val pendingTurnIds = playbackTerminalTurnIdsToAbortForNewTurn(
      pendingTurnIds = pendingPlaybackTerminalAckTurnIds.toList(),
      nextTurnId = nextTurnId,
    )
    for (pendingTurnId in pendingTurnIds) {
      sendPlaybackTerminalAckIfPending(
        turnId = pendingTurnId,
        status = "aborted",
        reason = "preempted_by_new_turn",
      )
    }
  }

  private fun sendPlaybackTerminalAckIfPending(turnId: String, status: String, reason: String? = null) {
    if (!pendingPlaybackTerminalAckTurnIds.remove(turnId)) {
      return
    }
    val payload = JSONObject()
      .put("type", "turn_playback_terminal")
      .put("turnId", turnId)
      .put("status", status)
    val normalizedReason = reason?.trim().orEmpty()
    if (normalizedReason.isNotEmpty()) {
      payload.put("reason", normalizedReason)
    }
    val sent = sendSocketText(payload.toString(), markActivity = true)
    Log.i(
      TAG,
      "turn_playback_terminal_send turnId=$turnId status=$status reason=${if (normalizedReason.isEmpty()) "none" else normalizedReason} sent=$sent",
    )
  }

  private fun clearStopTtsSuppressionForTurn(turnId: String) {
    if (turnId.isBlank()) {
      return
    }
    stopTtsTurnIds.remove(turnId)
    stopTtsTurnIdTimestampById.remove(turnId)
  }

  private fun clearQuickReplyCaptureSuppressionForTurn(turnId: String) {
    if (turnId.isBlank()) {
      return
    }
    quickReplyCaptureSuppressedTurnIds.remove(turnId)
  }

  private fun pruneStopTtsSuppression(nowElapsedMs: Long = SystemClock.elapsedRealtime()) {
    val turnIdsToClear = stopTtsSuppressionTurnIdsToClear(
      markedAtByTurnId = stopTtsTurnIdTimestampById,
      nowElapsedMs = nowElapsedMs,
    )
    for (turnId in turnIdsToClear) {
      clearStopTtsSuppressionForTurn(turnId)
    }
  }

  private fun forceLocalPlaybackCancel(turnId: String, reason: String): Boolean {
    assertMainThread("forceLocalPlaybackCancel")
    if (turnId.isBlank()) {
      return false
    }

    val normalizedReason = reason.trim().ifEmpty { "unspecified" }
    val nowElapsedMs = SystemClock.elapsedRealtime()
    pruneStopTtsSuppression(nowElapsedMs = nowElapsedMs)
    val alreadySuppressed = stopTtsTurnIds.contains(turnId)
    stopTtsTurnIds.add(turnId)
    stopTtsTurnIdTimestampById[turnId] = nowElapsedMs
    if (alreadySuppressed) {
      Log.i(TAG, "turn_stop_tts local_cancel_duplicate turnId=$turnId reason=$normalizedReason")
      return false
    }

    player.muteCurrentOutput()
    player.interruptCurrentOutput()
    playbackControlExecutor.execute {
      val startedAt = SystemClock.elapsedRealtime()
      Log.i(TAG, "turn_stop_tts local_cancel_begin turnId=$turnId reason=$normalizedReason")
      player.stop()
      val elapsedMs = SystemClock.elapsedRealtime() - startedAt
      Log.i(
        TAG,
        "turn_stop_tts local_cancel_end turnId=$turnId reason=$normalizedReason elapsedMs=$elapsedMs",
      )
      runOnMain {
        sendPlaybackTerminalAckIfPending(
          turnId = turnId,
          status = "aborted",
          reason = normalizedReason,
        )
      }
    }
    updateRuntimeState(audioState = "idle", turnId = turnId)
    return true
  }

  private fun cancellationReasonFromListenResult(payload: JSONObject, rawError: String): String? {
    return cancellationReasonFromListenResult(
      success = payload.optBoolean("success", false),
      canceled = payload.optBoolean("canceled", false),
      cancelReason = payload.optString("cancelReason", "").trim(),
      rawError = rawError,
    )
  }

  private fun handleServerMessage(rawText: String) {
    val payload = try {
      JSONObject(rawText)
    } catch (_: Exception) {
      return
    }

    when (payload.optString("type")) {
      "server_state" -> {
        val wasActive = runtimeClientActive
        runtimeConnectedClients = payload.optInt("connectedClients", runtimeConnectedClients)
        runtimeActiveClientConnected = payload.optBoolean(
          "activeClientConnected",
          runtimeActiveClientConnected,
        )
        if (!runtimeActiveClientConnected) {
          runtimeClientActive = false
        }
        if (wasActive && !runtimeClientActive) {
          wantActive = false
        }
        Log.i(
          TAG,
          "active_client_state source=server_state wasActive=$wasActive active=$runtimeClientActive activeClientConnected=$runtimeActiveClientConnected connectedClients=$runtimeConnectedClients activeTurnCaptureId=$activeTurnCaptureId activeAmbientCaptureId=$activeAmbientCaptureId pendingRecognitions=${pendingTurnRecognitionIds.size}",
        )
        emitActiveClientState()
        maybeHandleLostActiveOwnership(wasActive, source = "server_state")
        if (runtimeClientActive) {
          maybeStartAmbientCapture()
        }
      }

      "client_activation_state" -> {
        val wasActive = runtimeClientActive
        runtimeClientActive = payload.optBoolean("active", runtimeClientActive)
        runtimeActiveClientConnected = payload.optBoolean(
          "activeClientConnected",
          runtimeActiveClientConnected,
        )
        runtimeConnectedClients = payload.optInt("connectedClients", runtimeConnectedClients)
        if (wasActive && !runtimeClientActive) {
          wantActive = false
        }
        Log.i(
          TAG,
          "active_client_state source=client_activation_state wasActive=$wasActive active=$runtimeClientActive activeClientConnected=$runtimeActiveClientConnected connectedClients=$runtimeConnectedClients activeTurnCaptureId=$activeTurnCaptureId activeAmbientCaptureId=$activeAmbientCaptureId pendingRecognitions=${pendingTurnRecognitionIds.size}",
        )
        emitActiveClientState()
        maybeHandleLostActiveOwnership(wasActive, source = "client_activation_state")
        if (runtimeClientActive) {
          maybeStartAmbientCapture()
        }
      }

      "server_pong" -> {
        val echoedSentAtMs = payload.optLong("echoedSentAtMs", -1L)
        if (echoedSentAtMs > 0L) {
          val rttMs = (SystemClock.elapsedRealtime() - echoedSentAtMs).coerceAtLeast(0L)
          Log.i(
            TAG,
            "ws_heartbeat_pong rttMs=$rttMs sent=$heartbeatProbeSentCount resolved=$heartbeatProbeResolvedCount timeouts=$heartbeatProbeTimeoutCount sendFailures=$heartbeatProbeSendFailureCount",
          )
        } else {
          Log.i(TAG, "ws_heartbeat_pong sent=$heartbeatProbeSentCount")
        }
      }

      "turn_start" -> {
        val turnId = payload.optString("turnId", "")
        if (turnId.isBlank()) {
          return
        }
        val listenRequested = payload.optBoolean("listenRequested", false)
        val linkedSessionId = payload.optString("sessionId", "").trim()
        if (linkedSessionId.isNotEmpty()) {
          linkedSessionIdByTurnId[turnId] = linkedSessionId
        } else {
          linkedSessionIdByTurnId.remove(turnId)
        }
        val linkedSessionTitle = payload.optString("sessionTitle", "").trim()
        if (linkedSessionTitle.isNotEmpty()) {
          linkedSessionTitleByTurnId[turnId] = linkedSessionTitle
        } else {
          linkedSessionTitleByTurnId.remove(turnId)
        }
        val text = payload.optString("originalText", "").trim()
        val attachment = payload.optJSONObject("attachment")
        val quickReplies = payload.optJSONArray("quickReplies")
        if (text.isNotEmpty()) {
          emitBubble(
            role = "assistant",
            body = text,
            noWait = !listenRequested,
            turnId = turnId,
            linkedSessionId = linkedSessionIdByTurnId[turnId],
            linkedSessionTitle = linkedSessionTitleByTurnId[turnId],
            attachment = attachment,
            quickReplies = quickReplies,
          )
        }

        if (!shouldHandleTurnPlayback()) {
          turnListenModelById.remove(turnId)
          if (pendingTurnRecognitionIds.remove(turnId)) {
            syncClientTurnState()
          }
          return
        }

        Log.i(
          TAG,
          "cue_state turn_start turnId=$turnId pendingRecognitions=${pendingTurnRecognitionIds.size} handledCues=${handledRecognitionCueTurnIds.size}",
        )
        pruneHandledCueTurnIds()
        prepareForIncomingTurnPlayback(turnId)
        clearStopTtsSuppressionForTurn(turnId)
        clearQuickReplyCaptureSuppressionForTurn(turnId)
        pendingPlaybackTerminalAckTurnIds.remove(turnId)

        beginExternalMediaSession(turnId)
        updateRuntimeState(audioState = "playback", turnId = turnId)

        if (listenRequested && shouldHandleTurnRecognition()) {
          val model = when (val raw = payload.opt("listenModelId")) {
            is String -> {
              val normalized = raw.trim()
              if (
                normalized.isEmpty() ||
                normalized.equals("null", ignoreCase = true) ||
                normalized.equals("undefined", ignoreCase = true)
              ) {
                null
              } else {
                normalized
              }
            }

            else -> null
          }
          turnListenModelById[turnId] = model
          pendingTurnRecognitionIds.add(turnId)
          syncClientTurnState()
          player.beginContinuousReservation()
        } else {
          turnListenModelById.remove(turnId)
          pendingTurnRecognitionIds.remove(turnId)
        }
      }

      "turn_audio_chunk" -> handleTurnAudioChunkMessage(rawText)

      "turn_tts_end" -> {
        val turnId = payload.optString("turnId", "")
        if (turnId.isBlank()) {
          return
        }
        clearStopTtsSuppressionForTurn(turnId)

        val success = payload.optBoolean("success", false)
        if (!shouldHandleTurnPlayback()) {
          pendingPlaybackTerminalAckTurnIds.remove(turnId)
          turnListenModelById.remove(turnId)
          clearQuickReplyCaptureSuppressionForTurn(turnId)
          if (pendingTurnRecognitionIds.remove(turnId)) {
            player.endContinuousReservation()
            syncClientTurnState()
          }
          turnsStartedWithMediaActive.remove(turnId)
          return
        }
        Log.i(
          TAG,
          "cue_state turn_tts_end turnId=$turnId success=$success hasListenModel=${turnListenModelById.containsKey(turnId)}",
        )
        if (!success) {
          val error = payload.optString("error", "TTS failed")
          emitEvent(EVENT_TYPE_BUBBLE, "System: TTS failed: $error")
          pendingPlaybackTerminalAckTurnIds.remove(turnId)
          turnListenModelById.remove(turnId)
          clearQuickReplyCaptureSuppressionForTurn(turnId)
          if (pendingTurnRecognitionIds.remove(turnId)) {
            player.endContinuousReservation()
          }
          syncClientTurnState()
          updateRuntimeState(audioState = "idle")
          endExternalMediaSession(turnId)
          turnsStartedWithMediaActive.remove(turnId)
          return
        }

        if (turnListenModelById.containsKey(turnId)) {
          scheduleTurnCaptureAfterPlaybackDrain(turnId)
        } else {
          pendingPlaybackTerminalAckTurnIds.add(turnId)
          scheduleExternalMediaEndAfterPlayback(turnId)
        }
      }

      "turn_listen_stop" -> {
        val turnId = payload.optString("turnId", "")
        Log.i(
          TAG,
          "cue_state turn_listen_stop turnId=$turnId activeTurnCaptureId=$activeTurnCaptureId activeAmbientCaptureId=$activeAmbientCaptureId pendingRecognition=${pendingTurnRecognitionIds.contains(turnId)}",
        )
        val shouldRestartRetryCapture = pendingRetryCaptureTurnIds.remove(turnId)
        if (turnId == activeTurnCaptureId) {
          stopTurnCapture()
        } else if (turnId == activeAmbientCaptureId) {
          stopAmbientCapture()
        } else if (turnId == activeAgentCaptureId) {
          stopActiveAgentCapture(playCompletionCue = false, awaitResult = true)
        }
        if (
          shouldRestartRetryCapture &&
          pendingTurnRecognitionIds.contains(turnId) &&
          !quickReplyCaptureSuppressedTurnIds.contains(turnId)
        ) {
          pendingRetryCaptureAttemptsByTurnId.remove(turnId)
          Log.i(
            TAG,
            "cue_state retry_capture_restart turnId=$turnId reason=listen_stop",
          )
          startTurnCapture(turnId, turnListenModelById[turnId])
        }
      }

      "turn_listen_result" -> {
        val turnId = payload.optString("turnId", "")
        if (turnId.isBlank()) {
          return
        }
        Log.i(
          TAG,
          "cue_state turn_listen_result turnId=$turnId pendingRecognition=${pendingTurnRecognitionIds.contains(turnId)} handledCue=${handledRecognitionCueTurnIds.contains(turnId)} activeTurnCaptureId=$activeTurnCaptureId",
        )

        if (turnId == activeAmbientCaptureId) {
          val success = payload.optBoolean("success", false)
          val transcript = payload.optString("text", "").trim()
          stopAmbientCapture()

          if (transcript.isNotEmpty()) {
            emitEvent(EVENT_TYPE_BUBBLE, "User: $transcript")
          }

          if (success && transcript.isNotEmpty() && wakeTriggerPattern.matcher(transcript).find()) {
            postWakeIntent(transcript)
          }

          scheduleAmbientRestart()
          return
        }

        val isActiveAgentResultTurn =
          turnId == activeAgentCaptureId || turnId == pendingActiveAgentResultTurnId
        if (isActiveAgentResultTurn) {
          val shouldClearPendingActiveAgentResult = turnId == pendingActiveAgentResultTurnId
          val canceledLocally = locallyCanceledTurnIds.remove(turnId)
          val finalizeActiveAgentResult = {
            pendingTurnRecognitionIds.remove(turnId)
            if (shouldClearPendingActiveAgentResult) {
              setPendingActiveAgentResultTurnId(null)
            }
            syncClientTurnState()
          }
          val startedWithMediaActive = turnsStartedWithMediaActive.contains(turnId)
          endExternalMediaSession(turnId)
          val success = payload.optBoolean("success", false)
          val transcript = payload.optString("text", "").trim()
          val error = payload.optString("error", "").trim()
          val cancelReason = cancellationReasonFromListenResult(payload, rawError = error)
          val captureSessionId = activeAgentSessionIdByCaptureTurnId.remove(turnId)
          val captureSessionLabel = activeAgentSessionLabelByCaptureTurnId.remove(turnId)
          val quotedAssistantText =
            activeAgentQuotedAssistantTextByCaptureTurnId.remove(turnId)?.trim().orEmpty()
          val sendVerbatim =
            activeAgentSendVerbatimByCaptureTurnId.remove(turnId) == true
          val linkedSessionId =
            captureSessionId?.trim().takeUnless { it.isNullOrBlank() }
              ?: activeAgentSessionId?.trim().takeUnless { it.isNullOrBlank() }
          val linkedSessionTitle = captureSessionLabel?.trim().takeUnless { it.isNullOrEmpty() }
            ?: activeAgentSessionLabel.trim().ifEmpty {
              linkedSessionId ?: ""
            }
          if (turnId == activeAgentCaptureId) {
            stopActiveAgentCapture(
              playCompletionCue = false,
              awaitResult = false,
              preservePendingRecognition = true,
            )
          }

          if (transcript.isNotEmpty()) {
            emitBubble(
              role = "user",
              body = transcript,
              turnId = turnId,
              linkedSessionId = linkedSessionId,
              linkedSessionTitle = linkedSessionTitle,
            )
          }

          handleRecognitionCompletionCue(
            turnId = turnId,
            success = success,
            startedWithMediaActive = startedWithMediaActive,
          )

          if (!success) {
            if (canceledLocally || cancelReason != null) {
              emitEvent(EVENT_TYPE_STATUS, "Voice to Agent canceled.")
              finalizeActiveAgentResult()
              return
            }
            val renderedError = if (error.isNotEmpty()) error else "failed"
            emitEvent(EVENT_TYPE_BUBBLE, "System: Voice capture failed: $renderedError")
            emitEvent(EVENT_TYPE_STATUS, "Voice to Agent failed: $renderedError")
            finalizeActiveAgentResult()
            return
          }

          if (transcript.isEmpty()) {
            emitEvent(EVENT_TYPE_BUBBLE, "System: Voice capture was empty.")
            emitEvent(EVENT_TYPE_STATUS, "Voice to Agent capture was empty.")
            finalizeActiveAgentResult()
            return
          }

          emitEvent(EVENT_TYPE_STATUS, "Voice to Agent recognized. Sending to selected session...")
          postActiveAgentMessage(
            transcript = transcript,
            quotedAssistantText = quotedAssistantText,
            sendVerbatim = sendVerbatim,
          )
          finalizeActiveAgentResult()
          return
        }

        if (pendingTurnRecognitionIds.contains(turnId)) {
          val canceledLocally = locallyCanceledTurnIds.remove(turnId)
          val success = payload.optBoolean("success", false)
          val retryable = payload.optBoolean("retryable", false)
          val transcript = payload.optString("text", "").trim()
          val error = payload.optString("error", "").trim()
          val cancelReason = cancellationReasonFromListenResult(payload, rawError = error)
          if (retryable) {
            emitEvent(EVENT_TYPE_BUBBLE, "System: Recognition retrying...")
            val captureOwnedByTurn = turnId == activeTurnCaptureId
            val captureRunningForTurn = micStreamer.isRunningFor(turnId)
            if (captureOwnedByTurn) {
              pendingRetryCaptureTurnIds.add(turnId)
              Log.i(
                TAG,
                "cue_state retry_capture_wait turnId=$turnId reason=capture_still_active",
              )
            } else if (captureRunningForTurn) {
              pendingRetryCaptureTurnIds.add(turnId)
              Log.i(
                TAG,
                "cue_state retry_capture_wait turnId=$turnId reason=capture_drain_pending",
              )
              markExpectedTurnCaptureStop(turnId)
              micStreamer.stop(turnId)
              player.endRecognitionCaptureFocus()
              scheduleRetryCaptureRestart(turnId, "capture_drain")
            } else {
              pendingRetryCaptureTurnIds.remove(turnId)
              pendingRetryCaptureAttemptsByTurnId.remove(turnId)
              Log.i(
                TAG,
                "cue_state retry_capture_restart turnId=$turnId reason=listen_result",
              )
              startTurnCapture(turnId, turnListenModelById[turnId])
            }
            return
          }

          if (!success) {
            if (cancelReason != null) {
              forceLocalPlaybackCancel(turnId = turnId, reason = "listen_result_$cancelReason")
            }
          }

          pendingRetryCaptureTurnIds.remove(turnId)
          pendingRetryCaptureAttemptsByTurnId.remove(turnId)
          clearTurnCaptureRecoveryState(turnId)
          clearTurnCaptureWatchdog(turnId)
          clearQuickReplyCaptureSuppressionForTurn(turnId)
          val startedWithMediaActive = turnsStartedWithMediaActive.contains(turnId)
          pendingTurnRecognitionIds.remove(turnId)
          turnListenModelById.remove(turnId)
          syncClientTurnState()
          if (success) {
            emitBubble(
              role = "user",
              body = if (transcript.isNotEmpty()) transcript else "(empty transcript)",
              turnId = turnId,
              linkedSessionId = linkedSessionIdByTurnId[turnId],
              linkedSessionTitle = linkedSessionTitleByTurnId[turnId],
            )
          } else if (canceledLocally || cancelReason != null) {
            emitEvent(EVENT_TYPE_STATUS, "Recognition canceled.")
          } else {
            val renderedError = if (error.isNotEmpty()) error else "failed"
            emitEvent(EVENT_TYPE_BUBBLE, "System: Recognition failed: $renderedError")
          }
          player.endContinuousReservation()
          endExternalMediaSession(turnId)
          turnsStartedWithMediaActive.remove(turnId)
          handleRecognitionCompletionCue(
            turnId = turnId,
            success = success,
            startedWithMediaActive = startedWithMediaActive,
          )
        }
      }
    }
  }

  private fun handleRecognitionCompletionCue(
    turnId: String,
    success: Boolean,
    startedWithMediaActive: Boolean,
  ) {
    val cueMode = RecognitionCueModes.normalize(runtimeConfig.recognitionCueMode)
    val skipCueAfterMediaEnd = when (cueMode) {
      RecognitionCueModes.OFF -> true
      RecognitionCueModes.ALWAYS -> false
      else -> startedWithMediaActive
    }
    if (handledRecognitionCueTurnIds.contains(turnId)) {
      return
    }
    if (skipCueAfterMediaEnd) {
      handledRecognitionCueTurnIds.add(turnId)
      val reason = when (cueMode) {
        RecognitionCueModes.OFF -> "cue_mode_off"
        RecognitionCueModes.ALWAYS -> "none"
        else -> "cue_mode_media_inactive_only"
      }
      Log.i(
        TAG,
        "cue_state play_skip turnId=$turnId reason=$reason",
      )
      return
    }

    maybePlayRecognitionCue(turnId, success)
  }

  private fun startTurnCapture(turnId: String, modelId: String?) {
    assertMainThread("startTurnCapture")
    if (!runtimeConfig.listeningEnabled) {
      return
    }
    if (quickReplyCaptureSuppressedTurnIds.contains(turnId)) {
      Log.i(TAG, "cue_state listen_capture_skip turnId=$turnId reason=quick_reply_selected")
      return
    }

    if (activeTurnCaptureId == turnId && micStreamer.isRunningFor(turnId)) {
      return
    }

    if (!ensureMicrophoneForegroundType(reason = "turn_capture_start")) {
      emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")
      updateRuntimeState(audioState = "idle")
      return
    }

    stopActiveAgentCapture(playCompletionCue = false)
    stopAmbientCapture()
    stopTurnCapture()
    val captureFocusGranted = player.beginRecognitionCaptureFocus()
    if (!captureFocusGranted) {
      emitEvent(EVENT_TYPE_STATUS, "Capture started without audio focus")
    }

    val started = micStreamer.start(
      requestId = turnId,
      onStarted = { sampleRate, channels, encoding ->
        val message = JSONObject()
          .put("type", "turn_listen_stream_start")
          .put("turnId", turnId)
          .put("sampleRate", sampleRate)
          .put("channels", channels)
          .put("encoding", encoding)
        if (!modelId.isNullOrBlank()) {
          message.put("modelId", modelId)
        }
        val sent = sendSocketText(message.toString())
        if (!sent) {
          runOnMain {
            Log.w(
              TAG,
              "cue_state capture_stream_start_send_failed turnId=$turnId wsConnected=$wsConnected",
            )
            if (!stopping) {
              handleSocketSendFailure("capture_stream_start_send_failed")
            }
            scheduleTurnCaptureRecovery(turnId, "stream_start_send_failed")
          }
        } else {
          runOnMain {
            clearTurnCaptureRecoveryState(turnId)
          }
        }
      },
      onRouteResolved = { route ->
        emitEvent(EVENT_TYPE_MIC_ROUTE, "Mode: Recognition | Device: $route")
      },
      onChunk = { bytes ->
        val message = JSONObject()
          .put("type", "turn_listen_stream_chunk")
          .put("turnId", turnId)
          .put("chunkBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        val sent = sendSocketText(message.toString())
        if (sent) {
          runOnMain {
            captureChunkSendFailureCountByTurnId.remove(turnId)
          }
        } else {
          runOnMain {
            val failures = (captureChunkSendFailureCountByTurnId[turnId] ?: 0) + 1
            captureChunkSendFailureCountByTurnId[turnId] = failures
            Log.w(
              TAG,
              "cue_state capture_chunk_send_failed turnId=$turnId failures=$failures wsConnected=$wsConnected",
            )
            if (failures < CAPTURE_SEND_FAILURE_RESTART_THRESHOLD) {
              return@runOnMain
            }
            captureChunkSendFailureCountByTurnId.remove(turnId)
            if (turnId == activeTurnCaptureId) {
              stopTurnCapture()
            } else if (micStreamer.isRunningFor(turnId)) {
              markExpectedTurnCaptureStop(turnId)
              micStreamer.stop(turnId)
              player.endRecognitionCaptureFocus()
            }
            if (!stopping) {
              handleSocketSendFailure("capture_chunk_send_failed")
            }
            scheduleTurnCaptureRecovery(turnId, "stream_chunk_send_failed")
          }
        }
      },
      onStopped = {
        runOnMain {
          val expectedStop = expectedTurnCaptureStopIds.remove(turnId)
          captureChunkSendFailureCountByTurnId.remove(turnId)
          clearTurnCaptureWatchdog(turnId)
          val message = JSONObject()
            .put("type", "turn_listen_stream_end")
            .put("turnId", turnId)
          val endSent = sendSocketText(message.toString())
          if (!endSent) {
            Log.w(
              TAG,
              "cue_state capture_stream_end_send_failed turnId=$turnId wsConnected=$wsConnected",
            )
          }
          player.endRecognitionCaptureFocus()
          pendingRecognitionCueByTurnId.remove(turnId)?.let { cueSuccess ->
            playRecognitionCue(turnId, cueSuccess)
          }
          if (activeTurnCaptureId == turnId) {
            activeTurnCaptureId = null
            emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")
            maybeStartAmbientCapture()
          }
          if (
            !expectedStop &&
            pendingTurnRecognitionIds.contains(turnId) &&
            !pendingRetryCaptureTurnIds.contains(turnId)
          ) {
            Log.w(
              TAG,
              "cue_state capture_unexpected_stop turnId=$turnId wsConnected=$wsConnected",
            )
            if (!wsConnected && !stopping) {
              connectWebSocket()
            }
            scheduleTurnCaptureRecovery(turnId, "unexpected_stop")
          }
        }
      },
    )

    if (started) {
      armTurnCaptureWatchdog(turnId)
      activeTurnCaptureId = turnId
      emitEvent(EVENT_TYPE_LISTENING_STATE, "active")
      updateRuntimeState(audioState = "capture", turnId = turnId)
    } else {
      Log.w(TAG, "cue_state capture_start_failed turnId=$turnId")
      scheduleTurnCaptureRecovery(turnId, "capture_start_failed")
      player.endRecognitionCaptureFocus()
      emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")
      updateRuntimeState(audioState = "idle")
      maybeDemoteForegroundServiceType(reason = "turn_capture_start_failed")
    }
  }

  private fun prepareForIncomingTurnPlayback(turnId: String) {
    assertMainThread("prepareForIncomingTurnPlayback")
    val priorTurnCaptureId = activeTurnCaptureId
    val priorAmbientCaptureId = activeAmbientCaptureId
    val priorAgentCaptureId = activeAgentCaptureId
    val priorPendingAgentResultTurnId = pendingActiveAgentResultTurnId

    if (priorTurnCaptureId != null) {
      stopTurnCapture()
    }
    if (priorAmbientCaptureId != null) {
      stopAmbientCapture()
    }
    if (priorAgentCaptureId != null) {
      stopActiveAgentCapture(playCompletionCue = false, awaitResult = false, restartAmbient = false)
    }
    if (priorPendingAgentResultTurnId != null) {
      setPendingActiveAgentResultTurnId(null)
      activeAgentSessionIdByCaptureTurnId.remove(priorPendingAgentResultTurnId)
      activeAgentSessionLabelByCaptureTurnId.remove(priorPendingAgentResultTurnId)
      activeAgentQuotedAssistantTextByCaptureTurnId.remove(priorPendingAgentResultTurnId)
      activeAgentSendVerbatimByCaptureTurnId.remove(priorPendingAgentResultTurnId)
    }

    if (
      priorTurnCaptureId != null ||
      priorAmbientCaptureId != null ||
      priorAgentCaptureId != null ||
      priorPendingAgentResultTurnId != null
    ) {
      Log.i(
        TAG,
        "turn_start_capture_barrier turnId=$turnId priorTurnCaptureId=$priorTurnCaptureId priorAmbientCaptureId=$priorAmbientCaptureId priorAgentCaptureId=$priorAgentCaptureId priorPendingAgentResultTurnId=$priorPendingAgentResultTurnId",
      )
    }

    // Ensure capture-mode focus is torn down before playback begins.
    player.endRecognitionCaptureFocus()
    abortPendingPlaybackTerminalAcksForNewTurn(turnId)
    // Drop any leftover audio from a prior turn before this turn's TTS starts.
    player.stop()
  }

  private fun stopTurnCapture() {
    assertMainThread("stopTurnCapture")
    val turnId = activeTurnCaptureId ?: return
    clearTurnCaptureWatchdog(turnId)
    markExpectedTurnCaptureStop(turnId)
    micStreamer.stop(turnId)
    activeTurnCaptureId = null
    player.endRecognitionCaptureFocus()
    emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")
    updateRuntimeState(audioState = "idle")
    maybeDemoteForegroundServiceType(reason = "turn_capture_stopped")
  }

  private fun maybeStartAmbientCapture() {
    if (!runtimeConfig.wakeEnabled || !runtimeConfig.listeningEnabled || !wsConnected) {
      return
    }

    if (!runtimeClientActive) {
      Log.i(
        TAG,
        "ambient_capture_skip reason=client_inactive activeClientConnected=$runtimeActiveClientConnected connectedClients=$runtimeConnectedClients",
      )
      return
    }

    if (activeTurnCaptureId != null || activeAmbientCaptureId != null || activeAgentCaptureId != null) {
      return
    }

    val requestId = "ambient-${UUID.randomUUID()}"
    if (!ensureMicrophoneForegroundType(reason = "ambient_capture_start")) {
      return
    }
    val started = micStreamer.start(
      requestId = requestId,
      onStarted = { sampleRate, channels, encoding ->
        val message = JSONObject()
          .put("type", "turn_listen_stream_start")
          .put("turnId", requestId)
          .put("sampleRate", sampleRate)
          .put("channels", channels)
          .put("encoding", encoding)
        sendSocketText(message.toString())
      },
      onRouteResolved = { route ->
        emitEvent(EVENT_TYPE_MIC_ROUTE, "Mode: Ambient | Device: $route")
      },
      onChunk = { bytes ->
        val message = JSONObject()
          .put("type", "turn_listen_stream_chunk")
          .put("turnId", requestId)
          .put("chunkBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        sendSocketText(message.toString())
      },
      onStopped = {
        val message = JSONObject()
          .put("type", "turn_listen_stream_end")
          .put("turnId", requestId)
        sendSocketText(message.toString())
      },
    )

    if (started) {
      activeAmbientCaptureId = requestId
      Log.i(TAG, "ambient capture started: $requestId")
      emitEvent(EVENT_TYPE_STATUS, "Ambient listening")
    } else {
      Log.w(TAG, "ambient capture start failed: $requestId")
      maybeDemoteForegroundServiceType(reason = "ambient_capture_start_failed")
      scheduleAmbientRestart()
    }
  }

  private fun scheduleAmbientRestart() {
    mainHandler.removeCallbacks(restartAmbientRunnable)
    if (!runtimeConfig.wakeEnabled || !runtimeConfig.listeningEnabled) {
      return
    }
    mainHandler.postDelayed(restartAmbientRunnable, 350)
  }

  private fun stopAmbientCapture() {
    assertMainThread("stopAmbientCapture")
    val ambientId = activeAmbientCaptureId ?: return
    micStreamer.stop(ambientId)
    activeAmbientCaptureId = null
    maybeDemoteForegroundServiceType(reason = "ambient_capture_stopped")
  }

  private fun requestActiveAgentCaptureToggle() {
    assertMainThread("requestActiveAgentCaptureToggle")
    if (activeAgentCaptureId != null) {
      stopActiveAgentCapture(awaitResult = false)
      emitEvent(EVENT_TYPE_STATUS, "Active-agent capture canceled.")
      return
    }
    if (pendingActiveAgentResultTurnId != null) {
      emitEvent(EVENT_TYPE_STATUS, "Voice to Agent is still processing the previous result.")
      return
    }

    if (!runtimeConfig.listeningEnabled) {
      emitEvent(EVENT_TYPE_STATUS, "Listening must be enabled for Voice to Agent.")
      return
    }
    if (!wsConnected) {
      emitEvent(EVENT_TYPE_STATUS, "Voice to Agent requires websocket connection.")
      return
    }
    if (!runtimeClientActive) {
      emitEvent(EVENT_TYPE_STATUS, "Activate this device before Voice to Agent.")
      return
    }
    if (
      activeTurnCaptureId != null ||
      activeAmbientCaptureId != null ||
      activeExternalMediaTurnId != null ||
      !runtimeAudioState.equals("idle", ignoreCase = true)
    ) {
      emitEvent(EVENT_TYPE_STATUS, "Voice to Agent requires idle audio state.")
      return
    }
    val sessionId = activeAgentSessionId?.trim().orEmpty()
    if (sessionId.isEmpty()) {
      emitEvent(EVENT_TYPE_STATUS, "Select a session before Voice to Agent.")
      return
    }

    startActiveAgentCapture()
  }

  private fun startActiveAgentCapture() {
    assertMainThread("startActiveAgentCapture")
    val sessionId = activeAgentSessionId?.trim().orEmpty()
    if (sessionId.isEmpty()) {
      emitEvent(EVENT_TYPE_STATUS, "Select a session before Voice to Agent.")
      return
    }
    if (!ensureMicrophoneForegroundType(reason = "active_agent_capture_start")) {
      return
    }

    stopAmbientCapture()
    stopTurnCapture()
    setPendingActiveAgentResultTurnId(null)

    val requestId = "agent-capture-${UUID.randomUUID()}"
    activeAgentSessionIdByCaptureTurnId[requestId] = sessionId
    activeAgentSessionLabelByCaptureTurnId[requestId] = activeAgentSessionLabel
    val quotedAssistantText = activeAgentQuotedAssistantText.trim()
    if (quotedAssistantText.isNotEmpty()) {
      activeAgentQuotedAssistantTextByCaptureTurnId[requestId] = quotedAssistantText
    }
    activeAgentSendVerbatimByCaptureTurnId[requestId] = activeAgentSendVerbatim
    activeAgentQuotedAssistantText = ""
    activeAgentSendVerbatim = false
    beginExternalMediaSession(requestId)
    cuePlayer.playWakeCue()
    val started = micStreamer.start(
      requestId = requestId,
      onStarted = { sampleRate, channels, encoding ->
        val message = JSONObject()
          .put("type", "turn_listen_stream_start")
          .put("turnId", requestId)
          .put("sampleRate", sampleRate)
          .put("channels", channels)
          .put("encoding", encoding)
        sendSocketText(message.toString())
      },
      onRouteResolved = { route ->
        emitEvent(EVENT_TYPE_MIC_ROUTE, "Mode: Voice to Agent | Device: $route")
      },
      onChunk = { bytes ->
        val message = JSONObject()
          .put("type", "turn_listen_stream_chunk")
          .put("turnId", requestId)
          .put("chunkBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        sendSocketText(message.toString())
      },
      onStopped = {
        val message = JSONObject()
          .put("type", "turn_listen_stream_end")
          .put("turnId", requestId)
        sendSocketText(message.toString())
      },
    )

    if (started) {
      activeAgentCaptureId = requestId
      pendingTurnRecognitionIds.add(requestId)
      syncClientTurnState()
      emitActiveAgentCaptureState()
      emitEvent(EVENT_TYPE_LISTENING_STATE, "active")
      updateRuntimeState(audioState = "capture", turnId = requestId)
      emitEvent(EVENT_TYPE_STATUS, "Voice to Agent listening...")
    } else {
      activeAgentQuotedAssistantTextByCaptureTurnId.remove(requestId)
      activeAgentSendVerbatimByCaptureTurnId.remove(requestId)
      endExternalMediaSession(requestId)
      cuePlayer.playWakeCue()
      emitEvent(EVENT_TYPE_STATUS, "Voice to Agent capture failed to start.")
      maybeDemoteForegroundServiceType(reason = "active_agent_capture_start_failed")
    }
  }

  private fun stopActiveAgentCapture(
    playCompletionCue: Boolean = true,
    awaitResult: Boolean = false,
    restartAmbient: Boolean = true,
    preservePendingRecognition: Boolean = false,
  ) {
    assertMainThread("stopActiveAgentCapture")
    val captureId = activeAgentCaptureId ?: return
    micStreamer.stop(captureId)
    activeAgentCaptureId = null
    maybeDemoteForegroundServiceType(reason = "active_agent_capture_stopped")
    endExternalMediaSession(captureId)
    if (awaitResult) {
      setPendingActiveAgentResultTurnId(captureId)
    } else {
      if (pendingActiveAgentResultTurnId == captureId) {
        setPendingActiveAgentResultTurnId(null)
      }
      if (!preservePendingRecognition) {
        pendingTurnRecognitionIds.remove(captureId)
      }
      activeAgentSessionIdByCaptureTurnId.remove(captureId)
      activeAgentSessionLabelByCaptureTurnId.remove(captureId)
      activeAgentQuotedAssistantTextByCaptureTurnId.remove(captureId)
      activeAgentSendVerbatimByCaptureTurnId.remove(captureId)
    }
    emitActiveAgentCaptureState()
    emitEvent(EVENT_TYPE_LISTENING_STATE, "inactive")
    updateRuntimeState(audioState = "idle", turnId = "")
    if (restartAmbient) {
      maybeStartAmbientCapture()
    }
    if (awaitResult) {
      emitEvent(EVENT_TYPE_STATUS, "Voice to Agent processing...")
    }
    if (playCompletionCue) {
      cuePlayer.playWakeCue()
    }
  }

  private fun stopActiveCapture() {
    assertMainThread("stopActiveCapture")
    stopTurnCapture()
    stopAmbientCapture()
    stopActiveAgentCapture(playCompletionCue = false, restartAmbient = false)
    setPendingActiveAgentResultTurnId(null)
    pendingRecognitionCueByTurnId.clear()
    handledRecognitionCueTurnIds.clear()
    suppressSuccessCueTurnIds.clear()
    turnsStartedWithMediaActive.clear()
    externalMediaSessionIdByTurnId.clear()
    linkedSessionIdByTurnId.clear()
    linkedSessionTitleByTurnId.clear()
    pendingRetryCaptureTurnIds.clear()
    pendingRetryCaptureAttemptsByTurnId.clear()
    stopTtsTurnIds.clear()
    stopTtsTurnIdTimestampById.clear()
    clearAllCaptureRecoveryState()
    clearAllTurnCaptureWatchdogs()
    player.endContinuousReservation()
    endExternalMediaSession()
    updateRuntimeState(audioState = "idle", turnId = "")
  }

  private fun markExpectedTurnCaptureStop(turnId: String) {
    expectedTurnCaptureStopIds.add(turnId)
  }

  private fun clearTurnCaptureRecoveryState(turnId: String) {
    captureChunkSendFailureCountByTurnId.remove(turnId)
    captureRecoveryAttemptsByTurnId.remove(turnId)
    captureRecoveryRunnableByTurnId.remove(turnId)?.let { runnable ->
      mainHandler.removeCallbacks(runnable)
    }
  }

  private fun clearAllCaptureRecoveryState() {
    expectedTurnCaptureStopIds.clear()
    captureChunkSendFailureCountByTurnId.clear()
    captureRecoveryAttemptsByTurnId.clear()
    captureRecoveryRunnableByTurnId.values.forEach { runnable ->
      mainHandler.removeCallbacks(runnable)
    }
    captureRecoveryRunnableByTurnId.clear()
  }

  private fun armTurnCaptureWatchdog(turnId: String) {
    assertMainThread("armTurnCaptureWatchdog")
    clearTurnCaptureWatchdog(turnId)
    val runnable = Runnable {
      runOnMain {
        turnCaptureWatchdogRunnableByTurnId.remove(turnId)
        if (!pendingTurnRecognitionIds.contains(turnId)) {
          return@runOnMain
        }
        if (activeTurnCaptureId != turnId && !micStreamer.isRunningFor(turnId)) {
          return@runOnMain
        }
        Log.w(
          TAG,
          "cue_state capture_watchdog_stop turnId=$turnId timeoutMs=$TURN_CAPTURE_WATCHDOG_MS",
        )
        if (turnId == activeTurnCaptureId) {
          stopTurnCapture()
        } else {
          markExpectedTurnCaptureStop(turnId)
          micStreamer.stop(turnId)
          player.endRecognitionCaptureFocus()
        }
      }
    }
    turnCaptureWatchdogRunnableByTurnId[turnId] = runnable
    mainHandler.postDelayed(runnable, TURN_CAPTURE_WATCHDOG_MS)
  }

  private fun clearTurnCaptureWatchdog(turnId: String) {
    turnCaptureWatchdogRunnableByTurnId.remove(turnId)?.let { runnable ->
      mainHandler.removeCallbacks(runnable)
    }
  }

  private fun clearAllTurnCaptureWatchdogs() {
    turnCaptureWatchdogRunnableByTurnId.values.forEach { runnable ->
      mainHandler.removeCallbacks(runnable)
    }
    turnCaptureWatchdogRunnableByTurnId.clear()
  }

  private fun scheduleTurnCaptureRecovery(turnId: String, reason: String) {
    assertMainThread("scheduleTurnCaptureRecovery")
    if (!runtimeConfig.listeningEnabled || !pendingTurnRecognitionIds.contains(turnId)) {
      clearTurnCaptureRecoveryState(turnId)
      return
    }
    if (quickReplyCaptureSuppressedTurnIds.contains(turnId)) {
      clearTurnCaptureRecoveryState(turnId)
      return
    }
    if (turnId == activeTurnCaptureId || micStreamer.isRunningFor(turnId)) {
      return
    }

    val nextAttempt = (captureRecoveryAttemptsByTurnId[turnId] ?: 0) + 1
    if (nextAttempt > CAPTURE_RECOVERY_MAX_ATTEMPTS) {
      Log.e(
        TAG,
        "cue_state capture_recover_giveup turnId=$turnId reason=$reason attempts=$nextAttempt",
      )
      emitEvent(EVENT_TYPE_STATUS, "Recognition recovery failed for $turnId")
      return
    }
    captureRecoveryAttemptsByTurnId[turnId] = nextAttempt
    captureRecoveryRunnableByTurnId.remove(turnId)?.let { runnable ->
      mainHandler.removeCallbacks(runnable)
    }
    Log.i(
      TAG,
      "cue_state capture_recover_schedule turnId=$turnId reason=$reason attempt=$nextAttempt wsConnected=$wsConnected",
    )
    val runnable = Runnable {
      runOnMain {
        captureRecoveryRunnableByTurnId.remove(turnId)
        if (!pendingTurnRecognitionIds.contains(turnId)) {
          clearTurnCaptureRecoveryState(turnId)
          return@runOnMain
        }
        if (quickReplyCaptureSuppressedTurnIds.contains(turnId)) {
          clearTurnCaptureRecoveryState(turnId)
          return@runOnMain
        }
        if (turnId == activeTurnCaptureId || micStreamer.isRunningFor(turnId)) {
          return@runOnMain
        }
        if (!wsConnected && !stopping) {
          Log.i(
            TAG,
            "cue_state capture_recover_reconnect turnId=$turnId reason=$reason attempt=$nextAttempt",
          )
          connectWebSocket()
        }
        Log.i(
          TAG,
          "cue_state capture_recover_restart turnId=$turnId reason=$reason attempt=$nextAttempt",
        )
        startTurnCapture(turnId, turnListenModelById[turnId])
      }
    }
    captureRecoveryRunnableByTurnId[turnId] = runnable
    mainHandler.postDelayed(runnable, CAPTURE_RECOVERY_DELAY_MS * nextAttempt)
  }

  private fun scheduleRetryCaptureRestart(turnId: String, reason: String) {
    assertMainThread("scheduleRetryCaptureRestart")
    val nextAttempt = (pendingRetryCaptureAttemptsByTurnId[turnId] ?: 0) + 1
    pendingRetryCaptureAttemptsByTurnId[turnId] = nextAttempt
    mainHandler.postDelayed(
      {
        runOnMain {
          if (!pendingTurnRecognitionIds.contains(turnId) || !pendingRetryCaptureTurnIds.contains(turnId)) {
            pendingRetryCaptureAttemptsByTurnId.remove(turnId)
            return@runOnMain
          }
          if (quickReplyCaptureSuppressedTurnIds.contains(turnId)) {
            pendingRetryCaptureTurnIds.remove(turnId)
            pendingRetryCaptureAttemptsByTurnId.remove(turnId)
            return@runOnMain
          }
          val captureStillActive = turnId == activeTurnCaptureId || micStreamer.isRunningFor(turnId)
          if (captureStillActive && nextAttempt < RETRY_CAPTURE_RESTART_MAX_ATTEMPTS) {
            Log.i(
              TAG,
              "cue_state retry_capture_wait turnId=$turnId reason=${reason}_retry attempt=$nextAttempt",
            )
            scheduleRetryCaptureRestart(turnId, reason)
            return@runOnMain
          }
          if (captureStillActive) {
            Log.w(
              TAG,
              "cue_state retry_capture_force_stop turnId=$turnId reason=${reason}_max_attempts attempt=$nextAttempt",
            )
            if (turnId == activeTurnCaptureId) {
              stopTurnCapture()
            } else {
              markExpectedTurnCaptureStop(turnId)
              micStreamer.stop(turnId)
              player.endRecognitionCaptureFocus()
            }
          }
          pendingRetryCaptureTurnIds.remove(turnId)
          pendingRetryCaptureAttemptsByTurnId.remove(turnId)
          Log.i(
            TAG,
            "cue_state retry_capture_restart turnId=$turnId reason=${reason}_drained attempt=$nextAttempt",
          )
          startTurnCapture(turnId, turnListenModelById[turnId])
        }
      },
      RETRY_CAPTURE_RESTART_DELAY_MS,
    )
  }

  private fun maybePlayRecognitionCue(turnId: String, success: Boolean) {
    assertMainThread("maybePlayRecognitionCue")
    if (handledRecognitionCueTurnIds.contains(turnId)) {
      Log.i(TAG, "cue_state maybe_play_skip turnId=$turnId reason=already_handled")
      return
    }
    val captureStillActive = turnId == activeTurnCaptureId || micStreamer.isRunningFor(turnId)
    Log.i(
      TAG,
      "cue_state maybe_play turnId=$turnId success=$success captureStillActive=$captureStillActive activeTurnCaptureId=$activeTurnCaptureId",
    )
    if (!captureStillActive) {
      playRecognitionCue(turnId, success)
      return
    }

    pendingRecognitionCueByTurnId[turnId] = success
    if (turnId == activeTurnCaptureId) {
      stopTurnCapture()
    } else {
      markExpectedTurnCaptureStop(turnId)
      micStreamer.stop(turnId)
      player.endRecognitionCaptureFocus()
    }
  }

  private fun beginExternalMediaSession(turnId: String) {
    assertMainThread("beginExternalMediaSession")
    if (activeExternalMediaTurnId == turnId) {
      Log.i(TAG, "media_pause_skip turnId=$turnId reason=already_active")
      updateRuntimeState(turnId = turnId)
      return
    }

    if (activeExternalMediaTurnId != null) {
      val priorTurnId = activeExternalMediaTurnId
      val priorSessionId = priorTurnId?.let { externalMediaSessionIdByTurnId[it] }
      val priorEnd = externalMediaController.endSession(priorSessionId)
      Log.i(
        TAG,
        "media_pause_end priorTurnId=$priorTurnId priorSessionId=$priorSessionId hadSession=${priorEnd.hadActiveSession} pausedByUs=${priorEnd.wasPausedByUs} playDispatched=${priorEnd.playDispatched} musicActiveAfter=${priorEnd.isMusicActiveAtEnd}",
      )
      if (priorTurnId != null) {
        externalMediaSessionIdByTurnId.remove(priorTurnId)
      }
    }

    activeExternalMediaTurnId = turnId
    if (!runtimeConfig.pauseExternalMediaEnabled) {
      Log.i(TAG, "media_pause_skip turnId=$turnId reason=disabled")
      suppressSuccessCueTurnIds.remove(turnId)
      val startedWithMediaActive = externalMediaController.isMusicActiveNow()
      if (startedWithMediaActive) {
        turnsStartedWithMediaActive.add(turnId)
      } else {
        turnsStartedWithMediaActive.remove(turnId)
      }
      updateRuntimeState(
        mediaState = "passthrough",
        musicState = if (startedWithMediaActive) "start_active" else "start_inactive",
        turnId = turnId,
      )
      return
    }

    updateRuntimeState(mediaState = "pause_pending", turnId = turnId)
    mediaPauseExecutor.execute {
      val begin = externalMediaController.beginSession()
      runOnMain {
        if (activeExternalMediaTurnId != turnId) {
          externalMediaSessionIdByTurnId.remove(turnId)
          externalMediaController.cancelSession(begin.sessionId)
          Log.i(
            TAG,
            "media_pause_begin_stale turnId=$turnId sessionId=${begin.sessionId} activeTurnId=$activeExternalMediaTurnId",
          )
          return@runOnMain
        }
        externalMediaSessionIdByTurnId[turnId] = begin.sessionId
        val startMusicState = if (begin.isMusicActiveAtStart) "start_active" else "start_inactive"
        if (begin.isMusicActiveAtStart) {
          turnsStartedWithMediaActive.add(turnId)
        } else {
          turnsStartedWithMediaActive.remove(turnId)
        }
        Log.i(
          TAG,
          "media_pause_begin turnId=$turnId musicActiveAtStart=${begin.isMusicActiveAtStart} pauseDispatchCount=${begin.pauseDispatchCount} musicActiveAfterPauseAttempts=${begin.isMusicActiveAfterPauseAttempts} pausedByUs=${begin.pausedByUs}",
        )
        if (begin.pausedByUs) {
          suppressSuccessCueTurnIds.add(turnId)
          Log.i(TAG, "cue_state suppress_success_cue turnId=$turnId reason=external_media_paused")
          updateRuntimeState(
            mediaState = "paused_by_us",
            musicState = startMusicState,
            turnId = turnId,
          )
        } else if (begin.isMusicActiveAtStart) {
          updateRuntimeState(
            mediaState = "pause_failed",
            musicState = startMusicState,
            turnId = turnId,
          )
        } else {
          suppressSuccessCueTurnIds.remove(turnId)
          updateRuntimeState(
            mediaState = "passthrough",
            musicState = startMusicState,
            turnId = turnId,
          )
        }
      }
    }
  }

  private fun scheduleExternalMediaEndAfterPlayback(turnId: String) {
    assertMainThread("scheduleExternalMediaEndAfterPlayback")
    val estimatedRemainingMs = player.estimatedPlaybackRemainingMs()
    Log.i(
      TAG,
      "media_pause_end_schedule turnId=$turnId estimatedRemainingMs=$estimatedRemainingMs mode=playback_drain_event",
    )
    if (suppressSuccessCueTurnIds.contains(turnId)) {
      updateRuntimeState(mediaState = "resume_pending", turnId = turnId)
    }
    player.onPlaybackDrained {
      runOnMain {
        if (activeExternalMediaTurnId != turnId) {
          turnsStartedWithMediaActive.remove(turnId)
          Log.i(
            TAG,
            "media_pause_end_schedule_skip turnId=$turnId activeTurnId=$activeExternalMediaTurnId",
          )
          sendPlaybackTerminalAckIfPending(
            turnId = turnId,
            status = "aborted",
            reason = "superseded_before_drain",
          )
          return@runOnMain
        }
        endExternalMediaSession(turnId)
        sendPlaybackTerminalAckIfPending(turnId = turnId, status = "done")
      }
    }
  }

  private fun scheduleTurnCaptureAfterPlaybackDrain(turnId: String) {
    assertMainThread("scheduleTurnCaptureAfterPlaybackDrain")
    val estimatedRemainingMs = player.estimatedPlaybackRemainingMs()
    Log.i(
      TAG,
      "cue_state listen_capture_schedule_after_drain turnId=$turnId estimatedRemainingMs=$estimatedRemainingMs",
    )
    player.onPlaybackDrained {
      runOnMain {
        if (!pendingTurnRecognitionIds.contains(turnId)) {
          Log.i(
            TAG,
            "cue_state listen_capture_skip_after_drain turnId=$turnId reason=recognition_not_pending",
          )
          return@runOnMain
        }
        if (quickReplyCaptureSuppressedTurnIds.contains(turnId)) {
          Log.i(
            TAG,
            "cue_state listen_capture_skip_after_drain turnId=$turnId reason=quick_reply_selected",
          )
          return@runOnMain
        }
        val modelId = turnListenModelById[turnId]
        Log.i(
          TAG,
          "cue_state listen_capture_start_after_drain turnId=$turnId model=${modelId ?: "default"}",
        )
        startTurnCapture(turnId, modelId)
      }
    }
  }

  private fun endExternalMediaSession(turnId: String? = null): ExternalMediaController.EndResult? {
    assertMainThread("endExternalMediaSession")
    val activeTurnId = activeExternalMediaTurnId ?: return null
    if (turnId != null && turnId != activeTurnId) {
      Log.i(TAG, "media_pause_end_skip requestedTurnId=$turnId activeTurnId=$activeTurnId")
      return null
    }

    val expectedSessionId = externalMediaSessionIdByTurnId.remove(activeTurnId)
    val end = externalMediaController.endSession(expectedSessionId)
    Log.i(
      TAG,
      "media_pause_end turnId=$activeTurnId sessionId=$expectedSessionId hadSession=${end.hadActiveSession} pausedByUs=${end.wasPausedByUs} playDispatched=${end.playDispatched} musicActiveAfter=${end.isMusicActiveAtEnd}",
    )
    turnsStartedWithMediaActive.remove(activeTurnId)
    suppressSuccessCueTurnIds.remove(activeTurnId)
    linkedSessionIdByTurnId.remove(activeTurnId)
    linkedSessionTitleByTurnId.remove(activeTurnId)
    activeExternalMediaTurnId = null
    val mediaState = when {
      end.wasPausedByUs && end.playDispatched -> "resumed"
      end.wasPausedByUs -> "resume_pending"
      else -> "passthrough"
    }
    val nextAudioState = if (activeTurnCaptureId != null || activeAgentCaptureId != null) {
      "capture"
    } else {
      "idle"
    }
    val nextTurnId = activeTurnCaptureId ?: activeAgentCaptureId ?: ""
    updateRuntimeState(
      audioState = nextAudioState,
      mediaState = mediaState,
      musicState = if (end.isMusicActiveAtEnd) "end_active" else "end_inactive",
      turnId = nextTurnId,
    )
    return end
  }

  private fun buildActiveAgentLabel(workspace: String, resolvedTitle: String): String {
    return formatLinkedSessionLabel(workspace = workspace, resolvedTitle = resolvedTitle)
  }

  private fun buildActiveAgentDispatchMessage(
    transcript: String,
    quotedAssistantText: String? = null,
    sendVerbatim: Boolean = false,
  ): String {
    val normalizedTranscript = transcript.trim()
    if (sendVerbatim) {
      return normalizedTranscript
    }
    val normalizedQuotedAssistantText = quotedAssistantText?.trim().orEmpty()
    val contextualMessage = if (normalizedQuotedAssistantText.isNotEmpty()) {
      listOf(
        "User is responding to a previous assistant message.",
        "Assistant message:",
        normalizedQuotedAssistantText,
        "User response:",
        normalizedTranscript,
      ).joinToString("\n")
    } else {
      normalizedTranscript
    }
    return contextualMessage + "\n\n" + activeAgentVoiceInstruction
  }

  private fun postActiveAgentMessage(
    transcript: String,
    quotedAssistantText: String? = null,
    sendVerbatim: Boolean = false,
  ) {
    val sessionId = activeAgentSessionId?.trim().orEmpty()
    if (sessionId.isEmpty()) {
      emitEvent(EVENT_TYPE_BUBBLE, "System: Voice-to-session target is not configured.")
      emitEvent(EVENT_TYPE_STATUS, "Voice-to-session send failed: session not configured.")
      return
    }

    val sendUrl = try {
      UrlUtils.sessionDispatchSendUrl(runtimeConfig.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      emitEvent(EVENT_TYPE_BUBBLE, "System: Voice-to-session send failed: invalid API URL.")
      emitEvent(EVENT_TYPE_STATUS, "Voice-to-session send failed: invalid API URL.")
      return
    }

    val message = buildActiveAgentDispatchMessage(
      transcript = transcript,
      quotedAssistantText = quotedAssistantText,
      sendVerbatim = sendVerbatim,
    )
    val payload = JSONObject()
      .put("sessionId", sessionId)
      .put("mode", "custom")
      .put("message", message)
    val request = Request.Builder()
      .url(sendUrl)
      .post(payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
      .build()

    turnRequestClient.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        emitEvent(EVENT_TYPE_BUBBLE, "System: Active-agent send failed: ${e.message ?: "request failed"}")
        emitEvent(EVENT_TYPE_STATUS, "Active-agent send failed.")
      }

      override fun onResponse(call: okhttp3.Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (response.isSuccessful) {
          emitEvent(EVENT_TYPE_STATUS, "Active-agent voice dispatch sent.")
        } else {
          val renderedBody = if (bodyText.isNotBlank()) " ($bodyText)" else ""
          emitEvent(
            EVENT_TYPE_BUBBLE,
            "System: Active-agent send failed: HTTP ${response.code}$renderedBody",
          )
          emitEvent(EVENT_TYPE_STATUS, "Active-agent send failed: HTTP ${response.code}.")
        }
        response.close()
      }
    })
  }

  private fun postWakeIntent(text: String, playCues: Boolean = true) {
    val url = try {
      UrlUtils.wakeIntentUrl(runtimeConfig.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      return
    }

    val body = JSONObject().put("text", text).toString()
      .toRequestBody("application/json; charset=utf-8".toMediaType())

    val request = Request.Builder()
      .url(url)
      .post(body)
      .build()

    if (playCues) {
      cuePlayer.playWakeCue()
    }
    wakeIntentClient.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        Log.w(TAG, "wake intent request failed", e)
        emitEvent(EVENT_TYPE_BUBBLE, "System: Wake intent failed: ${e.message ?: "request failed"}")
        if (playCues) {
          cuePlayer.playWakeCue()
        }
      }

      override fun onResponse(call: okhttp3.Call, response: Response) {
        emitEvent(EVENT_TYPE_BUBBLE, "System: Wake intent HTTP ${response.code}")
        response.close()
        if (playCues) {
          cuePlayer.playWakeCue()
        }
      }
    })
  }

  private fun submitLoopbackTurn() {
    if (!runtimeConfig.listeningEnabled) {
      emitEvent(EVENT_TYPE_STATUS, "Loopback test requires listening enabled.")
      return
    }

    if (loopbackTurnInFlight) {
      emitEvent(EVENT_TYPE_STATUS, "Loopback test already running.")
      return
    }

    val turnUrl = try {
      UrlUtils.turnUrl(runtimeConfig.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      emitEvent(EVENT_TYPE_STATUS, "Loopback test failed: invalid API URL.")
      return
    }

    val body = JSONObject()
      .put("text", loopbackPromptText)
      .put("listen", true)
      .toString()
      .toRequestBody("application/json; charset=utf-8".toMediaType())

    val request = Request.Builder()
      .url(turnUrl)
      .post(body)
      .build()

    loopbackTurnInFlight = true
    emitEvent(EVENT_TYPE_STATUS, "Loopback test submitted. Wait for assistant playback, then speak.")

    turnRequestClient.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        loopbackTurnInFlight = false
        emitEvent(EVENT_TYPE_STATUS, "Loopback request failed: ${e.message ?: "request failed"}")
      }

      override fun onResponse(call: okhttp3.Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        loopbackTurnInFlight = false
        if (response.isSuccessful) {
          emitEvent(EVENT_TYPE_STATUS, "Loopback turn completed.")
        } else {
          val renderedBody = if (bodyText.isNotBlank()) " ($bodyText)" else ""
          emitEvent(EVENT_TYPE_STATUS, "Loopback request failed: HTTP ${response.code}$renderedBody")
        }
        response.close()
      }
    })
  }

  private fun playManualCue() {
    playRecognitionCue(turnId = "manual", success = true)
    emitEvent(EVENT_TYPE_STATUS, "Played cue test sound (media + cue path).")
  }

  private fun requestTurnQuickReply(
    requestedTurnId: String,
    quickReplyText: String,
    quickReplyId: String?,
  ) {
    assertMainThread("requestTurnQuickReply")
    val turnId = requestedTurnId.trim()
    if (turnId.isEmpty()) {
      emitEvent(EVENT_TYPE_STATUS, "Quick reply failed: missing turn.")
      return
    }
    val text = quickReplyText.trim()
    if (text.isEmpty()) {
      emitEvent(EVENT_TYPE_STATUS, "Quick reply failed: empty text.")
      return
    }
    if (!wsConnected) {
      emitEvent(EVENT_TYPE_STATUS, "Quick reply failed: websocket is not connected.")
      return
    }

    quickReplyCaptureSuppressedTurnIds.add(turnId)
    forceLocalPlaybackCancel(turnId = turnId, reason = "local_quick_reply")

    if (turnId == activeTurnCaptureId) {
      stopTurnCapture()
    } else if (micStreamer.isRunningFor(turnId)) {
      markExpectedTurnCaptureStop(turnId)
      micStreamer.stop(turnId)
      player.endRecognitionCaptureFocus()
      maybeDemoteForegroundServiceType(reason = "quick_reply_capture_stop")
    }
    pendingRetryCaptureTurnIds.remove(turnId)
    pendingRetryCaptureAttemptsByTurnId.remove(turnId)
    clearTurnCaptureRecoveryState(turnId)
    clearTurnCaptureWatchdog(turnId)

    val message = JSONObject()
      .put("type", "turn_listen_quick_reply")
      .put("turnId", turnId)
      .put("text", text)
    val normalizedQuickReplyId = quickReplyId?.trim().orEmpty()
    if (normalizedQuickReplyId.isNotEmpty()) {
      message.put("quickReplyId", normalizedQuickReplyId)
    }

    val sent = sendSocketText(message.toString(), markActivity = true)
    if (!sent) {
      clearQuickReplyCaptureSuppressionForTurn(turnId)
      emitEvent(EVENT_TYPE_STATUS, "Quick reply failed: websocket send failed.")
      return
    }

    emitEvent(EVENT_TYPE_STATUS, "Quick reply sent for turn $turnId.")
  }

  private fun requestTurnStopTts(requestedTurnId: String) {
    assertMainThread("requestTurnStopTts")
    val turnId = resolveStopTtsTurnId(requestedTurnId)
    if (turnId == null) {
      emitEvent(EVENT_TYPE_STATUS, "No active turn to stop.")
      return
    }

    if (stopTtsTurnIds.contains(turnId)) {
      emitEvent(EVENT_TYPE_STATUS, "Stop TTS already requested for turn $turnId.")
      return
    }

    Log.i(TAG, "turn_stop_tts requested turnId=$turnId")
    forceLocalPlaybackCancel(turnId = turnId, reason = "local_stop_tts")
    // Do not force local capture start here. Wait for server turn_tts_end to keep
    // listen transition ordered and avoid local playback->capture contention.
    postTurnStopTts(turnId)
    emitEvent(EVENT_TYPE_STATUS, "Stop TTS requested for turn $turnId. Waiting for listen handoff.")
  }

  private fun resolveStopTtsTurnId(requestedTurnId: String): String? {
    return VoiceAdapterService.resolveStopTtsTurnId(
      requestedTurnId = requestedTurnId,
      activeExternalMediaTurnId = activeExternalMediaTurnId,
      runtimeWsActiveTurnId = runtimeWsActiveTurnId(),
    )
  }

  private fun runtimeWsActiveTurnId(): String? {
    return resolveRuntimeWsActiveTurnId(
      activeTurnCaptureId = activeTurnCaptureId,
      activeExternalMediaTurnId = activeExternalMediaTurnId,
      pendingTurnRecognitionIds = pendingTurnRecognitionIds,
    )
  }

  private fun postTurnStopTts(turnId: String) {
    val stopUrl = try {
      UrlUtils.turnStopTtsUrl(runtimeConfig.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      emitEvent(EVENT_TYPE_STATUS, "Stop TTS failed: invalid API URL.")
      return
    }

    val body = JSONObject()
      .put("turnId", turnId)
      .toString()
      .toRequestBody("application/json; charset=utf-8".toMediaType())

    val request = Request.Builder()
      .url(stopUrl)
      .post(body)
      .build()

    turnRequestClient.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        emitEvent(EVENT_TYPE_STATUS, "Stop TTS failed: ${e.message ?: "request failed"}")
      }

      override fun onResponse(call: okhttp3.Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (response.isSuccessful) {
          emitEvent(EVENT_TYPE_STATUS, "Server acknowledged stop TTS.")
        } else {
          val renderedBody = if (bodyText.isNotBlank()) " ($bodyText)" else ""
          emitEvent(EVENT_TYPE_STATUS, "Stop TTS failed: HTTP ${response.code}$renderedBody")
        }
        response.close()
      }
    })
  }

  private fun requestTurnAbort(requestedTurnId: String) {
    assertMainThread("requestTurnAbort")
    val turnId = resolveAbortTurnId(requestedTurnId)
    if (turnId == null) {
      emitEvent(EVENT_TYPE_STATUS, "No active turn to cancel.")
      return
    }

    Log.i(TAG, "turn_abort requested turnId=$turnId")
    locallyCanceledTurnIds.add(turnId)
    forceLocalPlaybackCancel(turnId = turnId, reason = "local_cancel")
    pendingRecognitionCueByTurnId.remove(turnId)
    pendingTurnRecognitionIds.remove(turnId)
    turnListenModelById.remove(turnId)
    clearQuickReplyCaptureSuppressionForTurn(turnId)
    syncClientTurnState()
    pendingRetryCaptureTurnIds.remove(turnId)
    pendingRetryCaptureAttemptsByTurnId.remove(turnId)
    clearTurnCaptureRecoveryState(turnId)
    clearTurnCaptureWatchdog(turnId)
    suppressSuccessCueTurnIds.remove(turnId)
    turnsStartedWithMediaActive.remove(turnId)
    linkedSessionIdByTurnId.remove(turnId)
    linkedSessionTitleByTurnId.remove(turnId)
    handledRecognitionCueTurnIds.add(turnId)
    pruneHandledCueTurnIds()

    if (turnId == activeTurnCaptureId) {
      stopTurnCapture()
    } else if (micStreamer.isRunningFor(turnId)) {
      markExpectedTurnCaptureStop(turnId)
      micStreamer.stop(turnId)
      player.endRecognitionCaptureFocus()
    }

    if (activeExternalMediaTurnId == turnId) {
      endExternalMediaSession(turnId)
    }
    player.endContinuousReservation()
    maybeStartAmbientCapture()
    postTurnCancel(turnId)
    val nextTurnId = activeTurnCaptureId ?: activeExternalMediaTurnId ?: ""
    val nextAudioState = if (activeTurnCaptureId != null) "capture" else "idle"
    updateRuntimeState(audioState = nextAudioState, turnId = nextTurnId)
    emitEvent(EVENT_TYPE_STATUS, "Cancel requested for turn $turnId.")
  }

  private fun resolveAbortTurnId(requestedTurnId: String): String? {
    return VoiceAdapterService.resolveAbortTurnId(
      requestedTurnId = requestedTurnId,
      activeTurnCaptureId = activeTurnCaptureId,
      activeExternalMediaTurnId = activeExternalMediaTurnId,
      pendingTurnRecognitionIds = pendingTurnRecognitionIds,
    )
  }

  private fun postTurnCancel(turnId: String) {
    val cancelUrl = try {
      UrlUtils.turnCancelUrl(runtimeConfig.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      emitEvent(EVENT_TYPE_STATUS, "Turn cancel failed: invalid API URL.")
      return
    }

    val body = JSONObject()
      .put("turnId", turnId)
      .toString()
      .toRequestBody("application/json; charset=utf-8".toMediaType())

    val request = Request.Builder()
      .url(cancelUrl)
      .post(body)
      .build()

    turnRequestClient.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        emitEvent(EVENT_TYPE_STATUS, "Turn cancel failed: ${e.message ?: "request failed"}")
      }

      override fun onResponse(call: okhttp3.Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (response.isSuccessful) {
          emitEvent(EVENT_TYPE_STATUS, "Turn canceled on server.")
        } else {
          val renderedBody = if (bodyText.isNotBlank()) " ($bodyText)" else ""
          emitEvent(EVENT_TYPE_STATUS, "Turn cancel failed: HTTP ${response.code}$renderedBody")
        }
        response.close()
      }
    })
  }

  private fun playRecognitionCue(turnId: String, success: Boolean) {
    assertMainThread("playRecognitionCue")
    if (turnId != "manual" && handledRecognitionCueTurnIds.contains(turnId)) {
      Log.i(TAG, "cue_state play_skip turnId=$turnId reason=already_handled")
      return
    }
    Log.i(TAG, "cue_state play turnId=$turnId success=$success")
    updateRuntimeState(audioState = "playback", turnId = turnId)
    if (turnId != "manual") {
      handledRecognitionCueTurnIds.add(turnId)
      pruneHandledCueTurnIds()
      clearTurnCaptureWatchdog(turnId)
    }
    playRecognitionCueWithRetry(success, attempt = 0)
  }

  private fun pruneHandledCueTurnIds() {
    if (handledRecognitionCueTurnIds.size <= 128) {
      return
    }
    handledRecognitionCueTurnIds.clear()
  }

  private fun playRecognitionCueWithRetry(success: Boolean, attempt: Int) {
    // Recognition cues stay on the same media playback path as TTS to avoid delayed
    // notification-usage playback policies on some devices.
    val played = player.playCueProbe(success)
    Log.i(
      TAG,
      "cue_state play_attempt success=$success attempt=$attempt played=$played",
    )
    if (played) {
      mainHandler.postDelayed(
        {
          val activeTurnId = activeTurnCaptureId ?: activeExternalMediaTurnId ?: ""
          val nextAudioState = if (activeTurnCaptureId != null) "capture" else "idle"
          updateRuntimeState(
            audioState = nextAudioState,
            turnId = activeTurnId,
          )
        },
        320L,
      )
      return
    }
    if (attempt >= 2) {
      emitEvent(EVENT_TYPE_STATUS, "Recognition cue unavailable: playback focus denied.")
      return
    }
    mainHandler.postDelayed(
      { playRecognitionCueWithRetry(success, attempt + 1) },
      90L * (attempt + 1),
    )
  }
}
