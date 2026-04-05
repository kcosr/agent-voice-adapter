package com.agentvoiceadapter.android

import android.Manifest
import android.net.Uri
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.app.Dialog
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.WindowInsetsCompat
import io.noties.markwon.Markwon
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.syntax.Prism4jThemeDarkula
import io.noties.markwon.syntax.Prism4jThemeDefault
import io.noties.markwon.syntax.SyntaxHighlightPlugin
import io.noties.prism4j.GrammarLocator
import io.noties.prism4j.Prism4j
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max

class MainActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "MainActivity"

    internal data class SessionDispatchRowRaw(
      val sessionId: String? = null,
      val sessionIdSnake: String? = null,
      val workspace: String? = null,
      val title: String? = null,
      val dynamicTitle: String? = null,
      val dynamicTitleSnake: String? = null,
      val resolvedTitle: String? = null,
    )

    internal data class SessionDispatchRowParsed(
      val sessionId: String,
      val workspace: String,
      val title: String,
      val dynamicTitle: String,
      val resolvedTitle: String,
    )

    internal data class ServerRuntimeSettingsParsed(
      val asrListenStartTimeoutMs: Int,
      val asrListenCompletionTimeoutMs: Int,
      val asrRecognitionEndSilenceMs: Int,
      val queueAdvanceDelayMs: Int,
      val prependLinkedSessionLabelForTts: Boolean,
    )

    internal data class RuntimeStatusParsed(
      val ws: String,
      val audio: String,
      val media: String,
      val music: String,
      val turnId: String,
    )

    internal data class ActiveClientStateParsed(
      val active: Boolean,
      val activeClientConnected: Boolean,
      val connectedClients: Int,
    )

    internal fun parseSessionDispatchRowsPayload(bodyText: String): List<SessionDispatchRowParsed> {
      val trimmed = bodyText.trim()
      if (trimmed.isEmpty()) {
        return emptyList()
      }

      val sessionsArray = if (trimmed.startsWith("{")) {
        JSONObject(trimmed).optJSONArray("sessions") ?: JSONArray()
      } else {
        JSONArray(trimmed)
      }

      val rawRows = mutableListOf<SessionDispatchRowRaw>()
      for (index in 0 until sessionsArray.length()) {
        val session = sessionsArray.optJSONObject(index) ?: continue
        rawRows.add(
          SessionDispatchRowRaw(
            sessionId = session.optString("sessionId", ""),
            sessionIdSnake = session.optString("session_id", ""),
            workspace = session.optString("workspace", ""),
            title = session.optString("title", ""),
            dynamicTitle = session.optString("dynamicTitle", ""),
            dynamicTitleSnake = session.optString("dynamic_title", ""),
            resolvedTitle = session.optString("resolvedTitle", ""),
          ),
        )
      }

      return normalizeSessionDispatchRows(rawRows)
    }

    internal fun normalizeSessionDispatchRows(rawRows: List<SessionDispatchRowRaw>): List<SessionDispatchRowParsed> {
      val rows = mutableListOf<SessionDispatchRowParsed>()
      for (row in rawRows) {
        val sessionId = row.sessionId.orEmpty().ifBlank { row.sessionIdSnake.orEmpty() }.trim()
        if (sessionId.isEmpty()) {
          continue
        }

        val workspace = row.workspace.orEmpty().trim()
        val title = row.title.orEmpty().trim()
        val dynamicTitle = row.dynamicTitle.orEmpty().ifBlank { row.dynamicTitleSnake.orEmpty() }.trim()
        val resolvedTitle = row.resolvedTitle.orEmpty().trim().ifEmpty {
          title.ifEmpty { dynamicTitle.ifEmpty { sessionId } }
        }

        rows.add(
          SessionDispatchRowParsed(
            sessionId = sessionId,
            workspace = workspace,
            title = title,
            dynamicTitle = dynamicTitle,
            resolvedTitle = resolvedTitle,
          ),
        )
      }
      return rows
    }

    internal fun parseServerRuntimeSettingsPayload(payload: JSONObject): ServerRuntimeSettingsParsed? {
      val start = payload.optInt("asrListenStartTimeoutMs", -1)
      val completion = payload.optInt("asrListenCompletionTimeoutMs", -1)
      val endSilence = payload.optInt("asrRecognitionEndSilenceMs", -1)
      val queueDelay = payload.optInt("queueAdvanceDelayMs", -1)
      val prependLinkedSessionLabelForTts = payload.optBoolean("prependLinkedSessionLabelForTts", false)
      return parseServerRuntimeSettingsValues(
        asrListenStartTimeoutMs = start,
        asrListenCompletionTimeoutMs = completion,
        asrRecognitionEndSilenceMs = endSilence,
        queueAdvanceDelayMs = queueDelay,
        prependLinkedSessionLabelForTts = prependLinkedSessionLabelForTts,
      )
    }

    internal fun parseServerRuntimeSettingsValues(
      asrListenStartTimeoutMs: Int,
      asrListenCompletionTimeoutMs: Int,
      asrRecognitionEndSilenceMs: Int,
      queueAdvanceDelayMs: Int,
      prependLinkedSessionLabelForTts: Boolean,
    ): ServerRuntimeSettingsParsed? {
      val start = asrListenStartTimeoutMs
      val completion = asrListenCompletionTimeoutMs
      val endSilence = asrRecognitionEndSilenceMs
      val queueDelay = queueAdvanceDelayMs
      if (start <= 0 || completion <= 0 || endSilence <= 0 || queueDelay < 0) {
        return null
      }

      return ServerRuntimeSettingsParsed(
        asrListenStartTimeoutMs = start,
        asrListenCompletionTimeoutMs = completion,
        asrRecognitionEndSilenceMs = endSilence,
        queueAdvanceDelayMs = queueDelay,
        prependLinkedSessionLabelForTts = prependLinkedSessionLabelForTts,
      )
    }

    internal fun parseRuntimeStatusPayload(
      raw: String,
      fallback: RuntimeStatusParsed,
    ): RuntimeStatusParsed? {
      return try {
        val payload = JSONObject(raw)
        mergeRuntimeStatusPayload(
          ws = payload.optString("ws", fallback.ws),
          audio = payload.optString("audio", fallback.audio),
          media = payload.optString("media", fallback.media),
          music = payload.optString("music", fallback.music),
          turnId = payload.optString("turnId", fallback.turnId),
          fallback = fallback,
        )
      } catch (_: JSONException) {
        null
      }
    }

    internal fun mergeRuntimeStatusPayload(
      ws: String?,
      audio: String?,
      media: String?,
      music: String?,
      turnId: String?,
      fallback: RuntimeStatusParsed,
    ): RuntimeStatusParsed {
      return RuntimeStatusParsed(
        ws = ws.orEmpty().trim().ifEmpty { fallback.ws },
        audio = audio.orEmpty().trim().ifEmpty { fallback.audio },
        media = media.orEmpty().trim().ifEmpty { fallback.media },
        music = music.orEmpty().trim().ifEmpty { fallback.music },
        turnId = turnId.orEmpty().trim(),
      )
    }

    internal fun parseActiveClientStatePayload(
      raw: String,
      fallback: ActiveClientStateParsed,
    ): ActiveClientStateParsed? {
      return try {
        val payload = JSONObject(raw)
        mergeActiveClientStatePayload(
          active = if (payload.has("active")) payload.optBoolean("active", fallback.active) else null,
          activeClientConnected = if (payload.has("activeClientConnected")) {
            payload.optBoolean("activeClientConnected", fallback.activeClientConnected)
          } else {
            null
          },
          connectedClients = if (payload.has("connectedClients")) {
            payload.optInt("connectedClients", fallback.connectedClients)
          } else {
            null
          },
          fallback = fallback,
        )
      } catch (_: JSONException) {
        null
      }
    }

    internal fun mergeActiveClientStatePayload(
      active: Boolean?,
      activeClientConnected: Boolean?,
      connectedClients: Int?,
      fallback: ActiveClientStateParsed,
    ): ActiveClientStateParsed {
      return ActiveClientStateParsed(
        active = active ?: fallback.active,
        activeClientConnected = activeClientConnected ?: fallback.activeClientConnected,
        connectedClients = connectedClients ?: fallback.connectedClients,
      )
    }

    internal fun normalizeMarkdownFrontMatterText(text: String): String {
      if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
        return text
      }

      val lines = text.split("\n")
      if (lines.size < 3 || lines.first().trim() != "---") {
        return text
      }

      var closingIndex = -1
      for (index in 1 until lines.size) {
        val marker = lines[index].trim()
        if (marker == "---" || marker == "...") {
          closingIndex = index
          break
        }
      }
      if (closingIndex <= 1) {
        return text
      }

      val frontMatterLines = lines.subList(1, closingIndex)
      val looksLikeYaml = frontMatterLines.any { it.contains(":") }
      if (!looksLikeYaml) {
        return text
      }

      val normalizedFrontMatter = buildString {
        append("```yaml\n")
        append(frontMatterLines.joinToString("\n"))
        append("\n```")
      }
      val rest = lines.drop(closingIndex + 1).joinToString("\n")
      if (rest.trim().isEmpty()) {
        return normalizedFrontMatter
      }
      return "$normalizedFrontMatter\n\n$rest"
    }

    internal const val ATTACHMENT_DECODE_STATE_OK = "ok"
    internal const val ATTACHMENT_DECODE_STATE_INVALID_BASE64 = "invalid_base64"
    internal const val ATTACHMENT_DECODE_STATE_PREVIEW_UNAVAILABLE = "preview_unavailable"

    internal fun resolveAttachmentPreviewMode(fileName: String, contentType: String): String {
      if (AttachmentContentTypeResolver.isHtmlAttachment(fileName, contentType)) {
        return "html"
      }
      val baseType = contentType.trim().lowercase().substringBefore(';').trim()
      return when {
        baseType == "text/markdown" -> "markdown"
        baseType.startsWith("text/") && baseType != "text/html" -> "text"
        else -> "none"
      }
    }

    internal fun decodeAttachmentDataBase64(dataBase64: String): ByteArray? {
      val normalized = dataBase64.trim()
      if (normalized.isEmpty()) {
        return null
      }
      return try {
        Base64.getDecoder().decode(normalized)
      } catch (_: IllegalArgumentException) {
        null
      }
    }

    internal fun decodeAttachmentPreviewText(bytes: ByteArray): String? {
      return try {
        val decoder = Charsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
        decoder.decode(ByteBuffer.wrap(bytes)).toString()
      } catch (_: CharacterCodingException) {
        null
      }
    }

    internal fun sanitizeAttachmentFileName(fileName: String, fallback: String = "attachment"): String {
      val basename = fileName.trim().substringAfterLast('/').substringAfterLast('\\')
      val cleaned = buildString {
        for (char in basename) {
          val code = char.code
          if (code < 32 || code == 127) {
            continue
          }
          if (char in charArrayOf('<', '>', ':', '"', '|', '?', '*')) {
            append('_')
          } else {
            append(char)
          }
        }
      }
      val sanitized = cleaned
        .trim('.')
        .trim()
      return sanitized.ifEmpty { fallback }
    }

    internal fun buildInvalidAttachmentFileName(fileName: String): String {
      return "${sanitizeAttachmentFileName(fileName)}.invalid"
    }
  }

  private lateinit var apiUrlInput: EditText
  private lateinit var serviceSwitch: Switch
  private lateinit var speechSwitch: Switch
  private lateinit var listenSwitch: Switch
  private lateinit var wakeSwitch: Switch
  private lateinit var continuousFocusSwitch: Switch
  private lateinit var pauseExternalMediaSwitch: Switch
  private lateinit var sendToAgentButton: ImageButton
  private lateinit var voiceToAgentButton: ImageButton
  private lateinit var activateClientButton: ImageButton
  private lateinit var activeAgentStatusText: TextView
  private lateinit var activeClientStatusText: TextView
  private lateinit var showStatusBarSwitch: Switch
  private lateinit var themeSpinner: Spinner
  private lateinit var ttsGainSlider: SeekBar
  private lateinit var ttsGainValueText: TextView
  private lateinit var recognitionCueGainSlider: SeekBar
  private lateinit var recognitionCueGainValueText: TextView
  private lateinit var playbackStartupPrerollInput: EditText
  private lateinit var playbackBufferInput: EditText
  private lateinit var recognitionCueModeSpinner: Spinner
  private lateinit var micDeviceSpinner: Spinner
  private lateinit var applyButton: Button
  private lateinit var loopbackTestButton: Button
  private lateinit var testCueButton: Button
  private lateinit var agentSessionsButton: Button
  private lateinit var clearChatButton: Button
  private lateinit var backgroundSettingsButton: Button
  private lateinit var settingsToggleButton: Button
  private lateinit var loadServerSettingsButton: Button
  private lateinit var applyServerSettingsButton: Button
  private lateinit var serverListenStartTimeoutInput: EditText
  private lateinit var serverListenCompletionTimeoutInput: EditText
  private lateinit var serverEndSilenceInput: EditText
  private lateinit var serverQueueAdvanceDelayInput: EditText
  private lateinit var serverPrependLinkedSessionLabelSwitch: Switch
  private lateinit var settingsSection: View
  private lateinit var chatScrollView: ScrollView
  private lateinit var rootContent: LinearLayout
  private lateinit var headerBar: LinearLayout
  private lateinit var statusText: TextView
  private lateinit var sessionFilterScroll: HorizontalScrollView
  private lateinit var sessionFilterChipContainer: LinearLayout
  private lateinit var micRouteText: TextView
  private lateinit var chatContainer: LinearLayout
  private lateinit var recognitionIndicatorText: TextView
  private lateinit var statusBarContainer: LinearLayout
  private lateinit var statusChipWsText: TextView
  private lateinit var statusChipAudioText: TextView
  private lateinit var statusChipMediaText: TextView
  private lateinit var statusChipMusicText: TextView

  private var micOptions: List<MicDeviceOption> = emptyList()
  private val recognitionCueModes = listOf(
    RecognitionCueModeOption(RecognitionCueModes.MEDIA_INACTIVE_ONLY, "Only when media inactive"),
    RecognitionCueModeOption(RecognitionCueModes.ALWAYS, "Always"),
    RecognitionCueModeOption(RecognitionCueModes.OFF, "Off"),
  )
  private val sessionDispatchClient = OkHttpClient.Builder()
    .callTimeout(20, TimeUnit.SECONDS)
    .build()
  private val prefsFileName = "agent_voice_adapter_prefs"
  private val batteryPromptPrefsKey = "asked_battery_optimization_prompt"
  private val settingsExpandedPrefsKey = "settings_expanded"
  private val serviceEnabledPrefsKey = "service_enabled"
  private val statusBarVisiblePrefsKey = "status_bar_visible"
  private val sessionFilterSessionIdPrefsKey = "session_filter_session_id"
  private val attachmentPreviewZoomSpPrefsKey = "attachment_preview_zoom_sp"
  private lateinit var currentTheme: AppTheme
  private val sessionDispatchVoiceInstruction =
    "Use the agent-voice-adapter-cli skill to continue the conversation with the user."
  private val bubbleReferenceCannedResponseText =
    "Resume the conversation where you left off and continue the current task with the user over voice using the agent-voice-adapter-cli skill."
  private val attachmentPreviewMaxLines = 12
  private val attachmentPreviewMaxChars = 600
  private val markwon: Markwon by lazy {
    val builder = Markwon.builder(this)
      .usePlugin(TablePlugin.create(this))
    buildPrism4j()?.let { prism4j ->
      val prismTheme = if (currentTheme.isDark) {
        Prism4jThemeDarkula.create()
      } else {
        Prism4jThemeDefault.create()
      }
      builder.usePlugin(SyntaxHighlightPlugin.create(prism4j, prismTheme))
    }
    builder.build()
  }

  private fun buildPrism4j(): Prism4j? {
    return try {
      val locatorClass = Class.forName("com.agentvoiceadapter.android.GrammarLocatorDef")
      val locator = locatorClass.getDeclaredConstructor().newInstance() as GrammarLocator
      Prism4j(locator)
    } catch (_: Throwable) {
      null
    }
  }

  private data class BubbleAttachment(
    val dataBase64: String,
    val decodedBytes: ByteArray?,
    val previewText: String?,
    val fileName: String,
    val contentType: String,
    val previewMode: String,
    val decodeState: String,
  )

  private data class BubbleAttachmentPreview(
    val text: String,
    val truncated: Boolean,
  )

  private data class BubbleQuickReply(
    val id: String,
    val label: String,
    val text: String,
    val defaultResume: Boolean,
  )

  private data class RuntimeStatusState(
    val ws: String,
    val audio: String,
    val media: String,
    val music: String,
    val turnId: String,
  )

  private data class ActiveClientState(
    val active: Boolean,
    val activeClientConnected: Boolean,
    val connectedClients: Int,
  )

  private data class BubbleRenderModel(
    val role: String,
    val body: String,
    val noWait: Boolean,
    val turnId: String,
    val linkedSessionId: String,
    val linkedSessionTitle: String,
    val attachment: BubbleAttachment?,
    val quickReplies: List<BubbleQuickReply>,
  )

  private data class BubbleViewState(
    val role: String,
    val noWait: Boolean,
    val turnId: String,
    val allowInactiveQuickReplies: Boolean,
    val quickReplyConsumed: Boolean,
  )

  private data class PendingAttachmentDownload(
    val fileName: String,
    val bytes: ByteArray,
    val mimeType: String,
  )

  private var runtimeStatusState = RuntimeStatusState(
    ws = "stopped",
    audio = "idle",
    media = "passthrough",
    music = "unknown",
    turnId = "",
  )
  private var activeClientState = ActiveClientState(
    active = false,
    activeClientConnected = false,
    connectedClients = 0,
  )
  private var cachedSessionDispatchRows: List<SessionDispatchRow> = emptyList()
  private var activeAgentCaptureActive = false
  private var headerBarBaseTopPadding = 0
  private var rootContentBaseBottomPadding = 0
  private var chatScrollViewBaseBottomPadding = 0
  private var selectedSessionFilterId = SessionFilterUtils.GLOBAL_FILTER_ID
  private var renderedSessionFilterIds: List<String> = listOf(SessionFilterUtils.GLOBAL_FILTER_ID)
  private val sessionFilterChipButtonsById = linkedMapOf<String, Button>()
  private var recognitionIndicatorActive = false
  private val bubblePulseDurationMs = 850L
  private val bubblePulseMinAlphaFraction = 0.55f
  private val bubblePulseFrameMs = 16L
  private val bubbleQuickReplyRowTagPrefix = "bubble_quick_reply_row:"
  private val bubbleHeaderActionTagPrefix = "bubble_header_action:"
  private val bubbleHeaderActionStateLogCache = mutableMapOf<String, String>()
  private val sessionChipPulseMinAlphaFraction = 0.45f
  private val stopTtsCaptureHandoffGraceMs = 4500L
  private var activeBubblePulseView: View? = null
  private var activeBubblePulseRunnable: Runnable? = null
  private var activeBubblePulseStartedAtMs: Long = 0L
  private var activeSessionChipPulseRunnable: Runnable? = null
  private var activeSessionChipPulseStartedAtMs: Long = 0L
  private var activeSessionChipPulseSessionId: String = ""
  private var stopTtsCaptureHandoffSessionId: String = ""
  private var stopTtsCaptureHandoffExpiresAtMs: Long = 0L
  private var localCaptureSourceBubbleTurnId: String = ""
  private var pendingLocalCaptureSourceBubbleTurnId: String = ""
  private var pendingLocalCaptureSourceSetAtMs: Long = 0L
  private var activeCaptureSessionIdHint: String = ""
  private var activeCaptureSessionIdHintTurnId: String = ""
  private var lastActiveChipTurnId: String = ""
  private var lastActiveChipSessionId: String = ""
  private var sessionFilterSwipeStartX = 0f
  private var sessionFilterSwipeStartY = 0f
  private var sessionFilterSwipeStartEventMs = 0L
  private var pendingAttachmentDownload: PendingAttachmentDownload? = null
  private val createAttachmentDocumentLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult(),
  ) { result ->
    val pending = pendingAttachmentDownload ?: return@registerForActivityResult
    pendingAttachmentDownload = null

    if (result.resultCode != RESULT_OK) {
      statusText.text = "Download canceled."
      return@registerForActivityResult
    }

    val destinationUri = result.data?.data
    if (destinationUri == null) {
      statusText.text = "Download canceled."
      return@registerForActivityResult
    }

    try {
      contentResolver.openOutputStream(destinationUri)?.use { stream ->
        stream.write(pending.bytes)
      } ?: throw IOException("file picker output stream unavailable")
      statusText.text = "Saved: ${pending.fileName}"
    } catch (_: IOException) {
      statusText.text = "Failed to save attachment."
    }
  }

  private data class SessionDispatchRow(
    val sessionId: String,
    val workspace: String,
    val title: String,
    val dynamicTitle: String,
    val resolvedTitle: String,
  )

  private data class ActiveAgentTarget(
    val sessionId: String,
    val workspace: String,
    val resolvedTitle: String,
  )

  private data class ActiveSessionChipState(
    val sessionId: String,
    val pulse: Boolean,
  )

  private data class ServerRuntimeSettings(
    val asrListenStartTimeoutMs: Int,
    val asrListenCompletionTimeoutMs: Int,
    val asrRecognitionEndSilenceMs: Int,
    val queueAdvanceDelayMs: Int,
    val prependLinkedSessionLabelForTts: Boolean,
  )

  private data class RecognitionCueModeOption(
    val value: String,
    val label: String,
  )

  private val eventReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != VoiceAdapterService.ACTION_EVENT) {
        return
      }

      when (intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_TYPE)) {
        VoiceAdapterService.EVENT_TYPE_STATUS -> {
          val message = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          if (message.isNotEmpty()) {
            statusText.text = message
            applyLegacyStatusHeuristics(message)
          }
        }

        VoiceAdapterService.EVENT_TYPE_MIC_ROUTE -> {
          val message = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          if (message.isNotEmpty()) {
            micRouteText.text = "Active mic route\n$message"
          }
        }

        VoiceAdapterService.EVENT_TYPE_BUBBLE -> {
          val message = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          if (message.isNotEmpty()) {
            appendBubble(message)
          }
        }

        VoiceAdapterService.EVENT_TYPE_LISTENING_STATE -> {
          val state = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          val active = state.equals("active", ignoreCase = true)
          setRecognitionIndicator(active)
          if (active) {
            mergeRuntimeStatusState(audio = "capture")
          } else if (runtimeStatusState.audio.equals("capture", ignoreCase = true)) {
            mergeRuntimeStatusState(audio = "idle")
          }
        }

        VoiceAdapterService.EVENT_TYPE_RUNTIME_STATE -> {
          val message = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          if (message.isNotBlank()) {
            parseRuntimeStatusState(message)?.let { parsed ->
              val previousTurnId = runtimeStatusState.turnId
              val previousAudio = runtimeStatusState.audio
              runtimeStatusState = parsed
              maybeClearLocalCaptureSourceBubbleTurnId()
              maybeRefreshBubblesForActivePlaybackTurn()
              renderRuntimeStatusBar()
              renderActiveClientControls()
              renderVoiceToAgentControls()
              updateActiveTurnBubbleOutline()
              updateRecognitionIndicatorPresentation()
              if (
                previousTurnId != parsed.turnId ||
                !previousAudio.equals(parsed.audio, ignoreCase = true)
              ) {
                renderSessionFilterTabs(BubbleHistoryStore.readAll(this@MainActivity))
              }
            }
          }
        }

        VoiceAdapterService.EVENT_TYPE_ACTIVE_CLIENT_STATE -> {
          val message = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          if (message.isNotBlank()) {
            parseActiveClientState(message)?.let { parsed ->
              activeClientState = parsed
              renderActiveClientControls()
              renderVoiceToAgentControls()
            }
          }
        }

        VoiceAdapterService.EVENT_TYPE_ACTIVE_AGENT_CAPTURE_STATE -> {
          val message = intent.getStringExtra(VoiceAdapterService.EXTRA_EVENT_MESSAGE).orEmpty()
          if (message.isNotBlank()) {
            parseActiveAgentCaptureState(message)?.let { active ->
              val changed = activeAgentCaptureActive != active
              activeAgentCaptureActive = active
              Log.i(
                TAG,
                "ui_active_agent_capture_state active=$active changed=$changed audio=${runtimeStatusState.audio} listening=$recognitionIndicatorActive turnId=${runtimeStatusState.turnId}",
              )
              if (!active) {
                activeCaptureSessionIdHint = ""
                activeCaptureSessionIdHintTurnId = ""
                pendingLocalCaptureSourceBubbleTurnId = ""
                pendingLocalCaptureSourceSetAtMs = 0L
                maybeClearLocalCaptureSourceBubbleTurnId()
              } else if (activeCaptureSessionIdHint.isEmpty()) {
                activeCaptureSessionIdHint = resolveSelectedSessionTarget()?.sessionId.orEmpty().trim()
                activeCaptureSessionIdHintTurnId = ""
              }
              if (active && pendingLocalCaptureSourceBubbleTurnId.isNotEmpty()) {
                localCaptureSourceBubbleTurnId = pendingLocalCaptureSourceBubbleTurnId
                pendingLocalCaptureSourceBubbleTurnId = ""
                pendingLocalCaptureSourceSetAtMs = 0L
              }
              renderVoiceToAgentControls()
              updateActiveTurnBubbleOutline()
              updateRecognitionIndicatorPresentation()
              if (changed) {
                renderSessionFilterTabs(BubbleHistoryStore.readAll(this@MainActivity))
              }
            }
          }
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    currentTheme = AppTheme.resolve(this)
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)

    apiUrlInput = findViewById(R.id.api_url_input)
    serviceSwitch = findViewById(R.id.service_switch)
    speechSwitch = findViewById(R.id.speech_switch)
    listenSwitch = findViewById(R.id.listen_switch)
    wakeSwitch = findViewById(R.id.wake_switch)
    continuousFocusSwitch = findViewById(R.id.continuous_focus_switch)
    pauseExternalMediaSwitch = findViewById(R.id.pause_external_media_switch)
    sendToAgentButton = findViewById(R.id.send_to_agent_button)
    voiceToAgentButton = findViewById(R.id.voice_to_agent_button)
    activateClientButton = findViewById(R.id.activate_client_button)
    activeAgentStatusText = findViewById(R.id.active_agent_status_text)
    activeClientStatusText = findViewById(R.id.active_client_status_text)
    showStatusBarSwitch = findViewById(R.id.status_bar_switch)
    themeSpinner = findViewById(R.id.theme_spinner)
    ttsGainSlider = findViewById(R.id.tts_gain_slider)
    ttsGainValueText = findViewById(R.id.tts_gain_value_text)
    recognitionCueGainSlider = findViewById(R.id.recognition_cue_gain_slider)
    recognitionCueGainValueText = findViewById(R.id.recognition_cue_gain_value_text)
    playbackStartupPrerollInput = findViewById(R.id.playback_startup_preroll_input)
    playbackBufferInput = findViewById(R.id.playback_buffer_input)
    recognitionCueModeSpinner = findViewById(R.id.recognition_cue_mode_spinner)
    micDeviceSpinner = findViewById(R.id.mic_device_spinner)
    applyButton = findViewById(R.id.apply_button)
    loopbackTestButton = findViewById(R.id.loopback_test_button)
    testCueButton = findViewById(R.id.test_cue_button)
    agentSessionsButton = findViewById(R.id.agent_sessions_button)
    clearChatButton = findViewById(R.id.clear_chat_button)
    backgroundSettingsButton = findViewById(R.id.background_settings_button)
    settingsToggleButton = findViewById(R.id.settings_toggle_button)
    loadServerSettingsButton = findViewById(R.id.load_server_settings_button)
    applyServerSettingsButton = findViewById(R.id.apply_server_settings_button)
    serverListenStartTimeoutInput = findViewById(R.id.server_listen_start_timeout_input)
    serverListenCompletionTimeoutInput = findViewById(R.id.server_listen_completion_timeout_input)
    serverEndSilenceInput = findViewById(R.id.server_end_silence_input)
    serverQueueAdvanceDelayInput = findViewById(R.id.server_queue_advance_delay_input)
    serverPrependLinkedSessionLabelSwitch = findViewById(R.id.server_prepend_linked_session_label_switch)
    settingsSection = findViewById(R.id.settings_section)
    chatScrollView = findViewById(R.id.chat_scroll_view)
    rootContent = findViewById(R.id.root_content)
    headerBar = findViewById(R.id.app_header_bar)
    statusText = findViewById(R.id.status_text)
    sessionFilterScroll = findViewById(R.id.session_filter_scroll)
    sessionFilterChipContainer = findViewById(R.id.session_filter_chip_container)
    micRouteText = findViewById(R.id.mic_route_text)
    chatContainer = findViewById(R.id.chat_container)
    recognitionIndicatorText = findViewById(R.id.recognition_indicator_text)
    statusBarContainer = findViewById(R.id.status_bar_container)
    statusChipWsText = findViewById(R.id.status_chip_ws)
    statusChipAudioText = findViewById(R.id.status_chip_audio)
    statusChipMediaText = findViewById(R.id.status_chip_media)
    statusChipMusicText = findViewById(R.id.status_chip_music)
    headerBarBaseTopPadding = headerBar.paddingTop
    rootContentBaseBottomPadding = rootContent.paddingBottom
    chatScrollViewBaseBottomPadding = chatScrollView.paddingBottom

    requestRuntimePermissionsIfNeeded()
    applyWindowInsets()
    setSettingsExpanded(loadSettingsExpandedPreference(), persist = false)
    setRecognitionIndicator(active = false)
    showStatusBarSwitch.isChecked = loadStatusBarVisiblePreference()
    setupThemeSpinner()
    applyTheme()
    setStatusBarVisible(showStatusBarSwitch.isChecked, persist = false)
    selectedSessionFilterId = loadSessionFilterSelection()
    renderRuntimeStatusBar()
    renderActiveClientControls()
    renderVoiceToAgentControls()
    renderSessionFilterTabs(emptyList())

    val saved = AdapterPrefs.load(this)
    setupRecognitionCueModeSpinner(saved.recognitionCueMode)
    apiUrlInput.setText(saved.apiBaseUrl)
    serviceSwitch.isChecked = loadServiceEnabledPreference()
    speechSwitch.isChecked = saved.speechEnabled
    listenSwitch.isChecked = saved.listeningEnabled
    wakeSwitch.isChecked = saved.wakeEnabled
    continuousFocusSwitch.isChecked = saved.continuousFocusEnabled
    pauseExternalMediaSwitch.isChecked = saved.pauseExternalMediaEnabled
    ttsGainSlider.progress = (saved.ttsGain * 100f).toInt().coerceIn(25, 500)
    setTtsGainLabel(ttsGainSlider.progress)
    recognitionCueGainSlider.progress = (saved.recognitionCueGain * 100f).toInt().coerceIn(25, 500)
    setRecognitionCueGainLabel(recognitionCueGainSlider.progress)
    playbackStartupPrerollInput.setText(saved.playbackStartupPrerollMs.toString())
    playbackBufferInput.setText(saved.playbackBufferMs.toString())

    showStatusBarSwitch.setOnCheckedChangeListener { _, isChecked ->
      setStatusBarVisible(isChecked)
    }

    applyTheme()

    ttsGainSlider.setOnSeekBarChangeListener(
      object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
          val normalized = progress.coerceIn(25, 500)
          if (normalized != progress) {
            seekBar?.progress = normalized
            return
          }
          setTtsGainLabel(normalized)
        }

        override fun onStartTrackingTouch(seekBar: SeekBar?) {
          // no-op
        }

        override fun onStopTrackingTouch(seekBar: SeekBar?) {
          // no-op
        }
      },
    )

    recognitionCueGainSlider.setOnSeekBarChangeListener(
      object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
          val normalized = progress.coerceIn(25, 500)
          if (normalized != progress) {
            seekBar?.progress = normalized
            return
          }
          setRecognitionCueGainLabel(normalized)
        }

        override fun onStartTrackingTouch(seekBar: SeekBar?) {
          // no-op
        }

        override fun onStopTrackingTouch(seekBar: SeekBar?) {
          // no-op
        }
      },
    )

    refreshMicOptions(saved.selectedMicDeviceId)

    applyButton.setOnClickListener {
      val config = readConfigFromUi()
      AdapterPrefs.save(this, config)
      saveServiceEnabledPreference(serviceSwitch.isChecked)

      if (serviceSwitch.isChecked) {
        maybePromptBatteryOptimizationExemption()
        ContextCompat.startForegroundService(this, VoiceAdapterService.startIntent(this, config))
        statusText.text = "Service running."
        mergeRuntimeStatusState(ws = "connecting", audio = "idle", media = "passthrough")
      } else {
        startService(VoiceAdapterService.updateIntent(this, config))
        statusText.text = "Saved settings. Service not running."
        mergeRuntimeStatusState(ws = "stopped", audio = "idle", media = "passthrough")
      }
    }

    activateClientButton.setOnClickListener {
      requestClientActivationToggle()
    }

    sendToAgentButton.setOnClickListener {
      requestVoiceToAgentCapture(sendVerbatim = true)
    }

    voiceToAgentButton.setOnClickListener {
      requestVoiceToAgentCapture()
    }

    loopbackTestButton.setOnClickListener {
      submitLoopbackTest()
    }

    testCueButton.setOnClickListener {
      submitCueTest()
    }

    agentSessionsButton.setOnClickListener {
      openSessionDispatchDialog()
    }

    settingsToggleButton.setOnClickListener {
      setSettingsExpanded(settingsSection.visibility != View.VISIBLE)
    }

    loadServerSettingsButton.setOnClickListener {
      loadServerSettings()
    }

    applyServerSettingsButton.setOnClickListener {
      applyServerSettings()
    }

    clearChatButton.setOnClickListener {
      BubbleHistoryStore.clear(this)
      val clearedAttachmentExports = HtmlAttachmentExportStore.clear(this)
      selectedSessionFilterId = SessionFilterUtils.GLOBAL_FILTER_ID
      saveSessionFilterSelection(selectedSessionFilterId)
      renderPersistedBubbles(scrollToBottom = false)
      statusText.text =
        if (clearedAttachmentExports > 0) {
          "Cleared response history and $clearedAttachmentExports attachment export(s)."
        } else {
          "Cleared response history."
        }
    }

    backgroundSettingsButton.setOnClickListener {
      val requested = requestIgnoreBatteryOptimizations()
      openApplicationBatterySettings()
      statusText.text =
        if (requested) {
          "Opened battery optimization and app settings."
        } else {
          "Opened app settings."
        }
    }

    chatScrollView.setOnTouchListener { _, event ->
      handleSessionFilterSwipe(event)
      false
    }

    recognitionIndicatorText.setOnClickListener {
      handleRecognitionIndicatorTap()
    }

    serviceSwitch.setOnCheckedChangeListener { _, isChecked ->
      val config = readConfigFromUi()
      AdapterPrefs.save(this, config)
      saveServiceEnabledPreference(isChecked)

      if (isChecked) {
        maybePromptBatteryOptimizationExemption()
        ContextCompat.startForegroundService(this, VoiceAdapterService.startIntent(this, config))
        statusText.text = "Service started."
        mergeRuntimeStatusState(ws = "connecting", audio = "idle", media = "passthrough")
      } else {
        startService(VoiceAdapterService.stopIntent(this))
        statusText.text = "Service stopped."
        mergeRuntimeStatusState(ws = "stopped", audio = "idle", media = "passthrough")
      }
      renderActiveClientControls()
      renderVoiceToAgentControls()
    }

    if (serviceSwitch.isChecked) {
      maybePromptBatteryOptimizationExemption()
      ContextCompat.startForegroundService(this, VoiceAdapterService.startIntent(this, readConfigFromUi()))
      statusText.text = "Service started."
      mergeRuntimeStatusState(ws = "connecting", audio = "idle", media = "passthrough")
    } else {
      statusText.text = "Service is off (saved setting)."
      mergeRuntimeStatusState(ws = "stopped", audio = "idle", media = "passthrough")
    }
    renderActiveClientControls()
    renderVoiceToAgentControls()

    loadServerSettings()
  }

  override fun onStart() {
    super.onStart()
    val filter = IntentFilter(VoiceAdapterService.ACTION_EVENT)
    ContextCompat.registerReceiver(this, eventReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    setRecognitionIndicator(active = false)
    refreshMicOptionsFromCurrentSelection()
    renderPersistedBubbles()
    if (serviceSwitch.isChecked) {
      // Re-sync service runtime snapshots on foreground resume so active-client UI does not
      // depend on whether an event happened while the activity was backgrounded.
      // Use explicit snapshot action to avoid mutating runtime config/state on resume.
      startService(VoiceAdapterService.snapshotIntent(this))
    }
  }

  override fun onStop() {
    stopActiveBubblePulse()
    stopActiveSessionChipPulse()
    unregisterReceiver(eventReceiver)
    super.onStop()
  }

  private fun refreshMicOptions(selectedDeviceId: String) {
    val defaults = listOf(MicDeviceOption(id = "", label = "Default mic (system route)"))
    micOptions = defaults + AudioDeviceUtils.listInputDevices(this)

    val labels = micOptions.map { it.label }
    val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels)
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
    micDeviceSpinner.adapter = adapter

    val selectedIndex = micOptions.indexOfFirst { it.id == selectedDeviceId }.let { index ->
      if (index >= 0) index else 0
    }
    micDeviceSpinner.setSelection(selectedIndex)
  }

  private fun refreshMicOptionsFromCurrentSelection() {
    val selectedIndex = micDeviceSpinner.selectedItemPosition
    val selectedDeviceId = if (selectedIndex in micOptions.indices) {
      micOptions[selectedIndex].id
    } else {
      ""
    }
    refreshMicOptions(selectedDeviceId)
  }

  private fun setupRecognitionCueModeSpinner(selectedMode: String) {
    val labels = recognitionCueModes.map { it.label }
    val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels)
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
    recognitionCueModeSpinner.adapter = adapter

    val normalized = RecognitionCueModes.normalize(selectedMode)
    val selectedIndex = recognitionCueModes.indexOfFirst { it.value == normalized }.let { index ->
      if (index >= 0) index else 0
    }
    recognitionCueModeSpinner.setSelection(selectedIndex)
  }

  private fun readConfigFromUi(): AdapterRuntimeConfig {
    val selectedIndex = micDeviceSpinner.selectedItemPosition
    val selectedMicDeviceId = if (selectedIndex in micOptions.indices) {
      micOptions[selectedIndex].id
    } else {
      ""
    }
    val cueModeIndex = recognitionCueModeSpinner.selectedItemPosition
    val selectedCueMode = if (cueModeIndex in recognitionCueModes.indices) {
      recognitionCueModes[cueModeIndex].value
    } else {
      AdapterDefaults.RECOGNITION_CUE_MODE
    }
    val playbackStartupPrerollMs = playbackStartupPrerollInput.text
      ?.toString()
      ?.trim()
      ?.toIntOrNull()
      ?.coerceIn(0, 2_000)
      ?: AdapterDefaults.PLAYBACK_STARTUP_PREROLL_MS
    val playbackBufferMs = playbackBufferInput.text
      ?.toString()
      ?.trim()
      ?.toIntOrNull()
      ?.coerceIn(100, 30_000)
      ?: AdapterDefaults.PLAYBACK_BUFFER_MS

    return AdapterRuntimeConfig(
      apiBaseUrl = UrlUtils.normalizeBaseUrl(apiUrlInput.text?.toString().orEmpty()),
      acceptingTurns = true,
      speechEnabled = speechSwitch.isChecked,
      listeningEnabled = listenSwitch.isChecked,
      wakeEnabled = wakeSwitch.isChecked,
      selectedMicDeviceId = selectedMicDeviceId,
      continuousFocusEnabled = continuousFocusSwitch.isChecked,
      pauseExternalMediaEnabled = pauseExternalMediaSwitch.isChecked,
      recognitionCueMode = RecognitionCueModes.normalize(selectedCueMode),
      ttsGain = (ttsGainSlider.progress.coerceIn(25, 500) / 100f),
      recognitionCueGain = (recognitionCueGainSlider.progress.coerceIn(25, 500) / 100f),
      playbackStartupPrerollMs = playbackStartupPrerollMs,
      playbackBufferMs = playbackBufferMs,
    )
  }

  private fun setTtsGainLabel(percent: Int) {
    ttsGainValueText.text = "TTS gain: ${percent}%"
  }

  private fun setRecognitionCueGainLabel(percent: Int) {
    recognitionCueGainValueText.text = "Recognition cue gain: ${percent}%"
  }

  private fun submitLoopbackTest() {
    val config = readConfigFromUi()

    if (!serviceSwitch.isChecked) {
      statusText.text = "Loopback test requires foreground service enabled."
      return
    }

    if (!config.listeningEnabled) {
      statusText.text = "Loopback test requires Listening enabled."
      return
    }

    AdapterPrefs.save(this, config)
    startService(VoiceAdapterService.updateIntent(this, config))
    statusText.text = "Loopback test submitted. Wait for assistant playback, then speak."
    startService(VoiceAdapterService.loopbackIntent(this, config))
  }

  private fun submitCueTest() {
    val config = readConfigFromUi()
    if (!serviceSwitch.isChecked) {
      statusText.text = "Cue test requires foreground service enabled."
      return
    }
    AdapterPrefs.save(this, config)
    startService(VoiceAdapterService.updateIntent(this, config))
    startService(VoiceAdapterService.testCueIntent(this, config))
    statusText.text = "Cue test requested."
  }

  private fun openSessionDispatchDialog() {
    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    val theme = currentTheme
    val density = resources.displayMetrics.density

    val content = LayoutInflater.from(this).inflate(R.layout.dialog_session_dispatch, null, false)
    content.setBackgroundColor(theme.surfaceContainer)
    val closeButton = content.findViewById<ImageButton>(R.id.session_dispatch_close_button)
    val hintText = content.findViewById<TextView>(R.id.session_dispatch_hint_text)
    val filterInput = content.findViewById<EditText>(R.id.session_dispatch_filter_input)
    val refreshButton = content.findViewById<Button>(R.id.session_dispatch_refresh_button)
    val progress = content.findViewById<ProgressBar>(R.id.session_dispatch_progress)
    val sessionList = content.findViewById<ListView>(R.id.session_dispatch_list)
    val clearSessionButton = content.findViewById<Button>(R.id.session_dispatch_clear_session_button)
    val customMessageInput = content.findViewById<EditText>(R.id.session_dispatch_custom_message_input)
    val sendButton = content.findViewById<Button>(R.id.session_dispatch_send_button)
    val dialogStatusText = content.findViewById<TextView>(R.id.session_dispatch_status_text)
    var allSessions: List<SessionDispatchRow> = emptyList()
    var filteredSessions: List<SessionDispatchRow> = emptyList()
    var modalSelectedSessionId: String? = null
    var modalLoading = false
    var dialog: AlertDialog? = null

    closeButton.imageTintList = ColorStateList.valueOf(theme.textSecondary)
    hintText.setTextColor(theme.textTertiary)
    theme.styleInput(filterInput, density)
    theme.styleInput(customMessageInput, density)
    theme.styleSecondaryButton(refreshButton, density)
    theme.styleDestructiveButton(clearSessionButton, density)
    theme.styleSecondaryButton(sendButton, density)
    dialogStatusText.setTextColor(theme.textTertiary)
    sessionList.background = theme.makeChatAreaDrawable(density)

    fun selectedSessionById(): SessionDispatchRow? {
      val selectedId = modalSelectedSessionId ?: return null
      return filteredSessions.firstOrNull { it.sessionId == selectedId }
        ?: allSessions.firstOrNull { it.sessionId == selectedId }
    }

    fun updateSendButtonState() {
      val selected = selectedSessionById()
      val clearEnabled = !modalLoading && selected != null
      clearSessionButton.isEnabled = clearEnabled
      clearSessionButton.alpha = if (clearEnabled) 1f else 0.5f

      val hasSelectedSession = selectedSessionById() != null
      val hasMessage = customMessageInput.text?.toString()?.trim()?.isNotEmpty() == true
      val enabled = !modalLoading && hasSelectedSession && hasMessage
      sendButton.isEnabled = enabled
      sendButton.alpha = if (enabled) 1f else 0.5f
    }

    fun startVoiceCaptureForSession(row: SessionDispatchRow, sendVerbatim: Boolean = false): Boolean {
      if (!serviceSwitch.isChecked) {
        dialogStatusText.text = "Run foreground service to use Voice to Agent."
        return false
      }
      if (!listenSwitch.isChecked) {
        dialogStatusText.text = "Listening must be enabled to use Voice to Agent."
        return false
      }

      val runtimeConfig = readConfigFromUi()
      AdapterPrefs.save(this, runtimeConfig)
      activeCaptureSessionIdHint = row.sessionId.trim()
      activeCaptureSessionIdHintTurnId = ""
      startService(
        VoiceAdapterService.captureActiveAgentIntent(
          context = this,
          config = runtimeConfig,
          sessionId = row.sessionId,
          workspace = row.workspace,
          resolvedTitle = row.resolvedTitle,
          sendVerbatim = sendVerbatim,
        ),
      )
      val label = formatWorkspaceAndTitle(row.workspace, row.resolvedTitle)
      dialogStatusText.text = if (sendVerbatim) {
        "Verbatim capture started for $label."
      } else {
        "Voice capture started for $label."
      }
      statusText.text = if (sendVerbatim) {
        "Verbatim send requested for selected session."
      } else {
        "Voice capture requested for selected session."
      }
      return true
    }

    lateinit var listAdapter: ArrayAdapter<SessionDispatchRow>
    fun renderSessionList() {
      listAdapter.clear()
      listAdapter.addAll(filteredSessions)
      listAdapter.notifyDataSetChanged()
    }

    listAdapter = object : ArrayAdapter<SessionDispatchRow>(
      this,
      R.layout.item_session_dispatch_row,
      mutableListOf(),
    ) {
      override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val rowView = convertView ?: LayoutInflater.from(context).inflate(
          R.layout.item_session_dispatch_row,
          parent,
          false,
        )
        val checkedText = rowView.findViewById<TextView>(android.R.id.text1)
        val sendIconButton = rowView.findViewById<ImageButton>(R.id.session_dispatch_row_send_button)
        val voiceButton = rowView.findViewById<ImageButton>(R.id.session_dispatch_row_voice_button)
        val row = getItem(position) ?: return rowView
        val isModalSelected = row.sessionId == modalSelectedSessionId

        checkedText.text = sessionDispatchRowLabel(row)
        rowView.isActivated = isModalSelected
        rowView.background = GradientDrawable().apply {
          shape = GradientDrawable.RECTANGLE
          cornerRadius = 12f * resources.displayMetrics.density
          val strokePx = resources.displayMetrics.density.toInt().coerceAtLeast(1)
          if (isModalSelected) {
            setColor(currentTheme.accentSubtle)
            setStroke(strokePx.coerceAtLeast(2), currentTheme.accent)
          } else {
            setColor(currentTheme.surface)
            setStroke(strokePx, currentTheme.borderSubtle)
          }
        }

        val selectRow = {
          modalSelectedSessionId = row.sessionId
          renderSessionList()
          updateSendButtonState()
        }
        rowView.setOnClickListener { selectRow() }
        checkedText.setOnClickListener { selectRow() }

        val label = formatWorkspaceAndTitle(row.workspace, row.resolvedTitle)
        sendIconButton.contentDescription = "Verbatim send to $label"
        sendIconButton.imageTintList = ColorStateList.valueOf(currentTheme.accent)
        sendIconButton.setOnClickListener {
          selectRow()
          if (startVoiceCaptureForSession(row, sendVerbatim = true)) {
            dialog?.dismiss()
          }
        }

        voiceButton.contentDescription = "Voice send to $label"
        voiceButton.imageTintList = ColorStateList.valueOf(currentTheme.recognitionText)
        voiceButton.setOnClickListener {
          selectRow()
          if (startVoiceCaptureForSession(row)) {
            dialog?.dismiss()
          }
        }

        return rowView
      }
    }
    sessionList.adapter = listAdapter
    sessionList.choiceMode = ListView.CHOICE_MODE_NONE

    fun applyFilter() {
      val query = filterInput.text?.toString()?.trim()?.lowercase().orEmpty()
      filteredSessions = if (query.isEmpty()) {
        allSessions
      } else {
        allSessions.filter {
          it.workspace.lowercase().contains(query) || it.resolvedTitle.lowercase().contains(query)
        }
      }
      renderSessionList()
    }

    fun setLoading(isLoading: Boolean) {
      modalLoading = isLoading
      progress.visibility = if (isLoading) View.VISIBLE else View.GONE
      refreshButton.isEnabled = !isLoading
      customMessageInput.isEnabled = !isLoading
      updateSendButtonState()
    }

    fun refreshSessions() {
      setLoading(true)
      dialogStatusText.text = "Loading sessions..."
      fetchSessionDispatchSessions(
        config = config,
        onSuccess = { rows ->
          cachedSessionDispatchRows = rows
          renderSessionFilterTabs(BubbleHistoryStore.readAll(this))
          allSessions = rows
          if (modalSelectedSessionId != null && rows.none { it.sessionId == modalSelectedSessionId }) {
            modalSelectedSessionId = null
          }
          applyFilter()
          dialogStatusText.text = "Loaded ${rows.size} active sessions."
          setLoading(false)
        },
        onError = { error ->
          allSessions = emptyList()
          filteredSessions = emptyList()
          modalSelectedSessionId = null
          renderSessionList()
          dialogStatusText.text = error
          setLoading(false)
        },
      )
    }

    sessionList.setOnItemClickListener { _, _, position, _ ->
      val selected = filteredSessions.getOrNull(position) ?: return@setOnItemClickListener
      modalSelectedSessionId = selected.sessionId
      renderSessionList()
      updateSendButtonState()
    }

    filterInput.addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
          // no-op
        }

        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
          applyFilter()
        }

        override fun afterTextChanged(s: Editable?) {
          // no-op
        }
      },
    )

    customMessageInput.addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
          // no-op
        }

        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
          updateSendButtonState()
        }

        override fun afterTextChanged(s: Editable?) {
          // no-op
        }
      },
    )

    refreshButton.setOnClickListener {
      refreshSessions()
    }

    closeButton.setOnClickListener {
      dialog?.dismiss()
    }

    clearSessionButton.setOnClickListener {
      val selected = selectedSessionById()
      if (selected == null) {
        dialogStatusText.text = "Select a session before clearing."
        return@setOnClickListener
      }

      val historyMessages = BubbleHistoryStore.readAll(this@MainActivity)
      val removal = SessionFilterUtils.removeMessagesForSession(
        messages = historyMessages,
        targetSessionId = selected.sessionId,
        resolveSessionId = { message -> classifyBubble(message).linkedSessionId },
      )
      if (removal.removedCount <= 0) {
        dialogStatusText.text = "No messages found for selected session."
        return@setOnClickListener
      }

      BubbleHistoryStore.replaceAll(this@MainActivity, removal.keptMessages)
      renderPersistedBubbles(scrollToBottom = false)
      val label = formatWorkspaceAndTitle(selected.workspace, selected.resolvedTitle)
      dialogStatusText.text = "Cleared ${removal.removedCount} message(s) for $label."
      statusText.text = "Cleared session messages for $label."
    }

    sendButton.setOnClickListener {
      val selected = selectedSessionById()
      if (selected == null) {
        dialogStatusText.text = "Select a session before sending."
        return@setOnClickListener
      }

      val customMessage = customMessageInput.text?.toString().orEmpty()
      val customMessageTrimmed = customMessage.trim()
      if (customMessageTrimmed.isEmpty()) {
        dialogStatusText.text = "Enter a message before sending."
        return@setOnClickListener
      }
      val dispatchMessage = buildSessionDispatchCustomMessage(customMessageTrimmed)

      setLoading(true)
      dialogStatusText.text = "Sending..."
      sendSessionDispatchMessage(
        config = config,
        sessionId = selected.sessionId,
        mode = "custom",
        customMessage = dispatchMessage,
        onSuccess = { bytes ->
          val localBubble = JSONObject()
            .put("kind", "bubble")
            .put("role", "user")
            .put("body", customMessageTrimmed)
            .put("linkedSessionId", selected.sessionId)
            .put("linkedSessionTitle", selected.resolvedTitle)
            .toString()
          BubbleHistoryStore.append(this@MainActivity, localBubble)
          appendBubble(localBubble)
          dialogStatusText.text = "Sent ($bytes bytes)."
          statusText.text =
            "Session dispatch sent to ${formatWorkspaceAndTitle(selected.workspace, selected.resolvedTitle)}."
          setLoading(false)
          dialog?.dismiss()
        },
        onError = { error ->
          dialogStatusText.text = error
          setLoading(false)
        }
      )
    }

    dialog = AlertDialog.Builder(this)
      .setView(content)
      .create()
    dialog.show()
    dialog.window?.let { window ->
      val metrics = resources.displayMetrics
      window.setLayout((metrics.widthPixels * 0.96f).toInt(), (metrics.heightPixels * 0.9f).toInt())
      window.setBackgroundDrawableResource(android.R.color.transparent)
      val params = window.attributes
      params.gravity = Gravity.TOP
      window.attributes = params
    }
    val bottomInset = ViewCompat.getRootWindowInsets(rootContent)?.let { resolveBottomSafeInset(it) } ?: 0
    if (bottomInset > 0) {
      content.setPadding(
        content.paddingLeft,
        content.paddingTop,
        content.paddingRight,
        content.paddingBottom + bottomInset,
      )
    }

    updateSendButtonState()
    refreshSessions()
  }

  private fun buildSessionDispatchCustomMessage(userMessage: String): String {
    val trimmed = userMessage.trim()
    if (trimmed.contains("agent-voice-adapter-cli skill", ignoreCase = true)) {
      return trimmed
    }
    return "$trimmed\n\n$sessionDispatchVoiceInstruction"
  }

  private fun sessionDispatchRowLabel(row: SessionDispatchRow): String {
    val workspace = row.workspace.ifBlank { "(no workspace)" }
    return "Workspace: $workspace\nTitle: ${row.resolvedTitle}"
  }

  private fun fetchSessionDispatchSessions(
    config: AdapterRuntimeConfig,
    onSuccess: (List<SessionDispatchRow>) -> Unit,
    onError: (String) -> Unit,
  ) {
    val sessionsUrl = try {
      UrlUtils.sessionDispatchSessionsUrl(config.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      onError("Session list failed: invalid API URL.")
      return
    }

    val request = Request.Builder()
      .url(sessionsUrl)
      .get()
      .build()

    sessionDispatchClient.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        runOnUiThread {
          onError("Session list failed: ${e.message ?: "request failed"}")
        }
      }

      override fun onResponse(call: Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
          response.close()
          runOnUiThread {
            onError("Session list failed: HTTP ${response.code}")
          }
          return
        }

        val rows = try {
          parseSessionDispatchRows(bodyText)
        } catch (error: JSONException) {
          response.close()
          runOnUiThread {
            onError("Session list failed: invalid JSON response.")
          }
          return
        }

        response.close()
        runOnUiThread {
          onSuccess(rows)
        }
      }
    })
  }

  private fun parseSessionDispatchRows(bodyText: String): List<SessionDispatchRow> {
    return parseSessionDispatchRowsPayload(bodyText).map { parsed ->
      SessionDispatchRow(
        sessionId = parsed.sessionId,
        workspace = parsed.workspace,
        title = parsed.title,
        dynamicTitle = parsed.dynamicTitle,
        resolvedTitle = parsed.resolvedTitle,
      )
    }
  }

  private fun sendSessionDispatchMessage(
    config: AdapterRuntimeConfig,
    sessionId: String,
    mode: String,
    customMessage: String?,
    onSuccess: (Int) -> Unit,
    onError: (String) -> Unit,
  ) {
    val sendUrl = try {
      UrlUtils.sessionDispatchSendUrl(config.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      onError("Send failed: invalid API URL.")
      return
    }

    val payload = JSONObject()
      .put("sessionId", sessionId)
      .put("mode", mode)
    if (!customMessage.isNullOrBlank()) {
      payload.put("message", customMessage)
    }

    val request = Request.Builder()
      .url(sendUrl)
      .post(payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
      .build()

    sessionDispatchClient.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        runOnUiThread {
          onError("Send failed: ${e.message ?: "request failed"}")
        }
      }

      override fun onResponse(call: Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
          response.close()
          runOnUiThread {
            onError("Send failed: HTTP ${response.code}")
          }
          return
        }

        val bytes = try {
          JSONObject(bodyText).optInt("bytes", 0)
        } catch (_: JSONException) {
          0
        }
        response.close()
        runOnUiThread {
          onSuccess(bytes)
        }
      }
    })
  }

  private fun loadServerSettings() {
    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    setServerSettingsUiEnabled(false)
    fetchServerRuntimeSettings(
      config = config,
      onSuccess = { settings ->
        populateServerSettingsInputs(settings)
        statusText.text = "Loaded server settings."
        setServerSettingsUiEnabled(true)
      },
      onError = { error ->
        statusText.text = error
        setServerSettingsUiEnabled(true)
      },
    )
  }

  private fun applyServerSettings() {
    val parsed = readServerSettingsFromInputs()
    if (parsed == null) {
      statusText.text = "Server settings must be numeric (timeouts > 0, queue delay >= 0)."
      return
    }

    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    setServerSettingsUiEnabled(false)
    updateServerRuntimeSettings(
      config = config,
      settings = parsed,
      onSuccess = { applied ->
        populateServerSettingsInputs(applied)
        statusText.text = "Applied server settings (global)."
        setServerSettingsUiEnabled(true)
      },
      onError = { error ->
        statusText.text = error
        setServerSettingsUiEnabled(true)
      },
    )
  }

  private fun setServerSettingsUiEnabled(enabled: Boolean) {
    loadServerSettingsButton.isEnabled = enabled
    applyServerSettingsButton.isEnabled = enabled
    serverPrependLinkedSessionLabelSwitch.isEnabled = enabled
  }

  private fun populateServerSettingsInputs(settings: ServerRuntimeSettings) {
    serverListenStartTimeoutInput.setText(settings.asrListenStartTimeoutMs.toString())
    serverListenCompletionTimeoutInput.setText(settings.asrListenCompletionTimeoutMs.toString())
    serverEndSilenceInput.setText(settings.asrRecognitionEndSilenceMs.toString())
    serverQueueAdvanceDelayInput.setText(settings.queueAdvanceDelayMs.toString())
    serverPrependLinkedSessionLabelSwitch.isChecked = settings.prependLinkedSessionLabelForTts
  }

  private fun readServerSettingsFromInputs(): ServerRuntimeSettings? {
    val startTimeout = serverListenStartTimeoutInput.text?.toString()?.trim()?.toIntOrNull()
    val completionTimeout = serverListenCompletionTimeoutInput.text?.toString()?.trim()?.toIntOrNull()
    val endSilence = serverEndSilenceInput.text?.toString()?.trim()?.toIntOrNull()
    val queueDelay = serverQueueAdvanceDelayInput.text?.toString()?.trim()?.toIntOrNull()

    if (
      startTimeout == null || startTimeout <= 0 ||
      completionTimeout == null || completionTimeout <= 0 ||
      endSilence == null || endSilence <= 0 ||
      queueDelay == null || queueDelay < 0
    ) {
      return null
    }

    return ServerRuntimeSettings(
      asrListenStartTimeoutMs = startTimeout,
      asrListenCompletionTimeoutMs = completionTimeout,
      asrRecognitionEndSilenceMs = endSilence,
      queueAdvanceDelayMs = queueDelay,
      prependLinkedSessionLabelForTts = serverPrependLinkedSessionLabelSwitch.isChecked,
    )
  }

  private fun fetchServerRuntimeSettings(
    config: AdapterRuntimeConfig,
    onSuccess: (ServerRuntimeSettings) -> Unit,
    onError: (String) -> Unit,
  ) {
    val settingsUrl = try {
      UrlUtils.serverSettingsUrl(config.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      onError("Server settings failed: invalid API URL.")
      return
    }

    val request = Request.Builder()
      .url(settingsUrl)
      .get()
      .build()

    sessionDispatchClient.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        runOnUiThread {
          onError("Server settings failed: ${e.message ?: "request failed"}")
        }
      }

      override fun onResponse(call: Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
          response.close()
          runOnUiThread {
            onError("Server settings failed: HTTP ${response.code}")
          }
          return
        }

        val parsed = try {
          parseServerRuntimeSettings(JSONObject(bodyText))
        } catch (_: JSONException) {
          null
        }
        response.close()
        runOnUiThread {
          if (parsed == null) {
            onError("Server settings failed: invalid JSON response.")
          } else {
            onSuccess(parsed)
          }
        }
      }
    })
  }

  private fun updateServerRuntimeSettings(
    config: AdapterRuntimeConfig,
    settings: ServerRuntimeSettings,
    onSuccess: (ServerRuntimeSettings) -> Unit,
    onError: (String) -> Unit,
  ) {
    val settingsUrl = try {
      UrlUtils.serverSettingsUrl(config.apiBaseUrl)
    } catch (_: IllegalArgumentException) {
      onError("Server settings update failed: invalid API URL.")
      return
    }

    val payload = JSONObject()
      .put("asrListenStartTimeoutMs", settings.asrListenStartTimeoutMs)
      .put("asrListenCompletionTimeoutMs", settings.asrListenCompletionTimeoutMs)
      .put("asrRecognitionEndSilenceMs", settings.asrRecognitionEndSilenceMs)
      .put("queueAdvanceDelayMs", settings.queueAdvanceDelayMs)
      .put("prependLinkedSessionLabelForTts", settings.prependLinkedSessionLabelForTts)

    val request = Request.Builder()
      .url(settingsUrl)
      .patch(payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
      .build()

    sessionDispatchClient.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        runOnUiThread {
          onError("Server settings update failed: ${e.message ?: "request failed"}")
        }
      }

      override fun onResponse(call: Call, response: Response) {
        val bodyText = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
          response.close()
          runOnUiThread {
            onError("Server settings update failed: HTTP ${response.code}")
          }
          return
        }

        val parsed = try {
          parseServerRuntimeSettings(JSONObject(bodyText))
        } catch (_: JSONException) {
          null
        }
        response.close()
        runOnUiThread {
          if (parsed == null) {
            onError("Server settings update failed: invalid JSON response.")
          } else {
            onSuccess(parsed)
          }
        }
      }
    })
  }

  private fun parseServerRuntimeSettings(payload: JSONObject): ServerRuntimeSettings? {
    val parsed = parseServerRuntimeSettingsPayload(payload) ?: return null
    return ServerRuntimeSettings(
      asrListenStartTimeoutMs = parsed.asrListenStartTimeoutMs,
      asrListenCompletionTimeoutMs = parsed.asrListenCompletionTimeoutMs,
      asrRecognitionEndSilenceMs = parsed.asrRecognitionEndSilenceMs,
      queueAdvanceDelayMs = parsed.queueAdvanceDelayMs,
      prependLinkedSessionLabelForTts = parsed.prependLinkedSessionLabelForTts,
    )
  }

  private fun applyWindowInsets() {
    ViewCompat.setOnApplyWindowInsetsListener(rootContent) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val bottomSafeInset = resolveBottomSafeInset(insets)
      view.setPadding(0, 0, 0, rootContentBaseBottomPadding + bottomSafeInset)
      headerBar.setPadding(
        headerBar.paddingLeft,
        headerBarBaseTopPadding + bars.top,
        headerBar.paddingRight,
        headerBar.paddingBottom,
      )
      val extraChatBottomPadding = (12 * resources.displayMetrics.density).toInt()
      chatScrollView.clipToPadding = false
      chatScrollView.setPadding(
        chatScrollView.paddingLeft,
        chatScrollView.paddingTop,
        chatScrollView.paddingRight,
        chatScrollViewBaseBottomPadding + bottomSafeInset + extraChatBottomPadding,
      )
      insets
    }
    ViewCompat.requestApplyInsets(rootContent)
  }

  private fun resolveBottomSafeInset(insets: WindowInsetsCompat): Int {
    val barsBottom = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
    ).bottom
    val gesturesBottom = insets.getInsets(WindowInsetsCompat.Type.systemGestures()).bottom
    val tappableBottom = insets.getInsets(WindowInsetsCompat.Type.tappableElement()).bottom
    return max(barsBottom, max(gesturesBottom, tappableBottom))
  }

  private fun setupThemeSpinner() {
    val labels = AppTheme.ALL.map { it.label }
    val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels)
    adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
    themeSpinner.adapter = adapter
    val selectedIndex = AppTheme.ALL.indexOfFirst { it.id == currentTheme.id }.coerceAtLeast(0)
    themeSpinner.setSelection(selectedIndex)
    themeSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
      override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
        val selected = AppTheme.ALL.getOrNull(position) ?: return
        if (selected.id == currentTheme.id) return
        AppTheme.save(this@MainActivity, selected.id)
        currentTheme = selected
        applyTheme()
      }
      override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
    }
  }

  private fun applyTheme() {
    val t = currentTheme
    val density = resources.displayMetrics.density

    // System bars
    t.applyToSystemBars(window)

    // Root background
    rootContent.setBackgroundColor(t.background)

    // Header
    val headerBar = findViewById<View>(R.id.app_header_bar)
    t.styleHeaderBar(headerBar)
    val title = findViewById<TextView>(R.id.title)
    t.styleHeaderTitle(title)
    t.styleHeaderSubBar(activeAgentStatusText)

    // Header action buttons - these are styled dynamically by renderActiveClientControls/renderVoiceToAgentControls

    // Action buttons row
    t.styleSecondaryButton(settingsToggleButton, density)
    t.styleSecondaryButton(agentSessionsButton, density)

    // Settings cards
    val settingsContent = settingsSection
    if (settingsContent is androidx.core.widget.NestedScrollView) {
      val inner = (settingsContent as android.view.ViewGroup).getChildAt(0) as? android.view.ViewGroup
      if (inner != null) {
        for (i in 0 until inner.childCount) {
          val card = inner.getChildAt(i)
          card.background = t.makeCardDrawable(density)
        }
      }
    }

    // Style inputs
    t.styleInput(apiUrlInput, density)
    t.styleInput(serverListenStartTimeoutInput, density)
    t.styleInput(serverListenCompletionTimeoutInput, density)
    t.styleInput(serverEndSilenceInput, density)
    t.styleInput(serverQueueAdvanceDelayInput, density)
    t.styleInput(playbackBufferInput, density)
    t.styleInput(playbackStartupPrerollInput, density)

    // Style spinners
    t.styleSpinner(recognitionCueModeSpinner, density)
    t.styleSpinner(micDeviceSpinner, density)
    t.styleSpinner(themeSpinner, density)

    // Style switches
    t.styleSwitch(serviceSwitch)
    t.styleSwitch(speechSwitch)
    t.styleSwitch(listenSwitch)
    t.styleSwitch(wakeSwitch)
    t.styleSwitch(continuousFocusSwitch)
    t.styleSwitch(pauseExternalMediaSwitch)
    t.styleSwitch(showStatusBarSwitch)
    t.styleSwitch(serverPrependLinkedSessionLabelSwitch)

    // Style buttons
    t.styleSecondaryButton(loadServerSettingsButton, density)
    t.stylePrimaryButton(applyServerSettingsButton, density)
    t.stylePrimaryButton(applyButton, density)
    t.styleSecondaryButton(loopbackTestButton, density)
    t.styleSecondaryButton(testCueButton, density)
    t.styleSecondaryButton(backgroundSettingsButton, density)
    t.styleDestructiveButton(clearChatButton, density)

    // Status text
    statusText.setTextColor(t.textTertiary)

    // Active client status text
    activeClientStatusText.setTextColor(t.textTertiary)

    // Hint and mic route text
    val hintText = findViewById<TextView>(R.id.hint_text)
    hintText.setTextColor(t.textTertiary)
    micRouteText.setTextColor(t.textTertiary)

    // Chat area
    val chatArea = chatScrollView.parent as? View
    chatArea?.background = t.makeChatAreaDrawable(density)

    // Status bar
    statusBarContainer.setBackgroundColor(t.surface)

    // Recognition indicator
    recognitionIndicatorText.background = t.makeRecognitionDrawable(density)
    recognitionIndicatorText.setTextColor(t.recognitionText)
    recognitionIndicatorText.text = "Listening for your response..."

    // Style section titles and labels inside settings cards
    applyThemeToSettingsLabels()

    // Re-render dynamic elements
    renderActiveClientControls()
    renderVoiceToAgentControls()
    renderRuntimeStatusBar()
    renderSessionFilterTabs(BubbleHistoryStore.readAll(this))
    updateRecognitionIndicatorPresentation()
    updateActiveTurnBubbleOutline()
  }

  private fun applyThemeToSettingsLabels() {
    val t = currentTheme
    val settingsContent = settingsSection
    if (settingsContent !is androidx.core.widget.NestedScrollView) return
    fun walkViewGroup(group: android.view.ViewGroup) {
      for (i in 0 until group.childCount) {
        val child = group.getChildAt(i)
        if (child is android.view.ViewGroup && child !is EditText && child !is Spinner && child !is SeekBar) {
          walkViewGroup(child)
        }
        if (child is TextView && child !is EditText && child !is Button && child !is Switch) {
          // Section titles (bold, >=15sp) use textPrimary; section labels use textTertiary; subtitles use textTertiary
          val isBold = child.typeface?.isBold == true
          val textSizeSp = child.textSize / resources.displayMetrics.scaledDensity
          when {
            isBold && textSizeSp >= 14.5f -> child.setTextColor(t.textPrimary)
            isBold -> child.setTextColor(t.textSecondary)
            textSizeSp <= 12.5f -> child.setTextColor(t.textTertiary)
            else -> child.setTextColor(t.textTertiary)
          }
        }
        if (child is View && child.layoutParams?.height == 1) {
          // Dividers
          t.styleDivider(child)
        }
      }
    }
    walkViewGroup(settingsContent)
  }

  private fun appendBubble(
    message: String,
    shouldAutoScroll: Boolean = true,
    refreshFilters: Boolean = true,
  ) {
    if (isSuppressedLegacyVoiceDispatchBubble(message)) {
      return
    }
    val model = classifyBubble(message)
    if (refreshFilters) {
      renderSessionFilterTabs(BubbleHistoryStore.readAll(this))
    }
    if (!SessionFilterUtils.shouldDisplayBubble(selectedSessionFilterId, model.linkedSessionId)) {
      return
    }
    val role = model.role
    val body = model.body
    if (role == "assistant" && model.turnId.isNotBlank() && hasRenderedAssistantBubbleForTurn(model.turnId)) {
      return
    }
    val dp = resources.displayMetrics.density
    val bubble = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      val hasDefaultOnlyQuickReply =
        model.quickReplies.size == 1 && model.quickReplies[0].defaultResume
      setPadding((16 * dp).toInt(), (12 * dp).toInt(), (16 * dp).toInt(), (14 * dp).toInt())
      tag = BubbleViewState(
        role = role,
        noWait = model.noWait,
        turnId = model.turnId,
        allowInactiveQuickReplies = role == "assistant" &&
          model.turnId.isNotBlank() &&
          model.noWait &&
          model.quickReplies.isNotEmpty() &&
          !hasDefaultOnlyQuickReply,
        quickReplyConsumed = false,
      )
    }
    val headerRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      )
      gravity = Gravity.CENTER_VERTICAL
    }
    val linkedLabel = resolveBubbleLinkedSessionLabel(model)
    val headerTitle = BubbleHeaderLabelResolver.resolveHeaderTitle(
      role = role,
      linkedSessionLabel = linkedLabel,
      defaultRoleLabel = bubbleRoleLabel(role),
    )
    val roleHeader = TextView(this).apply {
      text = headerTitle
      setTextColor(bubbleHeaderTextColor(role, model.noWait))
      typeface = Typeface.create(
        BubbleHeaderTypographyResolver.resolveHeaderFontFamily(role),
        Typeface.NORMAL,
      )
      textSize = 11f
    }
    headerRow.addView(roleHeader)
    val headerActions = buildBubbleReferenceActionRow(model)
    if (headerActions != null) {
      val spacer = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
      }
      headerRow.addView(spacer)
      val spacingPx = (8 * resources.displayMetrics.density).toInt()
      (headerActions.layoutParams as? LinearLayout.LayoutParams)?.marginStart = spacingPx
      headerRow.addView(headerActions)
    }
    val bodyText = TextView(this).apply {
      text = body
      setTextColor(bubbleTextColor(role))
      textSize = 14f
      setLineSpacing(0f, 1.08f)
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply {
        topMargin = 4
      }
    }
    bubble.addView(headerRow)
    bubble.addView(bodyText)
    model.attachment?.let { attachment ->
      bubble.addView(buildAttachmentPreviewView(attachment, model))
    }
    val hasDefaultOnlyQuickReply = model.quickReplies.size == 1 && model.quickReplies[0].defaultResume
    if (
      role == "assistant" &&
      model.turnId.isNotBlank() &&
      model.quickReplies.isNotEmpty() &&
      !hasDefaultOnlyQuickReply
    ) {
      bubble.addView(buildBubbleQuickReplyRow(model))
    }
    updateBubbleVisualState(bubble, bubble.tag as BubbleViewState)
    if (role == "assistant" && model.turnId.isNotBlank()) {
      bubble.setOnClickListener {
        handleBubblePrimaryAction(turnId = model.turnId)
      }
      bubble.setOnLongClickListener {
        showBubbleMenu(anchor = bubble, turnId = model.turnId)
        true
      }
    }

    val params = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT,
      LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply {
      topMargin = (8 * dp).toInt()
    }

    chatContainer.addView(bubble, params)
    updateActiveTurnBubbleOutline()

    while (chatContainer.childCount > BubbleHistoryStore.MAX_BUBBLES) {
      chatContainer.removeViewAt(0)
    }
    if (shouldAutoScroll) {
      scrollToLatestBubble()
    }
  }

  private fun buildAttachmentPreviewView(
    attachment: BubbleAttachment,
    model: BubbleRenderModel,
  ): View {
    val linkedTarget = resolveBubbleLinkedSessionTarget(model)
    val resolvedContentType = AttachmentContentTypeResolver.resolveContentType(
      fileName = attachment.fileName,
      contentType = attachment.contentType,
    )
    val resolvedPreviewMode = resolveAttachmentPreviewMode(
      fileName = attachment.fileName,
      contentType = resolvedContentType,
    )
    val normalizedAttachment = attachment.copy(
      contentType = resolvedContentType,
      previewMode = resolvedPreviewMode,
    )
    val isHtml = normalizedAttachment.previewMode == "html"
    val supportsTextPreview = normalizedAttachment.previewMode == "markdown" ||
      normalizedAttachment.previewMode == "text"
    val preview = if (supportsTextPreview && normalizedAttachment.previewText != null) {
      buildAttachmentPreview(normalizedAttachment.previewText)
    } else {
      null
    }
    val hasDownloadableAttachment = normalizedAttachment.fileName.isNotBlank()
    val fileLabel = attachment.fileName.ifEmpty { "inline" }
    val contentTypeLabel = normalizedAttachment.contentType.ifEmpty { "text/plain" }
    val openAction = {
      if (isHtml) {
        openHtmlAttachmentInBrowser(normalizedAttachment)
      } else if (preview != null) {
        showAttachmentPreviewDialog(normalizedAttachment, linkedTarget)
      }
    }

    return LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply {
        topMargin = 10
      }

      val meta = TextView(this@MainActivity).apply {
        text = "Attachment • $fileLabel • $contentTypeLabel"
        setTextColor(currentTheme.textPrimary)
        textSize = 11f
      }
      val actionLinks = LinearLayout(this@MainActivity).apply {
        orientation = LinearLayout.HORIZONTAL
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT,
          LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply {
          topMargin = (8 * resources.displayMetrics.density).toInt()
        }
      }
      val actionLinkSpacingPx = (12 * resources.displayMetrics.density).toInt()
      val addActionLink = { label: String, onClick: () -> Unit ->
        val link = TextView(this@MainActivity).apply {
          text = label
          setTextColor(currentTheme.accent)
          textSize = 12f
          isClickable = true
          isFocusable = true
          setOnClickListener { onClick() }
        }
        if (actionLinks.childCount > 0) {
          link.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
          ).apply {
            marginStart = actionLinkSpacingPx
          }
        }
        actionLinks.addView(link)
      }
      val addStatusBox = { message: String ->
        TextView(this@MainActivity).apply {
          text = message
          setTextColor(currentTheme.textSecondary)
          textSize = 12f
          setLineSpacing(0f, 1.05f)
          val dp = resources.displayMetrics.density
          setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
          background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 12f * dp
            setColor(currentTheme.surface)
            setStroke(
              dp.toInt().coerceAtLeast(1),
              currentTheme.borderSubtle,
            )
          }
          layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
          ).apply {
            topMargin = 6
          }
        }
      }

      addView(meta)

      when {
        normalizedAttachment.decodeState == ATTACHMENT_DECODE_STATE_INVALID_BASE64 -> {
          addView(addStatusBox("Invalid attachment encoding."))
          if (hasDownloadableAttachment) {
            addActionLink("Download invalid file") { downloadAttachment(normalizedAttachment) }
          }
        }

        isHtml -> {
          addActionLink("Open in browser") { openAction() }
          if (hasDownloadableAttachment) {
            addActionLink("Download") { downloadAttachment(normalizedAttachment) }
          }
        }

        normalizedAttachment.decodeState == ATTACHMENT_DECODE_STATE_PREVIEW_UNAVAILABLE -> {
          addView(addStatusBox("Preview unavailable"))
          if (hasDownloadableAttachment) {
            addActionLink("Download") { downloadAttachment(normalizedAttachment) }
          }
        }

        preview != null -> {
          val previewText = TextView(this@MainActivity).apply {
            setTextColor(currentTheme.textSecondary)
            textSize = 12f
            setLineSpacing(0f, 1.05f)
            val dp = resources.displayMetrics.density
            setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
            background = GradientDrawable().apply {
              shape = GradientDrawable.RECTANGLE
              cornerRadius = 12f * dp
              setColor(currentTheme.surface)
              setStroke(
                dp.toInt().coerceAtLeast(1),
                currentTheme.borderSubtle,
              )
            }
            layoutParams = LinearLayout.LayoutParams(
              LinearLayout.LayoutParams.MATCH_PARENT,
              LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
              topMargin = 6
            }
            isClickable = true
            isFocusable = true
            setOnClickListener { openAction() }
          }
          applyAttachmentText(
            target = previewText,
            text = preview.text,
            fileName = normalizedAttachment.fileName,
            contentType = normalizedAttachment.contentType,
            previewMode = normalizedAttachment.previewMode,
          )
          addView(previewText)
          if (preview.truncated) {
            addActionLink("Show more") { openAction() }
          }
          if (hasDownloadableAttachment) {
            addActionLink("Download") { downloadAttachment(normalizedAttachment) }
          }
        }

        else -> {
          if (hasDownloadableAttachment) {
            addActionLink("Download") { downloadAttachment(normalizedAttachment) }
          }
        }
      }

      if (actionLinks.childCount > 0) {
        addView(actionLinks)
      }

      if (isHtml || preview != null) {
        isClickable = true
        isFocusable = true
        setOnClickListener { openAction() }
      }
    }
  }

  private fun buildAttachmentPreview(text: String): BubbleAttachmentPreview {
    val lines = text.split("\n")
    val clippedLines = lines.take(attachmentPreviewMaxLines)
    val lineTruncated = lines.size > attachmentPreviewMaxLines
    var previewText = clippedLines.joinToString("\n")
    val charTruncated = previewText.length > attachmentPreviewMaxChars
    if (charTruncated) {
      previewText = previewText.substring(0, attachmentPreviewMaxChars)
    }
    return BubbleAttachmentPreview(
      text = previewText,
      truncated = lineTruncated || charTruncated,
    )
  }

  private fun isMarkdownContentType(contentType: String): Boolean {
    val normalized = contentType.trim().lowercase()
    if (normalized.isEmpty()) {
      return false
    }
    return normalized == "text/markdown" || normalized.startsWith("text/markdown;")
  }

  private fun isMarkdownAttachment(contentType: String): Boolean {
    return isMarkdownContentType(contentType)
  }

  private fun normalizeMarkdownFrontMatter(text: String): String {
    return normalizeMarkdownFrontMatterText(text)
  }

  private fun applyAttachmentText(
    target: TextView,
    text: String,
    fileName: String,
    contentType: String,
    previewMode: String,
  ) {
    if (previewMode == "markdown" || isMarkdownAttachment(contentType)) {
      target.typeface = Typeface.DEFAULT
      markwon.setMarkdown(target, normalizeMarkdownFrontMatter(text))
      target.linksClickable = true
      target.movementMethod = LinkMovementMethod.getInstance()
      return
    }

    val resolvedLanguage = if (previewMode == "text") {
      AttachmentSyntaxLanguageResolver.resolveLanguage(fileName)
    } else {
      null
    }
    if (resolvedLanguage != null) {
      target.typeface = Typeface.DEFAULT
      markwon.setMarkdown(target, AttachmentSyntaxLanguageResolver.toFencedMarkdown(text, resolvedLanguage))
      target.linksClickable = false
      target.movementMethod = null
      return
    }

    target.typeface = Typeface.MONOSPACE
    target.text = text
    target.movementMethod = null
  }

  private fun showAttachmentPreviewDialog(
    attachment: BubbleAttachment,
    linkedSessionTarget: ActiveAgentTarget?,
  ) {
    val fileLabel = attachment.fileName.ifEmpty { "inline" }
    val contentTypeLabel = attachment.contentType.ifEmpty { "text/plain" }
    var zoomSp = loadAttachmentPreviewZoomPreference()
    val t = currentTheme
    val bottomInset = ViewCompat.getRootWindowInsets(rootContent)?.let { resolveBottomSafeInset(it) } ?: 0
    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      )
      setPadding(0, 0, 0, bottomInset)
      setBackgroundColor(currentTheme.surfaceContainer)
    }
    val headerRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      )
    }
    val title = TextView(this).apply {
      text = "Attachment"
      setTextColor(currentTheme.textPrimary)
      textSize = 22f
      setTypeface(typeface, Typeface.BOLD)
      layoutParams = LinearLayout.LayoutParams(
        0,
        LinearLayout.LayoutParams.WRAP_CONTENT,
        1f,
      )
    }
    val startVoiceButton = ImageButton(this).apply {
      setImageResource(R.drawable.ic_chat_bubble_outline_24)
      layoutParams = LinearLayout.LayoutParams(
        (40 * resources.displayMetrics.density).toInt(),
        (40 * resources.displayMetrics.density).toInt(),
      )
      val buttonPaddingPx = (6 * resources.displayMetrics.density).toInt()
      setPadding(buttonPaddingPx, buttonPaddingPx, buttonPaddingPx, buttonPaddingPx)
      val voiceGateOpen = linkedSessionTarget != null && isVoiceToAgentReadyForStart(linkedSessionTarget)
      imageTintList = ColorStateList.valueOf(if (voiceGateOpen) t.voiceReadyIcon else t.voiceNotReadyIcon)
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(if (voiceGateOpen) t.voiceReadyBg else t.voiceNotReadyBg)
        setStroke(
          resources.displayMetrics.density.toInt().coerceAtLeast(1),
          if (voiceGateOpen) t.voiceReadyBorder else t.voiceNotReadyBorder,
        )
      }
      isEnabled = voiceGateOpen
      alpha = if (voiceGateOpen) 1f else 0.9f
      contentDescription = if (linkedSessionTarget != null) {
        "Start voice to linked session"
      } else {
        "No linked session available"
      }
      setOnClickListener {
        if (linkedSessionTarget == null) {
          statusText.text = "No linked session on this attachment."
          return@setOnClickListener
        }
        if (!isVoiceToAgentReadyForStart(linkedSessionTarget)) {
          statusText.text = "Voice to Agent can start only while idle."
          return@setOnClickListener
        }
        requestVoiceToAgentCapture(linkedSessionTarget)
      }
    }
    val startSendButton = ImageButton(this).apply {
      setImageResource(R.drawable.ic_send_24)
      layoutParams = LinearLayout.LayoutParams(
        (40 * resources.displayMetrics.density).toInt(),
        (40 * resources.displayMetrics.density).toInt(),
      ).apply {
        marginEnd = (8 * resources.displayMetrics.density).toInt()
      }
      val buttonPaddingPx = (6 * resources.displayMetrics.density).toInt()
      setPadding(buttonPaddingPx, buttonPaddingPx, buttonPaddingPx, buttonPaddingPx)
      val voiceGateOpen = linkedSessionTarget != null && isVoiceToAgentReadyForStart(linkedSessionTarget)
      imageTintList = ColorStateList.valueOf(if (voiceGateOpen) t.voiceReadyIcon else t.voiceNotReadyIcon)
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(if (voiceGateOpen) t.voiceReadyBg else t.voiceNotReadyBg)
        setStroke(
          resources.displayMetrics.density.toInt().coerceAtLeast(1),
          if (voiceGateOpen) t.voiceReadyBorder else t.voiceNotReadyBorder,
        )
      }
      isEnabled = voiceGateOpen
      alpha = if (voiceGateOpen) 1f else 0.9f
      contentDescription = if (linkedSessionTarget != null) {
        "Start verbatim send to linked session"
      } else {
        "No linked session available"
      }
      setOnClickListener {
        if (linkedSessionTarget == null) {
          statusText.text = "No linked session on this attachment."
          return@setOnClickListener
        }
        if (!isVoiceToAgentReadyForStart(linkedSessionTarget)) {
          statusText.text = "Voice to Agent can start only while idle."
          return@setOnClickListener
        }
        requestVoiceToAgentCapture(linkedSessionTarget, sendVerbatim = true)
      }
    }
    headerRow.addView(title)
    headerRow.addView(startSendButton)
    headerRow.addView(startVoiceButton)

    val meta = TextView(this).apply {
      text = "Attachment • $fileLabel • $contentTypeLabel"
      setTextColor(currentTheme.textSecondary)
      textSize = 12f
      val dp = resources.displayMetrics.density
      setPadding((10 * dp).toInt(), (8 * dp).toInt(), (10 * dp).toInt(), (8 * dp).toInt())
      background = GradientDrawable().apply {
        cornerRadius = 10f * dp
        setColor(currentTheme.surface)
        setStroke(
          dp.toInt().coerceAtLeast(1),
          currentTheme.borderSubtle,
        )
      }
    }

    val wrappedBody = TextView(this).apply {
      setTextColor(currentTheme.textPrimary)
      setTextSize(zoomSp)
      setLineSpacing(0f, 1.05f)
      setTextIsSelectable(true)
      setHorizontallyScrolling(false)
      val dp = resources.displayMetrics.density
      setPadding((8 * dp).toInt(), (6 * dp).toInt(), (8 * dp).toInt(), (6 * dp).toInt())
      setBackgroundColor(currentTheme.surface)
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      )
    }
    val previewText = attachment.previewText
    val previewTextResolved = previewText.orEmpty()
    val hasPreviewText = previewText != null &&
      (attachment.previewMode == "markdown" || attachment.previewMode == "text")
    if (hasPreviewText) {
      applyAttachmentText(
        target = wrappedBody,
        text = previewTextResolved,
        fileName = attachment.fileName,
        contentType = attachment.contentType,
        previewMode = attachment.previewMode,
      )
    } else if (attachment.decodeState == ATTACHMENT_DECODE_STATE_PREVIEW_UNAVAILABLE) {
      wrappedBody.typeface = Typeface.MONOSPACE
      wrappedBody.text = "Preview unavailable"
      wrappedBody.movementMethod = null
    } else if (attachment.decodeState == ATTACHMENT_DECODE_STATE_INVALID_BASE64) {
      wrappedBody.typeface = Typeface.MONOSPACE
      wrappedBody.text = "Invalid attachment encoding."
      wrappedBody.movementMethod = null
    } else {
      wrappedBody.typeface = Typeface.MONOSPACE
      wrappedBody.text = "No preview available for this attachment type."
      wrappedBody.movementMethod = null
    }
    val refreshZoomedBodies = {
      wrappedBody.setTextSize(zoomSp)
      if (hasPreviewText && attachment.previewMode == "markdown") {
        // Markwon table layout snapshots text metrics at render time; re-render on zoom updates.
        applyAttachmentText(
          target = wrappedBody,
          text = previewTextResolved,
          fileName = attachment.fileName,
          contentType = attachment.contentType,
          previewMode = attachment.previewMode,
        )
      }
    }
    val scaleGestureDetector = android.view.ScaleGestureDetector(
      this,
      object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: android.view.ScaleGestureDetector): Boolean {
          zoomSp = (zoomSp * detector.scaleFactor).coerceIn(6f, 28f)
          refreshZoomedBodies()
          return true
        }
      },
    )

    val wrappedScroll = ScrollView(this).apply {
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.MATCH_PARENT,
      )
      isVerticalScrollBarEnabled = true
      addView(wrappedBody)
    }
    val pinchTouchListener = View.OnTouchListener { view, event ->
      if (event.pointerCount > 1) {
        view.parent?.requestDisallowInterceptTouchEvent(true)
      } else if (
        event.actionMasked == android.view.MotionEvent.ACTION_UP ||
        event.actionMasked == android.view.MotionEvent.ACTION_CANCEL
      ) {
        view.parent?.requestDisallowInterceptTouchEvent(false)
      }
      scaleGestureDetector.onTouchEvent(event)
      false
    }
    wrappedScroll.setOnTouchListener(pinchTouchListener)
    val contentHost = FrameLayout(this).apply {
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        0,
        1f,
      ).apply {
        topMargin = 6
      }
      setBackgroundColor(currentTheme.surface)
      addView(wrappedScroll)
    }
    val actionsRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply {
        topMargin = 10
      }
    }
    var dialog: Dialog? = null
    val actionButtonHeightPx = (36 * resources.displayMetrics.density).toInt()
    val actionButtonHorizontalPaddingPx = (14 * resources.displayMetrics.density).toInt()
    val copyButton = if (hasPreviewText) {
      Button(this).apply {
        text = "Copy"
        setTextColor(currentTheme.recognitionText)
        textSize = 13f
        background = currentTheme.makeSecondaryButtonDrawable(resources.displayMetrics.density)
        stateListAnimator = null
        minHeight = 0
        minimumHeight = 0
        setPadding(actionButtonHorizontalPaddingPx, 0, actionButtonHorizontalPaddingPx, 0)
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT,
          actionButtonHeightPx,
        )
        setOnClickListener {
          val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
          if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("attachment", previewText))
            statusText.text = "Attachment copied."
          } else {
            statusText.text = "Copy failed: clipboard unavailable."
          }
        }
      }
    } else {
      null
    }
    val hasDownloadableAttachment = attachment.fileName.isNotBlank()
    val downloadButton = if (hasDownloadableAttachment) {
      Button(this).apply {
        text = if (attachment.decodeState == ATTACHMENT_DECODE_STATE_INVALID_BASE64) {
          "Download invalid file"
        } else {
          "Download"
        }
        setTextColor(currentTheme.recognitionText)
        textSize = 13f
        background = currentTheme.makeSecondaryButtonDrawable(resources.displayMetrics.density)
        stateListAnimator = null
        minHeight = 0
        minimumHeight = 0
        setPadding(actionButtonHorizontalPaddingPx, 0, actionButtonHorizontalPaddingPx, 0)
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT,
          actionButtonHeightPx,
        ).apply {
          marginStart = (8 * resources.displayMetrics.density).toInt()
        }
        setOnClickListener {
          downloadAttachment(attachment)
        }
      }
    } else {
      null
    }
    val closeButton = Button(this).apply {
      text = "Close"
      setTextColor(currentTheme.recognitionText)
      textSize = 13f
      background = currentTheme.makeSecondaryButtonDrawable(resources.displayMetrics.density)
      stateListAnimator = null
      minHeight = 0
      minimumHeight = 0
      setPadding(actionButtonHorizontalPaddingPx, 0, actionButtonHorizontalPaddingPx, 0)
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        actionButtonHeightPx,
      )
      setOnClickListener { dialog?.dismiss() }
    }
    val actionSpacer = View(this).apply {
      layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
    }
    if (copyButton != null) {
      actionsRow.addView(copyButton)
    }
    if (downloadButton != null) {
      if (copyButton == null) {
        (downloadButton.layoutParams as? LinearLayout.LayoutParams)?.marginStart = 0
      }
      actionsRow.addView(downloadButton)
    }
    actionsRow.addView(actionSpacer)
    actionsRow.addView(closeButton)
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(currentTheme.surfaceContainer)
      }
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.MATCH_PARENT,
      )
      val dp = resources.displayMetrics.density
      setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (8 * dp).toInt())
    }
    card.addView(headerRow)
    card.addView(meta)
    card.addView(contentHost)
    card.addView(actionsRow)
    container.addView(card)

    dialog = Dialog(this).apply {
      requestWindowFeature(Window.FEATURE_NO_TITLE)
      setContentView(container)
      setOnDismissListener {
        saveAttachmentPreviewZoomPreference(zoomSp)
      }
      show()
    }

    dialog.window?.setBackgroundDrawable(
      GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = 0f
        setColor(currentTheme.surfaceContainer)
      },
    )
    dialog.window?.setLayout(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
    )
  }

  private fun openHtmlAttachmentInBrowser(attachment: BubbleAttachment) {
    val bytes = attachment.decodedBytes
    if (bytes == null) {
      statusText.text = "Invalid attachment encoding."
      return
    }
    val exportedFile = try {
      HtmlAttachmentExportStore.getOrCreate(
        context = this,
        fileName = sanitizeAttachmentFileName(attachment.fileName.ifEmpty { "attachment.html" }),
        attachmentBytes = bytes,
        contentType = "text/html",
      )
    } catch (_: IOException) {
      statusText.text = "Failed to prepare HTML attachment."
      return
    }

    val uri = try {
      FileProvider.getUriForFile(this, "${packageName}.fileprovider", exportedFile)
    } catch (_: IllegalArgumentException) {
      statusText.text = "Failed to share HTML attachment."
      return
    }

    val openIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "text/html")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      clipData = ClipData.newUri(contentResolver, "attachment", uri)
    }
    try {
      startActivity(openIntent)
    } catch (_: ActivityNotFoundException) {
      statusText.text = "No browser available to open HTML attachment."
    }
  }

  private fun downloadAttachment(attachment: BubbleAttachment) {
    val trimmedFileName = attachment.fileName.trim()
    if (trimmedFileName.isEmpty()) {
      statusText.text = "Download is available only for file attachments."
      return
    }
    val normalizedFileName = sanitizeAttachmentFileName(trimmedFileName)
    val isInvalidDownload = attachment.decodeState == ATTACHMENT_DECODE_STATE_INVALID_BASE64
    val normalizedMimeType = if (isInvalidDownload) {
      "text/plain"
    } else {
      normalizeAttachmentMimeType(attachment.contentType)
    }
    val payloadBytes = if (isInvalidDownload) {
      attachment.dataBase64.toByteArray(Charsets.UTF_8)
    } else {
      attachment.decodedBytes
    }
    if (payloadBytes == null) {
      statusText.text = "Failed to prepare attachment download."
      return
    }
    val outputFileName = if (isInvalidDownload) {
      buildInvalidAttachmentFileName(normalizedFileName)
    } else {
      normalizedFileName
    }
    pendingAttachmentDownload = PendingAttachmentDownload(
      fileName = outputFileName,
      bytes = payloadBytes,
      mimeType = normalizedMimeType,
    )
    val createIntent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = normalizedMimeType
      putExtra(Intent.EXTRA_TITLE, outputFileName)
    }
    try {
      createAttachmentDocumentLauncher.launch(createIntent)
    } catch (_: ActivityNotFoundException) {
      pendingAttachmentDownload = null
      statusText.text = "No file picker available to save attachment."
    }
  }

  private fun normalizeAttachmentMimeType(contentType: String): String {
    val normalized = contentType.trim().substringBefore(';').trim().lowercase()
    return normalized.ifEmpty { "text/plain" }
  }

  private fun isSuppressedLegacyVoiceDispatchBubble(message: String): Boolean {
    val lower = message.lowercase()
    return lower.contains("sent transcript to active agent") ||
      lower.contains("active-agent voice dispatch sent")
  }

  private fun renderPersistedBubbles(scrollToBottom: Boolean = true) {
    stopActiveBubblePulse()
    val storedMessages = BubbleHistoryStore.readAll(this)
    renderSessionFilterTabs(storedMessages)
    chatContainer.removeAllViews()
    storedMessages.forEach { message ->
      appendBubble(message, shouldAutoScroll = false, refreshFilters = false)
    }
    if (scrollToBottom) {
      scrollToLatestBubble()
    }
  }

  private fun renderSessionFilterTabs(messages: List<String>) {
    val sessionLabelById = linkedMapOf<String, String>()
    for (message in messages) {
      if (isSuppressedLegacyVoiceDispatchBubble(message)) {
        continue
      }
      val model = classifyBubble(message)
      val sessionId = model.linkedSessionId.trim()
      if (sessionId.isEmpty() || sessionLabelById.containsKey(sessionId)) {
        continue
      }
      sessionLabelById[sessionId] = resolveSessionFilterLabel(
        sessionId = sessionId,
        linkedSessionTitle = model.linkedSessionTitle,
      )
    }

    if (
      selectedSessionFilterId.isNotEmpty() &&
      !sessionLabelById.containsKey(selectedSessionFilterId)
    ) {
      selectedSessionFilterId = SessionFilterUtils.GLOBAL_FILTER_ID
      saveSessionFilterSelection(selectedSessionFilterId)
    }

    renderedSessionFilterIds = listOf(SessionFilterUtils.GLOBAL_FILTER_ID) + sessionLabelById.keys
    sessionFilterChipContainer.removeAllViews()
    sessionFilterChipButtonsById.clear()
    val density = resources.displayMetrics.density
    val activeSessionChipState = resolveActiveSessionChipState()

    val globalChip = createSessionFilterChipButton(
      filterId = SessionFilterUtils.GLOBAL_FILTER_ID,
      label = "Global",
      isFirst = true,
      density = density,
    )
    sessionFilterChipButtonsById[SessionFilterUtils.GLOBAL_FILTER_ID] = globalChip
    sessionFilterChipContainer.addView(globalChip)
    for ((sessionId, label) in sessionLabelById.entries) {
      val chip = createSessionFilterChipButton(
        filterId = sessionId,
        label = label,
        isFirst = false,
        density = density,
      )
      sessionFilterChipButtonsById[sessionId] = chip
      sessionFilterChipContainer.addView(
        chip,
      )
    }
    sessionFilterScroll.visibility = View.VISIBLE
    updateSessionFilterChipStyles(
      activeListeningSessionId = activeSessionChipState.sessionId,
      pulseAlphaFraction = null,
    )
    syncActiveSessionChipPulse(activeSessionChipState)
    renderVoiceToAgentControls()
    updateRecognitionIndicatorPresentation()
  }

  private fun createSessionFilterChipButton(
    filterId: String,
    label: String,
    isFirst: Boolean,
    density: Float,
  ): Button {
    val selected = filterId == selectedSessionFilterId
    val chipHeightPx = (34 * density).toInt()
    val horizontalPaddingPx = (14 * density).toInt()
    return Button(this).apply {
      text = label
      isAllCaps = false
      textSize = 12f
      minHeight = 0
      minimumHeight = 0
      stateListAnimator = null
      backgroundTintList = null
      background = makeSessionFilterChipDrawable(
        selected = selected,
        activeListeningSession = false,
        density = density,
        pulseAlphaFraction = null,
      )
      setTextColor(if (selected) currentTheme.accent else currentTheme.textSecondary)
      setPadding(horizontalPaddingPx, 0, horizontalPaddingPx, 0)
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        chipHeightPx,
      ).apply {
        if (!isFirst) {
          marginStart = (6 * density).toInt()
        }
      }
      setOnClickListener {
        applySessionFilter(filterId)
      }
    }
  }

  private fun buildBubbleQuickReplyRow(model: BubbleRenderModel): View {
    val density = resources.displayMetrics.density
    val hasSingleDefaultResume = model.quickReplies.size == 1 && model.quickReplies[0].defaultResume
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = if (hasSingleDefaultResume) Gravity.END else Gravity.START
    }
    val buttons = mutableListOf<Button>()
    val setButtonsEnabled = { enabled: Boolean ->
      for (button in buttons) {
        button.isEnabled = enabled
        button.alpha = if (enabled) 1f else 0.55f
      }
    }

    for ((index, quickReply) in model.quickReplies.withIndex()) {
      val button = Button(this).apply {
        text = quickReply.label
        isAllCaps = false
        textSize = 12f
        minHeight = 0
        minimumHeight = 0
        setPadding((12 * density).toInt(), (6 * density).toInt(), (12 * density).toInt(), (6 * density).toInt())
        currentTheme.styleSecondaryButton(this, density)
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT,
          LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply {
          if (index > 0) {
            marginStart = (8 * density).toInt()
          }
        }
        setOnClickListener {
          val allowInactiveQuickReply = model.noWait
          if (!isActiveTurn(model.turnId) && !allowInactiveQuickReply) {
            statusText.text = "That turn is no longer active."
            setButtonsEnabled(false)
            return@setOnClickListener
          }
          setButtonsEnabled(false)
          val sent = submitBubbleQuickReply(
            turnId = model.turnId,
            quickReply = quickReply,
            allowInactiveQuickReply = allowInactiveQuickReply,
          )
          if (!sent) {
            setButtonsEnabled(true)
          } else {
            markBubbleQuickReplyConsumed(model.turnId)
          }
        }
      }
      buttons.add(button)
      row.addView(button)
    }

    if (!isActiveTurn(model.turnId) && !model.noWait) {
      setButtonsEnabled(false)
    }

    return HorizontalScrollView(this).apply {
      tag = bubbleQuickReplyRowTagPrefix + model.turnId
      isFillViewport = hasSingleDefaultResume
      isHorizontalScrollBarEnabled = false
      overScrollMode = View.OVER_SCROLL_NEVER
      layoutParams = LinearLayout.LayoutParams(
        if (hasSingleDefaultResume) {
          LinearLayout.LayoutParams.MATCH_PARENT
        } else {
          LinearLayout.LayoutParams.WRAP_CONTENT
        },
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply {
        topMargin = (12 * density).toInt()
      }
      addView(
        row,
        ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ),
      )
    }
  }

  private fun submitBubbleQuickReply(
    turnId: String,
    quickReply: BubbleQuickReply,
    allowInactiveQuickReply: Boolean,
  ): Boolean {
    if (!serviceSwitch.isChecked) {
      statusText.text = "Service must be running to send a quick reply."
      return false
    }
    if (!isActiveTurn(turnId) && !allowInactiveQuickReply) {
      statusText.text = "That turn is no longer active."
      return false
    }
    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    startService(
      VoiceAdapterService.quickReplyIntent(
        context = this,
        config = config,
        turnId = turnId,
        text = quickReply.text,
        quickReplyId = quickReply.id.ifBlank { null },
      ),
    )
    statusText.text = "Quick reply sent: ${quickReply.label}"
    return true
  }

  private fun makeSessionFilterChipDrawable(
    selected: Boolean,
    activeListeningSession: Boolean,
    density: Float,
    pulseAlphaFraction: Float?,
  ): GradientDrawable {
    val borderWidth = (1 * density).toInt().coerceAtLeast(1)
    return GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = 999f
      if (activeListeningSession) {
        val fillAlpha = pulseAlphaFraction ?: 0.72f
        val strokeAlpha = (pulseAlphaFraction ?: 1f).coerceIn(0.65f, 1f)
        val strokeWidth = if ((pulseAlphaFraction ?: 0f) > 0.86f) {
          (borderWidth + 1).coerceAtLeast(borderWidth)
        } else {
          borderWidth
        }
        setColor(BubblePulse.withAlpha(currentTheme.warningSubtle, fillAlpha))
        setStroke(strokeWidth, BubblePulse.withAlpha(currentTheme.warning, strokeAlpha))
      } else if (selected) {
        setColor(currentTheme.accentSubtle)
        setStroke(borderWidth, currentTheme.accentMuted)
      } else {
        setColor(currentTheme.surface)
        setStroke(borderWidth, currentTheme.borderDefault)
      }
    }
  }

  private fun updateSessionFilterChipStyles(
    activeListeningSessionId: String,
    pulseAlphaFraction: Float?,
  ) {
    val density = resources.displayMetrics.density
    for ((filterId, chipButton) in sessionFilterChipButtonsById.entries) {
      val selected = filterId == selectedSessionFilterId
      val activeListeningChip = SessionFilterUtils.isActiveSessionFilterChip(
        filterId = filterId,
        activeSessionId = activeListeningSessionId,
      )
      chipButton.background = makeSessionFilterChipDrawable(
        selected = selected,
        activeListeningSession = activeListeningChip,
        density = density,
        pulseAlphaFraction = if (activeListeningChip) pulseAlphaFraction else null,
      )
      val textColor = when {
        activeListeningChip -> currentTheme.warning
        selected -> currentTheme.accent
        else -> currentTheme.textSecondary
      }
      chipButton.setTextColor(textColor)
    }
  }

  private fun syncActiveSessionChipPulse(activeSessionChipState: ActiveSessionChipState) {
    val normalizedActiveSessionId = SessionFilterUtils.normalizeFilterId(activeSessionChipState.sessionId)
    val shouldPulse = activeSessionChipState.pulse &&
      normalizedActiveSessionId.isNotEmpty() &&
      sessionFilterChipButtonsById.containsKey(normalizedActiveSessionId)

    if (!shouldPulse) {
      stopActiveSessionChipPulse(resetStyles = false)
      updateSessionFilterChipStyles(
        activeListeningSessionId = normalizedActiveSessionId,
        pulseAlphaFraction = null,
      )
      return
    }

    if (
      activeSessionChipPulseRunnable != null &&
      activeSessionChipPulseSessionId == normalizedActiveSessionId
    ) {
      return
    }

    stopActiveSessionChipPulse(resetStyles = false)
    activeSessionChipPulseSessionId = normalizedActiveSessionId
    activeSessionChipPulseStartedAtMs = SystemClock.uptimeMillis()

    val runnable = object : Runnable {
      override fun run() {
        val pulsingSessionId = activeSessionChipPulseSessionId
        val chipState = resolveActiveSessionChipState()
        if (
          !chipState.pulse ||
          pulsingSessionId.isBlank() ||
          chipState.sessionId != pulsingSessionId
        ) {
          stopActiveSessionChipPulse()
          return
        }
        if (!sessionFilterChipButtonsById.containsKey(pulsingSessionId)) {
          stopActiveSessionChipPulse(resetStyles = false)
          updateSessionFilterChipStyles(
            activeListeningSessionId = resolveActiveSessionChipState().sessionId,
            pulseAlphaFraction = null,
          )
          return
        }

        val elapsedMs = (SystemClock.uptimeMillis() - activeSessionChipPulseStartedAtMs).coerceAtLeast(0L)
        val trianglePulse = BubblePulse.trianglePulseFraction(elapsedMs, bubblePulseDurationMs)
        val pulseAlphaFraction = BubblePulse.pulseFractionToAlphaFraction(
          pulseFraction = trianglePulse,
          minAlphaFraction = sessionChipPulseMinAlphaFraction,
        )
        updateSessionFilterChipStyles(
          activeListeningSessionId = pulsingSessionId,
          pulseAlphaFraction = pulseAlphaFraction,
        )
        sessionFilterChipContainer.postDelayed(this, bubblePulseFrameMs)
      }
    }
    activeSessionChipPulseRunnable = runnable
    sessionFilterChipContainer.post(runnable)
  }

  private fun stopActiveSessionChipPulse(resetStyles: Boolean = true) {
    activeSessionChipPulseRunnable?.let { runnable ->
      sessionFilterChipContainer.removeCallbacks(runnable)
    }
    activeSessionChipPulseRunnable = null
    activeSessionChipPulseStartedAtMs = 0L
    activeSessionChipPulseSessionId = ""
    if (resetStyles) {
      updateSessionFilterChipStyles(
        activeListeningSessionId = resolveActiveSessionChipState().sessionId,
        pulseAlphaFraction = null,
      )
    }
  }

  private fun handleSessionFilterSwipe(event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        sessionFilterSwipeStartX = event.x
        sessionFilterSwipeStartY = event.y
        sessionFilterSwipeStartEventMs = event.eventTime
      }

      MotionEvent.ACTION_UP -> {
        if (renderedSessionFilterIds.size <= 1) {
          return
        }

        val deltaX = event.x - sessionFilterSwipeStartX
        val deltaY = event.y - sessionFilterSwipeStartY
        val elapsedMs = (event.eventTime - sessionFilterSwipeStartEventMs).coerceAtLeast(1L)
        val velocityX = (deltaX * 1000f) / elapsedMs.toFloat()
        if (abs(deltaX) < 120f || abs(deltaX) <= abs(deltaY) * 1.35f || abs(velocityX) < 420f) {
          return
        }

        val direction = if (deltaX < 0f) 1 else -1
        val nextFilterId = SessionFilterUtils.shiftFilterId(
          currentFilterId = selectedSessionFilterId,
          orderedFilterIds = renderedSessionFilterIds,
          direction = direction,
        ) ?: return
        if (nextFilterId == selectedSessionFilterId) {
          return
        }
        applySessionFilter(nextFilterId)
      }
    }
  }

  private fun applySessionFilter(filterId: String) {
    val normalized = SessionFilterUtils.normalizeFilterId(filterId)
    if (normalized == selectedSessionFilterId) {
      return
    }

    selectedSessionFilterId = normalized
    saveSessionFilterSelection(selectedSessionFilterId)
    renderPersistedBubbles()
    val filterLabel = if (normalized.isEmpty()) {
      "Global"
    } else {
      resolveSessionFilterLabel(
        sessionId = normalized,
        linkedSessionTitle = "",
      )
    }
    statusText.text = "Showing $filterLabel messages."
    renderVoiceToAgentControls()
    updateRecognitionIndicatorPresentation()
  }

  private fun resolveSessionFilterLabel(
    sessionId: String,
    linkedSessionTitle: String,
  ): String {
    val normalizedSessionId = sessionId.trim()
    if (normalizedSessionId.isEmpty()) {
      return "Global"
    }

    val cached = cachedSessionDispatchRows.firstOrNull { row -> row.sessionId == normalizedSessionId }
    if (cached != null) {
      return formatWorkspaceAndTitle(cached.workspace, cached.resolvedTitle)
    }

    val linkedTitle = linkedSessionTitle.trim()
    if (linkedTitle.isNotEmpty()) {
      return linkedTitle
    }
    return normalizedSessionId
  }

  private fun scrollToLatestBubble() {
    chatScrollView.post {
      chatScrollView.fullScroll(View.FOCUS_DOWN)
    }
  }

  private fun setRecognitionIndicator(active: Boolean) {
    recognitionIndicatorActive = active
    Log.i(
      TAG,
      "ui_recognition_indicator active=$active audio=${runtimeStatusState.audio} captureActive=$activeAgentCaptureActive turnId=${runtimeStatusState.turnId}",
    )
    recognitionIndicatorText.visibility = if (active) View.VISIBLE else View.GONE
    recognitionIndicatorText.isClickable = active
    recognitionIndicatorText.isFocusable = active
    maybeClearLocalCaptureSourceBubbleTurnId()
    updateActiveTurnBubbleOutline()
    updateRecognitionIndicatorPresentation()
    renderSessionFilterTabs(BubbleHistoryStore.readAll(this))
    if (active) {
      scrollToLatestBubble()
    }
  }

  private fun updateRecognitionIndicatorPresentation() {
    val density = resources.displayMetrics.density
    if (!recognitionIndicatorActive) {
      recognitionIndicatorText.background = currentTheme.makeRecognitionDrawable(density)
      recognitionIndicatorText.setTextColor(currentTheme.recognitionText)
      recognitionIndicatorText.text = "Listening for your response..."
      recognitionIndicatorText.contentDescription = "Listening for your response"
      return
    }

    val activeSessionId = resolveActiveListeningSessionId()
    val mutedForOtherSession = SessionFilterUtils.isNonVisibleActiveSession(
      selectedFilterId = selectedSessionFilterId,
      activeSessionId = activeSessionId,
    )
    if (mutedForOtherSession) {
      recognitionIndicatorText.background = makeRecognitionIndicatorDrawable(
        density = density,
        fillColor = BubblePulse.withAlpha(currentTheme.chipDefault, 0.88f),
        borderColor = currentTheme.borderDefault,
      )
      recognitionIndicatorText.setTextColor(currentTheme.textSecondary)
    } else {
      recognitionIndicatorText.background = currentTheme.makeRecognitionDrawable(density)
      recognitionIndicatorText.setTextColor(currentTheme.recognitionText)
    }
    recognitionIndicatorText.text = "Listening for your response..."
    recognitionIndicatorText.contentDescription = "Listening for your response. Tap to cancel."
  }

  private fun makeRecognitionIndicatorDrawable(
    density: Float,
    fillColor: Int,
    borderColor: Int,
  ): GradientDrawable {
    return GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = 12f * density
      setColor(fillColor)
      setStroke((1 * density).toInt().coerceAtLeast(1), borderColor)
    }
  }

  private fun resolveActiveListeningSessionId(): String {
    if (!recognitionIndicatorActive) {
      return ""
    }
    val chipState = resolveActiveSessionChipState()
    if (chipState.sessionId.isNotEmpty()) {
      return chipState.sessionId
    }
    val turnId = runtimeStatusState.turnId.trim()
    val hintedSessionId = resolveHintedCaptureSessionId(turnId)
    if (hintedSessionId.isNotEmpty()) {
      return hintedSessionId
    }
    if (activeAgentCaptureActive) {
      val selectedTargetSessionId = resolveSelectedSessionTarget()?.sessionId.orEmpty().trim()
      if (selectedTargetSessionId.isNotEmpty()) {
        return selectedTargetSessionId
      }
    }
    return ""
  }

  private fun resolveActiveSessionChipState(): ActiveSessionChipState {
    val normalizedAudioState = runtimeStatusState.audio.lowercase()
    val pulse = normalizedAudioState == "playback"
    val captureActive = SessionChipHandoffUtils.isCaptureSessionChipActive(
      audioState = normalizedAudioState,
      recognitionIndicatorActive = recognitionIndicatorActive,
    )
    val active = pulse || captureActive
    val turnId = runtimeStatusState.turnId.trim()
    if (!active) {
      if (turnId.isBlank() && resolveStopTtsCaptureHandoffSessionId().isEmpty()) {
        lastActiveChipTurnId = ""
        lastActiveChipSessionId = ""
        activeCaptureSessionIdHint = ""
        activeCaptureSessionIdHintTurnId = ""
      }
      return ActiveSessionChipState(sessionId = "", pulse = false)
    }

    if (turnId.isNotEmpty()) {
      val linkedSessionId = resolveLinkedSessionIdForTurn(turnId)
      if (linkedSessionId.isNotEmpty()) {
        lastActiveChipTurnId = turnId
        lastActiveChipSessionId = linkedSessionId
        activeCaptureSessionIdHint = linkedSessionId
        activeCaptureSessionIdHintTurnId = turnId
        if (stopTtsCaptureHandoffSessionId == linkedSessionId) {
          clearStopTtsCaptureHandoff()
        }
        return ActiveSessionChipState(sessionId = linkedSessionId, pulse = pulse)
      }
      if (turnId == lastActiveChipTurnId && lastActiveChipSessionId.isNotEmpty()) {
        return ActiveSessionChipState(sessionId = lastActiveChipSessionId, pulse = pulse)
      }
    }

    if (!pulse) {
      val hintedSessionId = resolveHintedCaptureSessionId(turnId)
      if (hintedSessionId.isNotEmpty()) {
        return ActiveSessionChipState(sessionId = hintedSessionId, pulse = false)
      }
      val stopTtsHandoffSessionId = resolveStopTtsCaptureHandoffSessionId()
      if (stopTtsHandoffSessionId.isNotEmpty()) {
        return ActiveSessionChipState(sessionId = stopTtsHandoffSessionId, pulse = false)
      }

      if (activeAgentCaptureActive) {
        val selectedTargetSessionId = resolveSelectedSessionTarget()?.sessionId.orEmpty().trim()
        if (selectedTargetSessionId.isNotEmpty()) {
          return ActiveSessionChipState(sessionId = selectedTargetSessionId, pulse = false)
        }
      }
    }
    return ActiveSessionChipState(sessionId = "", pulse = false)
  }

  private fun resolveHintedCaptureSessionId(turnId: String): String {
    val hintedSessionId = activeCaptureSessionIdHint.trim()
    if (hintedSessionId.isEmpty()) {
      return ""
    }
    val hintTurnId = activeCaptureSessionIdHintTurnId.trim()
    if (hintTurnId.isEmpty()) {
      return hintedSessionId
    }
    if (turnId.isNotEmpty() && turnId != hintTurnId) {
      return ""
    }
    return hintedSessionId
  }

  private fun beginStopTtsCaptureHandoff(turnId: String) {
    val normalizedTurnId = turnId.trim()
    if (normalizedTurnId.isEmpty()) {
      clearStopTtsCaptureHandoff()
      return
    }
    val handoffSessionId = SessionChipHandoffUtils.resolveStopTtsSessionForHandoff(
      stopTurnId = normalizedTurnId,
      linkedSessionId = resolveLinkedSessionIdForTurn(normalizedTurnId),
      lastActiveTurnId = lastActiveChipTurnId,
      lastActiveSessionId = lastActiveChipSessionId,
    )
    if (handoffSessionId.isEmpty()) {
      clearStopTtsCaptureHandoff()
      return
    }

    stopTtsCaptureHandoffSessionId = handoffSessionId
    stopTtsCaptureHandoffExpiresAtMs = SystemClock.uptimeMillis() + stopTtsCaptureHandoffGraceMs
    // Allow recognition handoff to use this session even if turnId changes after stop-tts.
    activeCaptureSessionIdHint = handoffSessionId
    activeCaptureSessionIdHintTurnId = ""
  }

  private fun resolveStopTtsCaptureHandoffSessionId(): String {
    if (
      SessionChipHandoffUtils.isStopTtsHandoffActive(
        sessionId = stopTtsCaptureHandoffSessionId,
        expiresAtElapsedMs = stopTtsCaptureHandoffExpiresAtMs,
        nowElapsedMs = SystemClock.uptimeMillis(),
      )
    ) {
      return stopTtsCaptureHandoffSessionId
    }
    clearStopTtsCaptureHandoff()
    return ""
  }

  private fun clearStopTtsCaptureHandoff() {
    stopTtsCaptureHandoffSessionId = ""
    stopTtsCaptureHandoffExpiresAtMs = 0L
  }

  private fun resolveLinkedSessionIdForTurn(turnId: String): String {
    if (turnId.isBlank()) {
      return ""
    }
    for (message in BubbleHistoryStore.readAll(this).asReversed()) {
      val model = classifyBubble(message)
      if (model.turnId != turnId) {
        continue
      }
      val sessionId = model.linkedSessionId.trim()
      if (sessionId.isNotEmpty()) {
        return sessionId
      }
    }
    return ""
  }

  private fun mergeRuntimeStatusState(
    ws: String? = null,
    audio: String? = null,
    media: String? = null,
    music: String? = null,
    turnId: String? = null,
  ) {
    runtimeStatusState = runtimeStatusState.copy(
      ws = ws ?: runtimeStatusState.ws,
      audio = audio ?: runtimeStatusState.audio,
      media = media ?: runtimeStatusState.media,
      music = music ?: runtimeStatusState.music,
      turnId = turnId ?: runtimeStatusState.turnId,
    )
    renderRuntimeStatusBar()
    renderActiveClientControls()
    renderVoiceToAgentControls()
    updateActiveTurnBubbleOutline()
    updateRecognitionIndicatorPresentation()
  }

  private fun parseRuntimeStatusState(raw: String): RuntimeStatusState? {
    return try {
      val payload = JSONObject(raw)
      val parsed = mergeRuntimeStatusPayload(
        ws = payload.optString("ws", runtimeStatusState.ws),
        audio = payload.optString("audio", runtimeStatusState.audio),
        media = payload.optString("media", runtimeStatusState.media),
        music = payload.optString("music", runtimeStatusState.music),
        turnId = payload.optString("turnId", runtimeStatusState.turnId),
        fallback = RuntimeStatusParsed(
          ws = runtimeStatusState.ws,
          audio = runtimeStatusState.audio,
          media = runtimeStatusState.media,
          music = runtimeStatusState.music,
          turnId = runtimeStatusState.turnId,
        ),
      )
      RuntimeStatusState(
        ws = parsed.ws,
        audio = parsed.audio,
        media = parsed.media,
        music = parsed.music,
        turnId = parsed.turnId,
      )
    } catch (_: JSONException) {
      null
    }
  }

  private fun parseActiveClientState(raw: String): ActiveClientState? {
    val parsed = parseActiveClientStatePayload(
      raw = raw,
      fallback = ActiveClientStateParsed(
        active = activeClientState.active,
        activeClientConnected = activeClientState.activeClientConnected,
        connectedClients = activeClientState.connectedClients,
      ),
    ) ?: return null
    return ActiveClientState(
      active = parsed.active,
      activeClientConnected = parsed.activeClientConnected,
      connectedClients = parsed.connectedClients,
    )
  }

  private fun parseActiveAgentCaptureState(raw: String): Boolean? {
    return try {
      val payload = JSONObject(raw)
      payload.optBoolean("active", false)
    } catch (_: JSONException) {
      null
    }
  }

  private fun renderActiveClientControls() {
    val t = currentTheme
    val wsConnected = runtimeStatusState.ws.equals("connected", ignoreCase = true)
    if (!serviceSwitch.isChecked || !wsConnected) {
      renderActivateClientButtonState(
        iconResId = R.drawable.ic_active_client_outline_24,
        tintColor = t.activateDisabledIcon,
        backgroundColor = t.activateDisabledBg,
        borderColor = t.activateDisabledBorder,
        contentDescription = "Activate unavailable",
        enabled = false,
      )
      activeClientStatusText.text = "Active device: disconnected"
      return
    }

    if (activeClientState.active) {
      renderActivateClientButtonState(
        iconResId = R.drawable.ic_active_client_filled_24,
        tintColor = t.activateActiveIcon,
        backgroundColor = t.activateActiveBg,
        borderColor = t.activateActiveBorder,
        contentDescription = "Deactivate this device",
        enabled = true,
      )
      activeClientStatusText.text = "Active device: this device"
      return
    }

    renderActivateClientButtonState(
      iconResId = R.drawable.ic_active_client_outline_24,
      tintColor = t.activateInactiveIcon,
      backgroundColor = t.activateInactiveBg,
      borderColor = t.activateInactiveBorder,
      contentDescription = "Activate this device",
      enabled = true,
    )
    activeClientStatusText.text = if (activeClientState.activeClientConnected) {
      "Active device: other device"
    } else {
      "Active device: none"
    }
  }

  private fun renderActivateClientButtonState(
    iconResId: Int,
    tintColor: Int,
    backgroundColor: Int,
    borderColor: Int,
    contentDescription: String,
    enabled: Boolean,
  ) {
    activateClientButton.setImageResource(iconResId)
    activateClientButton.imageTintList = ColorStateList.valueOf(tintColor)
    activateClientButton.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(backgroundColor)
      val strokeWidthPx = resources.displayMetrics.density.toInt().coerceAtLeast(1)
      setStroke(strokeWidthPx, borderColor)
    }
    activateClientButton.contentDescription = contentDescription
    activateClientButton.isEnabled = enabled
    activateClientButton.alpha = if (enabled) 1f else 0.9f
  }

  private fun requestClientActivationToggle() {
    if (!serviceSwitch.isChecked) {
      statusText.text = "Service must be running to change active device."
      return
    }
    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    if (activeClientState.active) {
      startService(VoiceAdapterService.deactivateClientIntent(this, config))
      statusText.text = "Deactivation requested."
    } else {
      startService(VoiceAdapterService.activateClientIntent(this, config))
      statusText.text = "Activation requested."
    }
  }

  private fun renderVoiceToAgentControls() {
    val selectedTarget = resolveSelectedSessionTarget()
    activeAgentStatusText.text = if (selectedTarget == null) {
      "Selected session: Global"
    } else {
      "Selected session: ${formatWorkspaceAndTitle(selectedTarget.workspace, selectedTarget.resolvedTitle)}"
    }

    val t = currentTheme
    if (activeAgentCaptureActive) {
      sendToAgentButton.visibility = View.GONE
      renderVoiceToAgentButtonState(
        iconResId = R.drawable.ic_close_24,
        tintColor = t.voiceCancelIcon,
        contentDescription = "Cancel session capture",
        enabled = serviceSwitch.isChecked,
        circularBackgroundColor = t.voiceCancelBg,
        circularBorderColor = t.voiceCancelBorder,
      )
      return
    }

    sendToAgentButton.visibility = View.VISIBLE
    val readyForStart = isVoiceToAgentReadyForStart(selectedTarget)
    renderSendToAgentButtonState(
      iconResId = R.drawable.ic_send_24,
      tintColor = if (readyForStart) t.voiceReadyIcon else t.voiceNotReadyIcon,
      contentDescription = if (readyForStart) {
        "Start verbatim send to selected session"
      } else {
        "Verbatim send unavailable"
      },
      enabled = readyForStart,
    )
    renderVoiceToAgentButtonState(
      iconResId = R.drawable.ic_chat_bubble_outline_24,
      tintColor = if (readyForStart) t.voiceReadyIcon else t.voiceNotReadyIcon,
      contentDescription = if (readyForStart) {
        "Start voice to selected session"
      } else {
        "Voice to selected session unavailable"
      },
      enabled = readyForStart,
    )
  }

  private fun renderSendToAgentButtonState(
    iconResId: Int,
    tintColor: Int,
    contentDescription: String,
    enabled: Boolean,
    circularBackgroundColor: Int? = null,
    circularBorderColor: Int? = null,
  ) {
    sendToAgentButton.setImageResource(iconResId)
    sendToAgentButton.imageTintList = ColorStateList.valueOf(tintColor)
    if (circularBackgroundColor != null && circularBorderColor != null) {
      sendToAgentButton.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(circularBackgroundColor)
        val strokeWidthPx = resources.displayMetrics.density.toInt().coerceAtLeast(1)
        setStroke(strokeWidthPx, circularBorderColor)
      }
    } else {
      sendToAgentButton.backgroundTintList = null
      sendToAgentButton.background = null
      sendToAgentButton.setBackgroundColor(Color.TRANSPARENT)
    }
    sendToAgentButton.contentDescription = contentDescription
    sendToAgentButton.isEnabled = enabled
    sendToAgentButton.alpha = if (enabled) 1f else 0.9f
  }

  private fun renderVoiceToAgentButtonState(
    iconResId: Int,
    tintColor: Int,
    contentDescription: String,
    enabled: Boolean,
    circularBackgroundColor: Int? = null,
    circularBorderColor: Int? = null,
  ) {
    voiceToAgentButton.setImageResource(iconResId)
    voiceToAgentButton.imageTintList = ColorStateList.valueOf(tintColor)
    if (circularBackgroundColor != null && circularBorderColor != null) {
      voiceToAgentButton.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(circularBackgroundColor)
        val strokeWidthPx = resources.displayMetrics.density.toInt().coerceAtLeast(1)
        setStroke(strokeWidthPx, circularBorderColor)
      }
    } else {
      voiceToAgentButton.backgroundTintList = null
      voiceToAgentButton.background = null
      voiceToAgentButton.setBackgroundColor(Color.TRANSPARENT)
    }
    voiceToAgentButton.contentDescription = contentDescription
    voiceToAgentButton.isEnabled = enabled
    voiceToAgentButton.alpha = if (enabled) 1f else 0.9f
  }

  private fun requestVoiceToAgentCapture(
    targetOverride: ActiveAgentTarget? = null,
    quotedAssistantText: String? = null,
    sourceBubbleTurnId: String? = null,
    sendVerbatim: Boolean = false,
  ) {
    val target = targetOverride ?: resolveSelectedSessionTarget()
    if (!serviceSwitch.isChecked) {
      statusText.text = "Run foreground service to use Voice to Agent."
      return
    }
    if (!activeAgentCaptureActive && target == null) {
      statusText.text = "Select a non-Global session chip first."
      return
    }

    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    val sessionId = target?.sessionId.orEmpty()
    val normalizedQuotedAssistantText = quotedAssistantText?.trim().orEmpty()
    val normalizedSourceBubbleTurnId = sourceBubbleTurnId?.trim().orEmpty()
    if (!activeAgentCaptureActive) {
      activeCaptureSessionIdHint = sessionId.trim()
      activeCaptureSessionIdHintTurnId = ""
      pendingLocalCaptureSourceBubbleTurnId = normalizedSourceBubbleTurnId
      pendingLocalCaptureSourceSetAtMs = if (normalizedSourceBubbleTurnId.isNotEmpty()) {
        SystemClock.uptimeMillis()
      } else {
        0L
      }
      if (normalizedSourceBubbleTurnId.isEmpty()) {
        localCaptureSourceBubbleTurnId = ""
      }
    }
    val workspace = target?.workspace.orEmpty()
    val resolvedTitle = target?.resolvedTitle.orEmpty()
    startService(
      VoiceAdapterService.captureActiveAgentIntent(
        context = this,
        config = config,
        sessionId = sessionId,
        workspace = workspace,
        resolvedTitle = resolvedTitle,
        quotedAssistantText = normalizedQuotedAssistantText.ifEmpty { null },
        sendVerbatim = sendVerbatim,
      ),
    )
    val targetLabel = target?.resolvedTitle?.ifEmpty { target.sessionId } ?: "selected session"
    statusText.text = if (activeAgentCaptureActive) {
      "Canceling session capture."
    } else {
      if (sendVerbatim) {
        "Starting verbatim capture for $targetLabel."
      } else {
        "Starting voice capture for $targetLabel."
      }
    }
  }

  private fun isVoiceToAgentReadyForStart(target: ActiveAgentTarget?): Boolean {
    return serviceSwitch.isChecked &&
      runtimeStatusState.ws.equals("connected", ignoreCase = true) &&
      activeClientState.active &&
      target != null &&
      listenSwitch.isChecked &&
      runtimeStatusState.audio.equals("idle", ignoreCase = true)
  }

  private fun resolveBubbleLinkedSessionLabel(model: BubbleRenderModel): String? {
    val linkedSessionId = model.linkedSessionId.trim()
    if (linkedSessionId.isEmpty()) {
      return null
    }
    val linkedSessionTitle = model.linkedSessionTitle.trim()
    return linkedSessionTitle.takeIf { it.isNotEmpty() }
  }

  private fun resolveBubbleLinkedSessionTarget(model: BubbleRenderModel): ActiveAgentTarget? {
    val linkedSessionId = model.linkedSessionId.trim()
    if (linkedSessionId.isEmpty()) {
      return null
    }
    val linkedSessionTitle = model.linkedSessionTitle.trim()
    if (linkedSessionTitle.isEmpty()) {
      return null
    }
    return ActiveAgentTarget(
      sessionId = linkedSessionId,
      workspace = "",
      resolvedTitle = linkedSessionTitle,
    )
  }

  private fun formatWorkspaceAndTitle(workspace: String, title: String): String {
    val normalizedWorkspace = workspace.trim()
    val normalizedTitle = title.trim()
    return if (normalizedWorkspace.isNotEmpty()) {
      "$normalizedWorkspace, ${normalizedTitle.ifEmpty { "(no title)" }}"
    } else {
      normalizedTitle.ifEmpty { "(no title)" }
    }
  }

  private fun resolveSelectedSessionTarget(): ActiveAgentTarget? {
    val selectedSessionId = SessionFilterUtils.normalizeFilterId(selectedSessionFilterId)
    if (selectedSessionId.isEmpty()) {
      return null
    }
    if (!renderedSessionFilterIds.contains(selectedSessionId)) {
      return null
    }

    val cached = cachedSessionDispatchRows.firstOrNull { row -> row.sessionId == selectedSessionId }
    if (cached != null) {
      return ActiveAgentTarget(
        sessionId = cached.sessionId,
        workspace = cached.workspace,
        resolvedTitle = cached.resolvedTitle.ifEmpty { cached.sessionId },
      )
    }

    val linkedTitle = BubbleHistoryStore.readAll(this).asReversed()
      .asSequence()
      .map { classifyBubble(it) }
      .firstOrNull { model -> model.linkedSessionId.trim() == selectedSessionId }
      ?.linkedSessionTitle
      ?.trim()
      .orEmpty()

    return ActiveAgentTarget(
      sessionId = selectedSessionId,
      workspace = "",
      resolvedTitle = linkedTitle.ifEmpty { selectedSessionId },
    )
  }

  private fun handleBubbleLinkedSessionTap(model: BubbleRenderModel) {
    val target = resolveBubbleLinkedSessionTarget(model)
    if (target == null) {
      statusText.text = "No linked session on this bubble."
      return
    }
    if (!isVoiceToAgentReadyForStart(target)) {
      statusText.text = "Voice to Agent can start only while idle."
      return
    }
    requestVoiceToAgentCapture(target)
  }

  private fun buildBubbleReferenceActionRow(model: BubbleRenderModel): View? {
    if (model.role != "assistant" || model.turnId.isBlank()) {
      return null
    }
    if (resolveBubbleLinkedSessionTarget(model) == null) {
      return null
    }

    val density = resources.displayMetrics.density
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      )
      gravity = Gravity.CENTER_VERTICAL
    }

    val sendButton = makeBubbleHeaderActionButton(
      turnId = model.turnId,
      iconResId = R.drawable.ic_reply_24,
      contentDescription = "Send canned response",
      density = density,
    ) {
      if (isLocalCaptureSourceTurnInProgress(model.turnId)) {
        statusText.text = "Use the mic action to cancel this in-progress capture."
        return@makeBubbleHeaderActionButton
      }
      if (isActiveTurn(model.turnId)) {
        statusText.text = "This action is available after the turn closes."
        return@makeBubbleHeaderActionButton
      }
      sendBubbleReferenceCannedResponse(model)
    }
    row.addView(sendButton)

    val voiceButton = makeBubbleHeaderActionButton(
      turnId = model.turnId,
      iconResId = android.R.drawable.ic_btn_speak_now,
      contentDescription = "Respond with voice",
      density = density,
      isFirst = false,
    ) {
      if (isLocalCaptureSourceTurnInProgress(model.turnId)) {
        cancelLocalCaptureFromBubbleAction()
        return@makeBubbleHeaderActionButton
      }
      if (isActiveTurn(model.turnId)) {
        statusText.text = "This action is available after the turn closes."
        return@makeBubbleHeaderActionButton
      }
      startBubbleReferencedVoiceCapture(model)
    }
    row.addView(voiceButton)

    return row
  }

  private fun makeBubbleHeaderActionButton(
    turnId: String,
    iconResId: Int,
    contentDescription: String,
    density: Float,
    isFirst: Boolean = true,
    onClick: () -> Unit,
  ): ImageButton {
    val sizePx = (24 * density).toInt().coerceAtLeast(22)
    return ImageButton(this).apply {
      setImageResource(iconResId)
      setPadding((4 * density).toInt(), (4 * density).toInt(), (4 * density).toInt(), (4 * density).toInt())
      this.contentDescription = contentDescription
      tag = "$bubbleHeaderActionTagPrefix$turnId"
      layoutParams = LinearLayout.LayoutParams(sizePx, sizePx).apply {
        if (!isFirst) {
          marginStart = (6 * density).toInt()
        }
      }
      scaleType = ImageView.ScaleType.CENTER_INSIDE
      applyBubbleHeaderActionButtonState(this, enabled = true)
      setOnClickListener { onClick() }
    }
  }

  private fun applyBubbleHeaderActionButtonState(button: ImageButton, enabled: Boolean) {
    button.isEnabled = enabled
    button.alpha = 1f
    button.backgroundTintList = null
    button.background = null
    button.setBackgroundColor(Color.TRANSPARENT)
    val tintColor = if (enabled) currentTheme.accent else currentTheme.textSecondary
    button.imageTintList = ColorStateList.valueOf(tintColor)
    maybeLogBubbleHeaderActionState(button, enabled, tintColor)
  }

  private fun maybeLogBubbleHeaderActionState(button: ImageButton, enabled: Boolean, tintColor: Int) {
    val tagValue = button.tag?.toString().orEmpty()
    val summary =
      "enabled=$enabled tint=${formatColorHex(tintColor)} audio=${runtimeStatusState.audio} listening=$recognitionIndicatorActive captureActive=$activeAgentCaptureActive turnId=${runtimeStatusState.turnId}"
    val previous = bubbleHeaderActionStateLogCache[tagValue]
    if (previous == summary) {
      return
    }
    bubbleHeaderActionStateLogCache[tagValue] = summary
    Log.i(TAG, "ui_bubble_header_action_state tag=$tagValue $summary")
  }

  private fun formatColorHex(color: Int): String {
    return String.format("#%08X", color)
  }

  private fun sendBubbleReferenceCannedResponse(model: BubbleRenderModel) {
    val target = resolveBubbleLinkedSessionTarget(model)
    if (target == null) {
      statusText.text = "No linked session on this bubble."
      return
    }
    val assistantText = model.body.trim()
    if (assistantText.isEmpty()) {
      statusText.text = "Cannot reference an empty assistant message."
      return
    }

    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    val dispatchMessage = buildBubbleReferenceDispatchMessage(
      assistantMessage = assistantText,
      userResponse = bubbleReferenceCannedResponseText,
    )
    statusText.text = "Sending referenced response..."
    sendSessionDispatchMessage(
      config = config,
      sessionId = target.sessionId,
      mode = "custom",
      customMessage = dispatchMessage,
      onSuccess = { _ ->
        val localBubble = JSONObject()
          .put("kind", "bubble")
          .put("role", "user")
          .put("body", bubbleReferenceCannedResponseText)
          .put("linkedSessionId", target.sessionId)
          .put("linkedSessionTitle", target.resolvedTitle)
          .toString()
        BubbleHistoryStore.append(this, localBubble)
        appendBubble(localBubble)
        statusText.text = "Referenced response sent to ${target.resolvedTitle}."
      },
      onError = { error ->
        statusText.text = error
      },
    )
  }

  private fun startBubbleReferencedVoiceCapture(model: BubbleRenderModel) {
    val target = resolveBubbleLinkedSessionTarget(model)
    if (target == null) {
      statusText.text = "No linked session on this bubble."
      return
    }
    val assistantText = model.body.trim()
    if (assistantText.isEmpty()) {
      statusText.text = "Cannot reference an empty assistant message."
      return
    }
    requestVoiceToAgentCapture(
      targetOverride = target,
      quotedAssistantText = assistantText,
      sourceBubbleTurnId = model.turnId,
    )
  }

  private fun buildBubbleReferenceDispatchMessage(
    assistantMessage: String,
    userResponse: String,
  ): String {
    val normalizedAssistant = assistantMessage.trim()
    val normalizedResponse = userResponse.trim()
    val contextualMessage = if (normalizedAssistant.isEmpty()) {
      normalizedResponse
    } else {
      listOf(
        "User is responding to a previous assistant message.",
        "Assistant message:",
        normalizedAssistant,
        "User response:",
        normalizedResponse,
      ).joinToString("\n")
    }
    return buildSessionDispatchCustomMessage(contextualMessage)
  }

  private fun bubbleTextColor(role: String): Int {
    return when (role) {
      "assistant" -> currentTheme.bubbleAssistantText
      "user" -> currentTheme.bubbleUserText
      else -> currentTheme.bubbleSystemText
    }
  }

  private fun bubbleHeaderTextColor(role: String, noWait: Boolean): Int {
    return BubbleHeaderTextColorResolver.resolve(
      role = role,
      noWait = noWait,
      assistantHeaderColor = currentTheme.bubbleAssistantHeader,
      assistantNoWaitHeaderColor = currentTheme.bubbleAssistantNoWaitHeader,
      userHeaderColor = currentTheme.bubbleUserHeader,
      systemHeaderColor = currentTheme.bubbleSystemHeader,
    )
  }

  private fun bubbleRoleLabel(role: String): String {
    return when (role) {
      "assistant" -> "Assistant"
      "user" -> "You"
      else -> "System"
    }
  }

  private fun bubbleFillColor(role: String, noWait: Boolean): Int {
    return BubbleFillColorResolver.resolve(
      role = role,
      noWait = noWait,
      assistantColor = currentTheme.bubbleAssistant,
      assistantNoWaitColor = currentTheme.bubbleAssistantNoWait,
      userColor = currentTheme.bubbleUser,
      systemColor = currentTheme.bubbleSystem,
    )
  }

  private fun activeBubbleStaticStrokeWidthPx(): Int {
    return (3 * resources.displayMetrics.density).toInt().coerceAtLeast(3)
  }

  private fun activeBubblePulseMaxStrokeWidthPx(): Int {
    val staticWidth = activeBubbleStaticStrokeWidthPx()
    return (3.5f * resources.displayMetrics.density).toInt().coerceAtLeast(staticWidth + 1)
  }

  private fun activeBubbleDimStrokeColor(): Int {
    return BubblePulse.withAlpha(currentTheme.bubbleActiveBorder, bubblePulseMinAlphaFraction)
  }

  private fun isActiveAssistantTurn(state: BubbleViewState): Boolean {
    return state.role == "assistant" &&
      state.turnId.isNotBlank() &&
      state.turnId == runtimeStatusState.turnId
  }

  private fun isLocalCaptureSourceAssistantTurn(state: BubbleViewState): Boolean {
    if (state.role != "assistant") {
      return false
    }
    if (state.turnId.isBlank() || state.turnId != localCaptureSourceBubbleTurnId) {
      return false
    }
    return isLocalCaptureSourceTurnInProgress(state.turnId)
  }

  private fun isLocalCaptureSourceTurnInProgress(turnId: String): Boolean {
    val normalizedTurnId = turnId.trim()
    if (normalizedTurnId.isEmpty() || normalizedTurnId != localCaptureSourceBubbleTurnId) {
      return false
    }
    return activeAgentCaptureActive ||
      recognitionIndicatorActive ||
      runtimeStatusState.audio.equals("capture", ignoreCase = true)
  }

  private fun cancelLocalCaptureFromBubbleAction() {
    val activeTurnId = runtimeStatusState.turnId.trim()
    if (activeTurnId.isEmpty()) {
      statusText.text = "No active recognition turn to cancel."
      return
    }
    showTurnCancelConfirmationDialog(
      turnId = activeTurnId,
      title = "Cancel Recognition",
      message = "Cancel recognition for this turn?",
    )
  }

  private fun isPlaybackAssistantTurn(state: BubbleViewState): Boolean {
    return isActiveAssistantTurn(state) && runtimeStatusState.audio.equals("playback", ignoreCase = true)
  }

  private fun setBubbleQuickReplyButtonsEnabled(bubble: View, enabled: Boolean) {
    val group = bubble as? ViewGroup ?: return
    for (index in 0 until group.childCount) {
      val child = group.getChildAt(index)
      val tag = child.tag as? String ?: continue
      if (!tag.startsWith(bubbleQuickReplyRowTagPrefix)) {
        continue
      }
      val row = (child as? HorizontalScrollView)?.getChildAt(0) as? ViewGroup ?: continue
      for (rowIndex in 0 until row.childCount) {
        val button = row.getChildAt(rowIndex) as? Button ?: continue
        button.isEnabled = enabled
        button.alpha = if (enabled) 1f else 0.55f
      }
    }
  }

  private fun setBubbleHeaderActionButtonsEnabled(bubble: View, enabled: Boolean) {
    fun applyRecursively(view: View) {
      val tag = view.tag as? String
      if (tag != null && tag.startsWith(bubbleHeaderActionTagPrefix)) {
        val button = view as? ImageButton
        if (button != null) {
          applyBubbleHeaderActionButtonState(button, enabled)
        }
      }
      val group = view as? ViewGroup ?: return
      for (index in 0 until group.childCount) {
        applyRecursively(group.getChildAt(index))
      }
    }
    applyRecursively(bubble)
  }

  private fun markBubbleQuickReplyConsumed(turnId: String) {
    if (turnId.isBlank()) {
      return
    }
    for (index in 0 until chatContainer.childCount) {
      val child = chatContainer.getChildAt(index)
      val state = child.tag as? BubbleViewState ?: continue
      if (state.turnId != turnId || state.quickReplyConsumed) {
        continue
      }
      val nextState = state.copy(quickReplyConsumed = true)
      child.tag = nextState
      updateBubbleVisualState(child, nextState)
      break
    }
  }

  private fun updateBubbleVisualState(bubble: View, state: BubbleViewState) {
    val isActiveTurn = isActiveAssistantTurn(state)
    val isHighlightedCaptureSource = isLocalCaptureSourceAssistantTurn(state)
    val showActiveOutline = isActiveTurn || isHighlightedCaptureSource
    val quickRepliesEnabled =
      !state.quickReplyConsumed &&
      (isActiveTurn || state.allowInactiveQuickReplies)
    val audioBusy = !runtimeStatusState.audio.equals("idle", ignoreCase = true)
    val captureInProgress =
      recognitionIndicatorActive ||
      activeAgentCaptureActive ||
      audioBusy
    val allowSourceBubbleCancelAction = isHighlightedCaptureSource && captureInProgress
    setBubbleQuickReplyButtonsEnabled(bubble, quickRepliesEnabled)
    setBubbleHeaderActionButtonsEnabled(
      bubble,
      enabled = !isActiveTurn && (!captureInProgress || allowSourceBubbleCancelAction),
    )

    val bg = GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = 16f * resources.displayMetrics.density
      setColor(bubbleFillColor(state.role, state.noWait))
      if (showActiveOutline) {
        setStroke(
          activeBubbleStaticStrokeWidthPx(),
          activeBubbleDimStrokeColor(),
        )
      }
    }
    bubble.background = bg
  }

  private fun updateActiveTurnBubbleOutline() {
    var activePlaybackBubble: View? = null
    for (index in 0 until chatContainer.childCount) {
      val child = chatContainer.getChildAt(index)
      val bubbleState = child.tag as? BubbleViewState ?: continue
      updateBubbleVisualState(child, bubbleState)
      if (isPlaybackAssistantTurn(bubbleState)) {
        activePlaybackBubble = child
      }
    }
    syncActiveBubblePulse(activePlaybackBubble)
  }

  private fun maybeClearLocalCaptureSourceBubbleTurnId() {
    if (pendingLocalCaptureSourceBubbleTurnId.isNotEmpty()) {
      val captureInProgress =
        activeAgentCaptureActive ||
        recognitionIndicatorActive ||
        runtimeStatusState.audio.equals("capture", ignoreCase = true)
      if (!captureInProgress) {
        val pendingAgeMs = (SystemClock.uptimeMillis() - pendingLocalCaptureSourceSetAtMs).coerceAtLeast(0L)
        if (pendingAgeMs >= 3000L) {
          pendingLocalCaptureSourceBubbleTurnId = ""
          pendingLocalCaptureSourceSetAtMs = 0L
        }
      }
    }
    if (localCaptureSourceBubbleTurnId.isBlank()) {
      return
    }
    val captureInProgress =
      activeAgentCaptureActive ||
      recognitionIndicatorActive ||
      runtimeStatusState.audio.equals("capture", ignoreCase = true)
    if (captureInProgress) {
      return
    }
    localCaptureSourceBubbleTurnId = ""
  }

  private fun syncActiveBubblePulse(activePlaybackBubble: View?) {
    if (activePlaybackBubble == null) {
      stopActiveBubblePulse()
      return
    }
    if (activeBubblePulseView === activePlaybackBubble && activeBubblePulseRunnable != null) {
      return
    }
    startActiveBubblePulse(activePlaybackBubble)
  }

  private fun startActiveBubblePulse(bubble: View) {
    stopActiveBubblePulse()
    activeBubblePulseView = bubble
    activeBubblePulseStartedAtMs = SystemClock.uptimeMillis()
    val pulseRunnable = object : Runnable {
      override fun run() {
        val pulseBubble = activeBubblePulseView ?: return
        val pulseState = pulseBubble.tag as? BubbleViewState ?: return
        if (!isPlaybackAssistantTurn(pulseState)) {
          stopActiveBubblePulse()
          return
        }
        val bubbleBackground = pulseBubble.background as? GradientDrawable ?: return
        val elapsedMs = SystemClock.uptimeMillis() - activeBubblePulseStartedAtMs
        val pulseFraction = BubblePulse.trianglePulseFraction(elapsedMs, bubblePulseDurationMs)
        val alphaFraction = BubblePulse.pulseFractionToAlphaFraction(
          pulseFraction = pulseFraction,
          minAlphaFraction = bubblePulseMinAlphaFraction,
        )
        val strokeWidth = BubblePulse.pulseFractionToInt(
          pulseFraction = pulseFraction,
          minValue = activeBubbleStaticStrokeWidthPx(),
          maxValue = activeBubblePulseMaxStrokeWidthPx(),
        )
        bubbleBackground.setStroke(
          strokeWidth,
          BubblePulse.withAlpha(currentTheme.bubbleActiveBorder, alphaFraction),
        )
        chatContainer.postDelayed(this, bubblePulseFrameMs)
      }
    }
    activeBubblePulseRunnable = pulseRunnable
    chatContainer.post(pulseRunnable)
  }

  private fun stopActiveBubblePulse() {
    activeBubblePulseRunnable?.let { runnable ->
      chatContainer.removeCallbacks(runnable)
    }
    activeBubblePulseRunnable = null
    activeBubblePulseStartedAtMs = 0L
    activeBubblePulseView = null
  }

  private fun maybeRefreshBubblesForActivePlaybackTurn() {
    val activeTurnId = runtimeStatusState.turnId
    if (activeTurnId.isBlank()) {
      return
    }
    if (!runtimeStatusState.audio.equals("playback", ignoreCase = true)) {
      return
    }
    if (hasRenderedAssistantBubbleForTurn(activeTurnId) || hasStoredAssistantBubbleForTurn(activeTurnId)) {
      return
    }
    // Turn bubbles can be appended while activity is backgrounded; force a refresh so
    // foreground resume reflects in-flight playback controls immediately.
    renderPersistedBubbles()
  }

  private fun hasRenderedAssistantBubbleForTurn(turnId: String): Boolean {
    for (index in 0 until chatContainer.childCount) {
      val child = chatContainer.getChildAt(index)
      val bubbleState = child.tag as? BubbleViewState ?: continue
      if (bubbleState.role == "assistant" && bubbleState.turnId == turnId) {
        return true
      }
    }
    return false
  }

  private fun hasStoredAssistantBubbleForTurn(turnId: String): Boolean {
    return BubbleHistoryStore.readAll(this).any { message ->
      val model = classifyBubble(message)
      model.role == "assistant" && model.turnId == turnId
    }
  }

  private fun showBubbleMenu(anchor: View, turnId: String) {
    val localCaptureSourceInProgress = isLocalCaptureSourceTurnInProgress(turnId)
    if (!isActiveTurn(turnId) && !localCaptureSourceInProgress) {
      statusText.text = "That turn is no longer active."
      return
    }

    val menu = PopupMenu(this, anchor)
    if (localCaptureSourceInProgress) {
      menu.menu.add(0, 3, 0, "Cancel capture")
    } else {
      menu.menu.add(0, 1, 0, "Stop TTS")
      menu.menu.add(0, 2, 1, "Cancel turn")
    }
    menu.setOnMenuItemClickListener { item ->
      when (item.itemId) {
        3 -> {
          cancelLocalCaptureFromBubbleAction()
          true
        }

        1 -> {
          requestTurnStopTts(turnId)
          true
        }

        2 -> {
          requestTurnCancel(turnId)
          true
        }

        else -> false
      }
    }
    menu.show()
  }

  private fun isActiveTurn(turnId: String): Boolean {
    return runtimeStatusState.turnId.isNotBlank() && runtimeStatusState.turnId == turnId
  }

  private fun handleBubblePrimaryAction(turnId: String) {
    if (isLocalCaptureSourceTurnInProgress(turnId)) {
      cancelLocalCaptureFromBubbleAction()
      return
    }
    if (!isActiveTurn(turnId)) {
      statusText.text = "That turn is no longer active."
      return
    }
    when (runtimeStatusState.audio.lowercase()) {
      "playback" -> requestTurnStopTts(turnId)
      "capture" ->
        showTurnCancelConfirmationDialog(
          turnId = turnId,
          title = "Cancel Turn",
          message = "Cancel this active turn?",
        )
      else -> statusText.text = "No active playback or recognition action for this turn."
    }
  }

  private fun handleRecognitionIndicatorTap() {
    if (!recognitionIndicatorActive) {
      return
    }
    val turnId = runtimeStatusState.turnId.trim()
    if (turnId.isEmpty()) {
      statusText.text = "No active recognition turn to cancel."
      return
    }
    showTurnCancelConfirmationDialog(
      turnId = turnId,
      title = "Cancel Recognition",
      message = "Cancel recognition for this turn?",
    )
  }

  private fun showTurnCancelConfirmationDialog(turnId: String, title: String, message: String) {
    AlertDialog.Builder(this)
      .setTitle(title)
      .setMessage(message)
      .setPositiveButton("Yes") { _, _ ->
        requestTurnCancel(turnId)
      }
      .setNegativeButton("No", null)
      .show()
  }

  private fun requestTurnCancel(turnId: String) {
    if (!serviceSwitch.isChecked) {
      statusText.text = "Service must be running to cancel a turn."
      return
    }
    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    startService(VoiceAdapterService.abortTurnIntent(this, config, turnId))
    statusText.text = "Cancel requested for turn $turnId."
  }

  private fun requestTurnStopTts(turnId: String) {
    if (!serviceSwitch.isChecked) {
      statusText.text = "Service must be running to stop TTS."
      return
    }
    beginStopTtsCaptureHandoff(turnId)
    val config = readConfigFromUi()
    AdapterPrefs.save(this, config)
    startService(VoiceAdapterService.stopTtsIntent(this, config, turnId))
    statusText.text = "Stop TTS requested for turn $turnId."
  }

  private fun applyLegacyStatusHeuristics(message: String) {
    val lower = message.lowercase()
    when {
      lower.contains("connected to") -> mergeRuntimeStatusState(ws = "connected")
      lower.contains("websocket error") -> mergeRuntimeStatusState(ws = "error")
      lower.contains("disconnected") || lower.contains("reconnecting") ->
        mergeRuntimeStatusState(ws = "reconnecting")
    }
  }

  private fun renderRuntimeStatusBar() {
    val ws = runtimeStatusState.ws.lowercase()
    val defaultChipColor = currentTheme.chipDefault
    val wsLabelColor = when (ws) {
      "connected" -> "Connected" to currentTheme.successSubtle
      "connecting" -> "Connecting" to currentTheme.warningSubtle
      "reconnecting" -> "Reconnecting" to currentTheme.warning
      "error" -> "Error" to currentTheme.errorSubtle
      "stopped" -> "Stopped" to defaultChipColor
      else -> ws.replaceFirstChar { it.uppercase() } to defaultChipColor
    }

    val audio = runtimeStatusState.audio.lowercase()
    val audioLabelColor = when (audio) {
      "capture" -> "Capture" to currentTheme.accentSubtle
      "playback" -> "Playback" to currentTheme.warningSubtle
      "idle" -> "Idle" to defaultChipColor
      else -> audio.replaceFirstChar { it.uppercase() } to defaultChipColor
    }

    val media = runtimeStatusState.media.lowercase()
    val mediaLabelColor = when (media) {
      "pause_pending" -> "Pausing" to currentTheme.warningSubtle
      "paused_by_us" -> "Paused" to currentTheme.warningSubtle
      "resume_pending" -> "Resume pending" to currentTheme.warning
      "resumed" -> "Resumed" to currentTheme.successSubtle
      "passthrough" -> "Passthrough" to defaultChipColor
      "active_unmanaged" -> "Active ext" to currentTheme.errorSubtle
      "pause_failed" -> "Pause failed" to currentTheme.errorSubtle
      else -> media.replaceFirstChar { it.uppercase() } to defaultChipColor
    }

    val music = runtimeStatusState.music.lowercase()
    val musicLabelColor = when (music) {
      "start_active" -> "Start active" to currentTheme.successSubtle
      "start_inactive" -> "Start inactive" to defaultChipColor
      "end_active" -> "End active" to currentTheme.successSubtle
      "end_inactive" -> "End inactive" to defaultChipColor
      "not_checked" -> "Not checked" to defaultChipColor
      else -> "Unknown" to defaultChipColor
    }

    renderStatusChip(statusChipWsText, "WS", wsLabelColor.first, wsLabelColor.second)
    renderStatusChip(statusChipAudioText, "Audio", audioLabelColor.first, audioLabelColor.second)
    renderStatusChip(statusChipMediaText, "Media", mediaLabelColor.first, mediaLabelColor.second)
    renderStatusChip(statusChipMusicText, "Music", musicLabelColor.first, musicLabelColor.second)
  }

  private fun renderStatusChip(textView: TextView, label: String, value: String, color: Int) {
    textView.text = "$label: $value"
    textView.setTextColor(currentTheme.chipText)
    val chipBackground = GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = 8f * resources.displayMetrics.density
      setColor(color)
    }
    textView.background = chipBackground
  }

  private fun setStatusBarVisible(visible: Boolean, persist: Boolean = true) {
    statusBarContainer.visibility = if (visible) View.VISIBLE else View.GONE
    if (!persist) {
      return
    }
    saveStatusBarVisiblePreference(visible)
  }

  private fun setSettingsExpanded(expanded: Boolean, persist: Boolean = true) {
    settingsSection.visibility = if (expanded) View.VISIBLE else View.GONE
    settingsToggleButton.text = if (expanded) "Hide Settings" else "Show Settings"
    if (expanded) {
      refreshMicOptionsFromCurrentSelection()
    }
    if (!persist) {
      return
    }

    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    prefs.edit().putBoolean(settingsExpandedPrefsKey, expanded).apply()
  }

  private fun loadSettingsExpandedPreference(): Boolean {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    return prefs.getBoolean(settingsExpandedPrefsKey, false)
  }

  private fun saveServiceEnabledPreference(enabled: Boolean) {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    prefs.edit().putBoolean(serviceEnabledPrefsKey, enabled).apply()
  }

  private fun loadServiceEnabledPreference(): Boolean {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    return prefs.getBoolean(serviceEnabledPrefsKey, true)
  }

  private fun saveStatusBarVisiblePreference(visible: Boolean) {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    prefs.edit().putBoolean(statusBarVisiblePrefsKey, visible).apply()
  }

  private fun loadStatusBarVisiblePreference(): Boolean {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    return prefs.getBoolean(statusBarVisiblePrefsKey, true)
  }

  private fun saveAttachmentPreviewZoomPreference(zoomSp: Float) {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    prefs.edit().putFloat(attachmentPreviewZoomSpPrefsKey, zoomSp.coerceIn(6f, 28f)).apply()
  }

  private fun loadAttachmentPreviewZoomPreference(): Float {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    return prefs.getFloat(attachmentPreviewZoomSpPrefsKey, 13f).coerceIn(6f, 28f)
  }

  private fun saveSessionFilterSelection(filterSessionId: String) {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    prefs.edit()
      .putString(sessionFilterSessionIdPrefsKey, SessionFilterUtils.normalizeFilterId(filterSessionId))
      .apply()
  }

  private fun loadSessionFilterSelection(): String {
    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    return SessionFilterUtils.normalizeFilterId(
      prefs.getString(sessionFilterSessionIdPrefsKey, SessionFilterUtils.GLOBAL_FILTER_ID),
    )
  }

  private fun parseBubbleAttachment(raw: Any?): BubbleAttachment? {
    val attachment = raw as? JSONObject ?: return null
    val dataBase64 = attachment.optString("dataBase64", "").trim()
    if (dataBase64.isEmpty()) {
      return null
    }
    val fileName = attachment.optString("fileName", "").trim()
    val contentType = AttachmentContentTypeResolver.resolveContentType(
      fileName = fileName,
      contentType = attachment.optString("contentType", "").trim(),
    )
    val previewMode = resolveAttachmentPreviewMode(
      fileName = fileName,
      contentType = contentType,
    )
    val decodedBytes = decodeAttachmentDataBase64(dataBase64)
    if (decodedBytes == null) {
      return BubbleAttachment(
        dataBase64 = dataBase64,
        decodedBytes = null,
        previewText = null,
        fileName = fileName,
        contentType = contentType,
        previewMode = previewMode,
        decodeState = ATTACHMENT_DECODE_STATE_INVALID_BASE64,
      )
    }
    val previewText = if (previewMode == "markdown" || previewMode == "text") {
      decodeAttachmentPreviewText(decodedBytes)
    } else {
      null
    }
    val decodeState = if (
      (previewMode == "markdown" || previewMode == "text") &&
      previewText == null
    ) {
      ATTACHMENT_DECODE_STATE_PREVIEW_UNAVAILABLE
    } else {
      ATTACHMENT_DECODE_STATE_OK
    }
    return BubbleAttachment(
      dataBase64 = dataBase64,
      decodedBytes = decodedBytes,
      previewText = previewText,
      fileName = fileName,
      contentType = contentType,
      previewMode = previewMode,
      decodeState = decodeState,
    )
  }

  private fun parseBubbleQuickReplies(raw: Any?): List<BubbleQuickReply> {
    val array = raw as? JSONArray ?: return emptyList()
    val replies = mutableListOf<BubbleQuickReply>()
    for (index in 0 until array.length()) {
      val item = array.optJSONObject(index) ?: continue
      val label = item.optString("label", "").trim()
      val text = item.optString("text", "").trim()
      if (label.isEmpty() || text.isEmpty()) {
        continue
      }
      replies.add(
        BubbleQuickReply(
          id = item.optString("id", "").trim(),
          label = label,
          text = text,
          defaultResume = item.optBoolean("defaultResume", false),
        ),
      )
    }
    return replies
  }

  private fun classifyBubble(message: String): BubbleRenderModel {
    if (message.startsWith("{")) {
      val parsed = try {
        JSONObject(message)
      } catch (_: JSONException) {
        null
      }
      if (parsed != null && parsed.optString("kind", "") == "bubble") {
        val role = when (parsed.optString("role", "").lowercase()) {
          "assistant" -> "assistant"
          "user" -> "user"
          else -> "system"
        }
        val body = parsed.optString("body", "").trim()
        val noWait = parsed.optBoolean("noWait", false)
        val turnId = parsed.optString("turnId", "").trim()
        val linkedSessionId = parsed.optString("linkedSessionId", "").trim()
        val linkedSessionTitle = parsed.optString("linkedSessionTitle", "").trim()
        val attachment = parseBubbleAttachment(parsed.opt("attachment"))
        val quickReplies = parseBubbleQuickReplies(parsed.opt("quickReplies"))
        return BubbleRenderModel(
          role = role,
          body = body,
          noWait = noWait,
          turnId = turnId,
          linkedSessionId = linkedSessionId,
          linkedSessionTitle = linkedSessionTitle,
          attachment = attachment,
          quickReplies = quickReplies,
        )
      }
    }

    return when {
      message.startsWith("Assistant: ", ignoreCase = false) ->
        BubbleRenderModel(
          role = "assistant",
          body = message.removePrefix("Assistant: ").trim(),
          noWait = false,
          turnId = "",
          linkedSessionId = "",
          linkedSessionTitle = "",
          attachment = null,
          quickReplies = emptyList(),
        )
      message.startsWith("User: ", ignoreCase = false) ->
        BubbleRenderModel(
          role = "user",
          body = message.removePrefix("User: ").trim(),
          noWait = false,
          turnId = "",
          linkedSessionId = "",
          linkedSessionTitle = "",
          attachment = null,
          quickReplies = emptyList(),
        )
      message.startsWith("System: ", ignoreCase = false) ->
        BubbleRenderModel(
          role = "system",
          body = message.removePrefix("System: ").trim(),
          noWait = false,
          turnId = "",
          linkedSessionId = "",
          linkedSessionTitle = "",
          attachment = null,
          quickReplies = emptyList(),
        )
      else ->
        BubbleRenderModel(
          role = "system",
          body = message,
          noWait = false,
          turnId = "",
          linkedSessionId = "",
          linkedSessionTitle = "",
          attachment = null,
          quickReplies = emptyList(),
        )
    }
  }

  private fun requestRuntimePermissionsIfNeeded() {
    val permissions = mutableListOf<String>()

    if (
      ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.RECORD_AUDIO,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      permissions += Manifest.permission.RECORD_AUDIO
    }

    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.POST_NOTIFICATIONS,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      permissions += Manifest.permission.POST_NOTIFICATIONS
    }

    if (permissions.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, permissions.toTypedArray(), 1001)
    }
  }

  private fun maybePromptBatteryOptimizationExemption() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      return
    }
    if (isIgnoringBatteryOptimizations()) {
      return
    }

    val prefs = getSharedPreferences(prefsFileName, Context.MODE_PRIVATE)
    if (prefs.getBoolean(batteryPromptPrefsKey, false)) {
      return
    }

    requestIgnoreBatteryOptimizations()
    prefs.edit().putBoolean(batteryPromptPrefsKey, true).apply()
  }

  private fun isIgnoringBatteryOptimizations(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      return true
    }
    val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return powerManager.isIgnoringBatteryOptimizations(packageName)
  }

  private fun requestIgnoreBatteryOptimizations(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      return false
    }
    if (isIgnoringBatteryOptimizations()) {
      return false
    }

    val intent = Intent(
      Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
      Uri.parse("package:$packageName"),
    )

    return runCatching {
      startActivity(intent)
      true
    }.getOrDefault(false)
  }

  private fun openApplicationBatterySettings() {
    val intents = listOf(
      Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
    )

    for (intent in intents) {
      val opened = runCatching {
        startActivity(intent)
        true
      }.getOrDefault(false)
      if (opened) {
        return
      }
    }
  }
}
