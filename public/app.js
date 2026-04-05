import {
  buildAttachmentPreview,
  buildInvalidAttachmentFileName,
  normalizeAttachment,
  sanitizeAttachmentFileName,
} from "./attachment-utils.js";
import { isCanceledReason, resolveCancellationMetadata } from "./cancellation-utils.js";
import { renderMarkdownToSafeHtml } from "./markdown-renderer.js";
import { shouldRecoverStaleListen } from "./reliability-utils.js";
import {
  SESSION_DISPATCH_VOICE_INSTRUCTION,
  buildSessionDispatchCustomMessage,
  filterSessionRows,
  formatWorkspaceAndTitle,
  normalizeSessionRows,
  workspaceLabel,
} from "./session-dispatch-utils.js";
import {
  canStartSessionVoiceCapture,
  createSessionVoiceCaptureRequestId,
  isSessionVoiceCaptureRequestId,
} from "./session-voice-utils.js";
import {
  isTextLikeContentType,
  renderCodeBlockHtml,
  resolveSyntaxLanguage,
} from "./syntax-highlight.js";
import { resolvePrimaryBubbleAction } from "./turn-action-utils.js";

class PcmStreamPlayer {
  constructor() {
    this.audioContext = null;
    this.nextPlaybackTime = 0;
    this.audioEnabled = false;
    this.speechEnabled = true;
    this.activeSources = new Set();
    this.lastDrainResult = { status: "done", reason: null };
    this.pendingDrainWaiters = new Set();
  }

  async enableAudio() {
    if (!this.audioContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("Web Audio API is not supported in this browser");
      }
      this.audioContext = new AudioContextCtor();
      this.nextPlaybackTime = this.audioContext.currentTime;
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.audioEnabled = true;
  }

  getOutputNode() {
    return this.audioContext?.destination ?? null;
  }

  setSpeechEnabled(enabled) {
    this.speechEnabled = Boolean(enabled);
    if (!this.speechEnabled) {
      this.stopAll("speech_disabled");
    }
  }

  hasPendingPlayback() {
    if (!this.audioContext) {
      return false;
    }

    const remaining = this.nextPlaybackTime - this.audioContext.currentTime;
    return this.activeSources.size > 0 || (Number.isFinite(remaining) && remaining > 0);
  }

  resolveDrainWaiters(status = "done", reason = null) {
    this.lastDrainResult = { status, reason };
    if (this.pendingDrainWaiters.size === 0) {
      return;
    }

    const waiters = [...this.pendingDrainWaiters];
    this.pendingDrainWaiters.clear();
    for (const resolve of waiters) {
      resolve({ status, reason });
    }
  }

  waitForDrain() {
    if (!this.hasPendingPlayback()) {
      return Promise.resolve({ ...this.lastDrainResult });
    }

    return new Promise((resolve) => {
      this.pendingDrainWaiters.add(resolve);
    });
  }

  stopAll(reason = null) {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Ignore stop errors.
      }
    }
    this.activeSources.clear();

    if (this.audioContext) {
      this.nextPlaybackTime = this.audioContext.currentTime;
    } else {
      this.nextPlaybackTime = 0;
    }
    this.resolveDrainWaiters("aborted", reason);
  }

  getPendingPlaybackMs() {
    if (!this.audioContext) {
      return 0;
    }

    const remaining = this.nextPlaybackTime - this.audioContext.currentTime;
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return 0;
    }

    return remaining * 1000;
  }

  playBase64Pcm(base64Chunk, sampleRate) {
    if (!this.audioEnabled || !this.audioContext || !this.speechEnabled) {
      return;
    }

    const byteString = atob(base64Chunk);
    const byteLength = byteString.length;

    if (byteLength < 2) {
      return;
    }

    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = byteString.charCodeAt(index);
    }

    const samples = new Float32Array(Math.floor(bytes.length / 2));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let index = 0; index < samples.length; index += 1) {
      const int16 = view.getInt16(index * 2, true);
      samples[index] = int16 / 32768;
    }

    const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    const outputNode = this.getOutputNode();
    if (!outputNode) {
      return;
    }
    source.connect(outputNode);

    const now = this.audioContext.currentTime;
    const startAt = Math.max(this.nextPlaybackTime, now + 0.02);
    this.lastDrainResult = { status: "done", reason: null };
    source.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (!this.audioContext) {
        return;
      }
      if (this.nextPlaybackTime < this.audioContext.currentTime) {
        this.nextPlaybackTime = this.audioContext.currentTime;
      }
      if (!this.hasPendingPlayback()) {
        this.resolveDrainWaiters("done", null);
      }
    };
  }

  playRecognitionCompletionChime(direction = "ascending") {
    if (!this.audioEnabled || !this.audioContext) {
      return;
    }

    const context = this.audioContext;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }

    const now = context.currentTime;
    const ascending = direction !== "descending";
    const tones = ascending
      ? [
          { frequency: 620, duration: 0.08 },
          { frequency: 740, duration: 0.08 },
          { frequency: 880, duration: 0.11 },
        ]
      : [
          { frequency: 880, duration: 0.08 },
          { frequency: 740, duration: 0.08 },
          { frequency: 620, duration: 0.11 },
        ];
    let cursor = now + 0.012;

    for (const tone of tones) {
      const gain = context.createGain();
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(tone.frequency, cursor);

      const attackEnd = cursor + 0.012;
      const endAt = cursor + tone.duration;

      gain.gain.setValueAtTime(0.0001, cursor);
      gain.gain.exponentialRampToValueAtTime(0.045, attackEnd);
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

      osc.connect(gain);
      const outputNode = this.getOutputNode();
      if (!outputNode) {
        return;
      }
      gain.connect(outputNode);
      osc.start(cursor);
      osc.stop(endAt + 0.01);
      cursor = endAt + 0.015;
    }
  }

  playWakeCommandBeep(stage = "start") {
    if (!this.audioEnabled || !this.audioContext) {
      return;
    }

    const context = this.audioContext;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }

    const gain = context.createGain();
    const osc = context.createOscillator();
    const now = context.currentTime;
    const startAt = now + 0.01;
    const endAt = startAt + 0.12;
    const frequency = stage === "end" ? 620 : 740;

    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    osc.connect(gain);
    const outputNode = this.getOutputNode();
    if (!outputNode) {
      return;
    }
    gain.connect(outputNode);
    osc.start(startAt);
    osc.stop(endAt + 0.005);
  }
}

class MicCaptureStreamer {
  constructor(options = {}) {
    this.stream = null;
    this.captureContext = null;
    this.activeSession = null;
    this.permissionGranted = false;
    this.holdStreamOpen = options.holdStreamOpen === true;
    this.selectedDeviceId = undefined;
  }

  async acquireStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser");
    }

    const deviceId = this.selectedDeviceId;
    const constraints =
      typeof deviceId === "string" && deviceId.length > 0
        ? { audio: { deviceId: { exact: deviceId } } }
        : { audio: true };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      // If selected device is no longer available, gracefully fall back to default input.
      if (
        typeof deviceId === "string" &&
        deviceId.length > 0 &&
        (error?.name === "OverconstrainedError" || error?.name === "NotFoundError")
      ) {
        this.selectedDeviceId = undefined;
        return navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw error;
    }
  }

  releaseStream() {
    if (!this.stream) {
      return;
    }

    for (const track of this.stream.getTracks()) {
      track.stop();
    }
    this.stream = null;
  }

  async ensureCaptureContextReady() {
    if (!this.captureContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("Web Audio API is not supported in this browser");
      }
      this.captureContext = new AudioContextCtor();
    }

    if (this.captureContext.state === "suspended") {
      await this.captureContext.resume();
    }
  }

  async enable() {
    if (this.permissionGranted && (this.holdStreamOpen ? Boolean(this.stream) : true)) {
      return;
    }

    const stream = await this.acquireStream();
    this.permissionGranted = true;
    await this.ensureCaptureContextReady();

    if (this.holdStreamOpen) {
      this.stream = stream;
      return;
    }

    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  setHoldStreamOpen(enabled) {
    this.holdStreamOpen = enabled === true;
    if (!this.holdStreamOpen && !this.activeSession) {
      this.releaseStream();
    }
  }

  setPreferredDeviceId(deviceId) {
    const normalized = typeof deviceId === "string" && deviceId.length > 0 ? deviceId : undefined;
    const changed = normalized !== this.selectedDeviceId;
    this.selectedDeviceId = normalized;

    if (changed && !this.activeSession) {
      this.releaseStream();
    }
  }

  async listAudioInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  }

  async startSession(options) {
    if (!this.permissionGranted) {
      throw new Error("Microphone is not enabled");
    }

    if (this.activeSession) {
      throw new Error("Recognition capture is already active");
    }

    if (!this.stream) {
      this.stream = await this.acquireStream();
    }
    await this.ensureCaptureContextReady();

    const source = this.captureContext.createMediaStreamSource(this.stream);
    const processor = this.captureContext.createScriptProcessor(4096, 1, 1);
    const muteGain = this.captureContext.createGain();
    muteGain.gain.value = 0;

    const requestId = options.requestId;
    processor.onaudioprocess = (event) => {
      if (!this.activeSession || this.activeSession.requestId !== requestId) {
        return;
      }

      const channel = event.inputBuffer.getChannelData(0);
      const pcmBytes = float32ToPcm16Bytes(channel);
      if (pcmBytes.length === 0) {
        return;
      }

      options.onChunk(pcmBytes);
    };

    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(this.captureContext.destination);

    this.activeSession = {
      requestId,
      source,
      processor,
      muteGain,
      releaseStreamAfterStop: !this.holdStreamOpen,
      onStop: options.onStop,
    };

    return {
      sampleRate: this.captureContext.sampleRate,
      channels: 1,
      encoding: "pcm_s16le",
    };
  }

  stopSession(requestId) {
    if (!this.activeSession || this.activeSession.requestId !== requestId) {
      return false;
    }

    try {
      this.activeSession.source.disconnect();
    } catch {
      // no-op
    }
    try {
      this.activeSession.processor.disconnect();
    } catch {
      // no-op
    }
    try {
      this.activeSession.muteGain.disconnect();
    } catch {
      // no-op
    }

    const onStop = this.activeSession.onStop;
    const releaseStreamAfterStop = this.activeSession.releaseStreamAfterStop;
    this.activeSession = null;
    onStop?.();
    if (releaseStreamAfterStop) {
      this.releaseStream();
    }
    return true;
  }

  isActive(requestId) {
    return Boolean(this.activeSession && this.activeSession.requestId === requestId);
  }

  stopActiveSession() {
    if (!this.activeSession) {
      return null;
    }

    const requestId = this.activeSession.requestId;
    this.stopSession(requestId);
    return requestId;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

function float32ToPcm16Bytes(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    const value = clamped < 0 ? clamped * 32768 : clamped * 32767;
    view.setInt16(index * 2, Math.round(value), true);
  }

  return bytes;
}

const wsStatusEl = document.getElementById("ws-status");
const queueStatusEl = document.getElementById("queue-status");
const acceptingStatusEl = document.getElementById("accepting-status");
const speechStatusEl = document.getElementById("speech-status");
const recognitionStatusEl = document.getElementById("recognition-status");
const activationStatusEl = document.getElementById("activation-status");
const chatLogEl = document.getElementById("chat-log");
const enableAudioButton = document.getElementById("enable-audio");
const enableMicButton = document.getElementById("enable-mic");
const loopbackTestButton = document.getElementById("loopback-test");
const micDeviceSelect = document.getElementById("mic-device-select");
const speechToggleButton = document.getElementById("speech-toggle");
const serviceToggleButton = document.getElementById("service-toggle");
const activateToggleButton = document.getElementById("activate-toggle");
const themeToggleButton = document.getElementById("theme-toggle");
const wakeToggleButton = document.getElementById("wake-toggle");
const sessionDispatchOpenButton = document.getElementById("session-dispatch-open");
const sessionVoiceActiveButton = document.getElementById("session-voice-active");
const activeAgentLabelEl = document.getElementById("active-agent-label");
const sessionDispatchModalEl = document.getElementById("session-dispatch-modal");
const sessionDispatchCloseButton = document.getElementById("session-dispatch-close");
const sessionDispatchFilterInput = document.getElementById("session-dispatch-filter");
const sessionDispatchRefreshButton = document.getElementById("session-dispatch-refresh");
const sessionDispatchStatusEl = document.getElementById("session-dispatch-status");
const sessionDispatchListEl = document.getElementById("session-dispatch-list");
const sessionDispatchMessageInput = document.getElementById("session-dispatch-message");
const sessionDispatchMakeActiveButton = document.getElementById("session-dispatch-make-active");
const sessionDispatchSendButton = document.getElementById("session-dispatch-send");
const sessionFilterBarEl = document.getElementById("session-filter-bar");
const sidebarEl = document.querySelector(".sidebar");
const sidebarMenuToggleButton = document.getElementById("sidebar-menu-toggle");
const sidebarSectionsEl = document.getElementById("sidebar-sections");

const AMBIENT_WAKE_QUERY_VALUE = new URLSearchParams(window.location.search).get("ambientWake");
const AMBIENT_WAKE_STORAGE_KEY = "agent-voice-adapter-ambient-wake";
const MIC_DEVICE_STORAGE_KEY = "agent-voice-adapter-mic-device-id";
const ACTIVE_AGENT_TARGET_STORAGE_KEY = "agent-voice-adapter-active-agent-target";
const SESSION_FILTER_STORAGE_KEY = "agent-voice-adapter-session-filter";
const THEME_STORAGE_KEY = "agent-voice-adapter-theme";
const GLOBAL_SESSION_FILTER_ID = "";

function getInitialAmbientWakeEnabled() {
  if (AMBIENT_WAKE_QUERY_VALUE === "1" || AMBIENT_WAKE_QUERY_VALUE === "true") {
    return true;
  }
  if (AMBIENT_WAKE_QUERY_VALUE === "0" || AMBIENT_WAKE_QUERY_VALUE === "false") {
    return false;
  }

  try {
    const stored = window.localStorage.getItem(AMBIENT_WAKE_STORAGE_KEY);
    return stored === "1";
  } catch {
    return false;
  }
}

function getInitialMicDeviceId() {
  try {
    const stored = window.localStorage.getItem(MIC_DEVICE_STORAGE_KEY);
    return typeof stored === "string" ? stored : "";
  } catch {
    return "";
  }
}

function getInitialSessionFilterId() {
  try {
    const stored = window.localStorage.getItem(SESSION_FILTER_STORAGE_KEY);
    return typeof stored === "string" ? stored.trim() : "";
  } catch {
    return "";
  }
}

function persistSessionFilterId(filterId) {
  try {
    window.localStorage.setItem(SESSION_FILTER_STORAGE_KEY, filterId || "");
  } catch {
    // Ignore storage failures.
  }
}

function getInitialThemeMode() {
  if (document.documentElement.dataset.theme === "dark") {
    return "dark";
  }
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function persistThemeMode(themeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  } catch {
    // Ignore storage failures.
  }
}

function updateThemeToggleState() {
  if (!themeToggleButton) {
    return;
  }
  const dark = themeMode === "dark";
  themeToggleButton.textContent = dark ? "Theme: Dark" : "Theme: Light";
  themeToggleButton.setAttribute("aria-pressed", dark ? "true" : "false");
}

function applyThemeMode(nextThemeMode, options = {}) {
  themeMode = nextThemeMode === "dark" ? "dark" : "light";
  if (themeMode === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  if (options.persist !== false) {
    persistThemeMode(themeMode);
  }
  updateThemeToggleState();
}

function isCompactSidebarMode() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function setMobileSidebarOpen(open) {
  if (!sidebarEl || !sidebarMenuToggleButton || !sidebarSectionsEl) {
    return;
  }
  const nextOpen = Boolean(open) && isCompactSidebarMode();
  mobileSidebarState.open = nextOpen;
  sidebarEl.classList.toggle("mobile-open", nextOpen);
  sidebarMenuToggleButton.textContent = nextOpen ? "Close" : "Menu";
  sidebarMenuToggleButton.setAttribute("aria-expanded", nextOpen ? "true" : "false");
}

const player = new PcmStreamPlayer();
let ambientWakeEnabled = getInitialAmbientWakeEnabled();
const recorder = new MicCaptureStreamer({ holdStreamOpen: ambientWakeEnabled });
const bubbleByRequestId = new Map();
const pendingRecognitionRequestIds = new Set();
const AMBIENT_REQUEST_PREFIX = "ambient-";
const AMBIENT_RESTART_DELAY_MS = 220;
const WAKE_TRIGGER_REGEX = /\b(agent|assistant)\b/i;
const LOOPBACK_TEST_PROMPT_TEXT =
  "Loopback test. You should hear this assistant message, then speak your response after playback ends.";
const LOOPBACK_BUTTON_READY_TEXT = "Loopback Test";
const LOOPBACK_BUTTON_RUNNING_TEXT = "Loopback: Running...";

let speechEnabled = true;
let serviceEnabled = true;
let recognitionEnabled = false;
let wantActive = false;
let socket = null;
let loopbackTestInFlight = false;
let selectedMicDeviceId = getInitialMicDeviceId();
let themeMode = getInitialThemeMode();
const clientActivationState = {
  active: false,
  activeClientConnected: false,
  connectedClients: 0,
};
recorder.setPreferredDeviceId(selectedMicDeviceId);
const ambientRecognitionState = {
  activeRequestId: null,
  paused: false,
  restartTimer: null,
};
const sessionDispatchState = {
  loading: false,
  allRows: [],
  filteredRows: [],
  selectedSessionId: null,
  activeAgentTarget: null,
};
sessionDispatchState.activeAgentTarget = readActiveAgentTargetFromStorage();
const sessionFilterState = {
  selectedFilterId: getInitialSessionFilterId(),
};
const turnRuntimeState = {
  activeTurnId: null,
  phase: "idle",
  actionInFlight: false,
};
const recognitionWatchdogTimers = new Map();
const listenHealthState = {
  lastEventAtMs: 0,
  monitorTimer: null,
};
const bubbleActionMenuState = {
  menuEl: null,
  turnId: null,
};
const attachmentModalState = {
  overlayEl: null,
};
const mobileSidebarState = {
  open: false,
};
const modalScrollState = {
  lockCount: 0,
  scrollY: 0,
};
const sessionVoiceCaptureTargetByRequestId = new Map();
const BUBBLE_LONG_PRESS_DELAY_MS = 520;
const LISTEN_STALE_THRESHOLD_MS = 30000;
const LISTEN_HEALTH_MONITOR_INTERVAL_MS = 5000;
const RECOGNITION_WATCHDOG_TIMEOUT_MS = 90000;
const TURN_AUDIO_SUPPRESSION_TTL_MS = 5 * 60_000;
const TURN_AUDIO_SUPPRESSION_MAX_ENTRIES = 256;
const suppressedTurnAudioById = new Map();
const playedTurnAudioById = new Set();
const pendingPlaybackTerminalAckByTurnId = new Map();

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return value;
  }
}

function lockBackgroundScroll() {
  if (modalScrollState.lockCount === 0) {
    modalScrollState.scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add("modal-scroll-lock");
    document.body.style.top = `-${modalScrollState.scrollY}px`;
  }
  modalScrollState.lockCount += 1;
}

function unlockBackgroundScroll() {
  if (modalScrollState.lockCount === 0) {
    return;
  }
  modalScrollState.lockCount -= 1;
  if (modalScrollState.lockCount > 0) {
    return;
  }
  const restoreY = modalScrollState.scrollY;
  document.body.classList.remove("modal-scroll-lock");
  document.body.style.top = "";
  window.scrollTo(0, restoreY);
}

function resolveBubbleLinkedSessionTarget(payload) {
  const sessionId =
    typeof payload?.sessionId === "string" && payload.sessionId.trim().length > 0
      ? payload.sessionId.trim()
      : "";
  if (!sessionId) {
    return null;
  }

  const sessionTitle =
    typeof payload?.sessionTitle === "string" && payload.sessionTitle.trim().length > 0
      ? payload.sessionTitle.trim()
      : sessionId;

  return {
    sessionId,
    workspace: "",
    resolvedTitle: sessionTitle,
  };
}

function readActiveAgentTargetFromStorage() {
  try {
    const stored = window.localStorage.getItem(ACTIVE_AGENT_TARGET_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored);
    const sessionId =
      typeof parsed?.sessionId === "string" && parsed.sessionId.trim().length > 0
        ? parsed.sessionId.trim()
        : "";
    if (!sessionId) {
      return null;
    }
    const workspace = typeof parsed?.workspace === "string" ? parsed.workspace.trim() : "";
    const resolvedTitle =
      typeof parsed?.resolvedTitle === "string" && parsed.resolvedTitle.trim().length > 0
        ? parsed.resolvedTitle.trim()
        : sessionId;
    return {
      sessionId,
      workspace,
      resolvedTitle,
    };
  } catch {
    return null;
  }
}

function persistActiveAgentTarget(target) {
  try {
    if (!target) {
      window.localStorage.removeItem(ACTIVE_AGENT_TARGET_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      ACTIVE_AGENT_TARGET_STORAGE_KEY,
      JSON.stringify({
        sessionId: target.sessionId,
        workspace: target.workspace,
        resolvedTitle: target.resolvedTitle,
      }),
    );
  } catch {
    // Ignore storage failures.
  }
}

function updateActiveAgentLabel() {
  if (!activeAgentLabelEl) {
    return;
  }
  const target = sessionDispatchState.activeAgentTarget;
  if (!target) {
    activeAgentLabelEl.textContent = "Active agent: none";
    updateSessionVoiceActiveButtonState();
    return;
  }
  activeAgentLabelEl.textContent = `Active agent: ${formatWorkspaceAndTitle(target.workspace, target.resolvedTitle)}`;
  updateSessionVoiceActiveButtonState();
  renderSessionFilterTabs();
  applySessionFilter();
}

function isWsConnected() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function updateSessionVoiceActiveButtonState() {
  if (!sessionVoiceActiveButton) {
    return;
  }

  const target = sessionDispatchState.activeAgentTarget;
  const gate = canStartSessionVoiceCapture({
    wsConnected: isWsConnected(),
    serviceEnabled,
    recognitionEnabled,
    sessionId: target?.sessionId ?? "",
    activeTurnId: turnRuntimeState.activeTurnId ?? "",
    pendingRecognitionCount: pendingRecognitionRequestIds.size,
  });
  sessionVoiceActiveButton.disabled = !gate.ok;
  sessionVoiceActiveButton.title = gate.ok
    ? "Start voice capture for the active agent"
    : gate.reason;
  if (sessionDispatchModalEl && !sessionDispatchModalEl.classList.contains("hidden")) {
    renderSessionDispatchList();
  }
}

function setSessionDispatchStatus(text, isError = false) {
  if (!sessionDispatchStatusEl) {
    return;
  }
  sessionDispatchStatusEl.textContent = text;
  sessionDispatchStatusEl.style.color = isError ? "var(--danger)" : "";
}

function getSelectedSessionRow() {
  if (!sessionDispatchState.selectedSessionId) {
    return null;
  }
  return (
    sessionDispatchState.filteredRows.find(
      (row) => row.sessionId === sessionDispatchState.selectedSessionId,
    ) ??
    sessionDispatchState.allRows.find(
      (row) => row.sessionId === sessionDispatchState.selectedSessionId,
    ) ??
    null
  );
}

function setSessionDispatchLoading(loading) {
  sessionDispatchState.loading = loading;
  if (sessionDispatchRefreshButton) {
    sessionDispatchRefreshButton.disabled = loading;
  }
  if (sessionDispatchFilterInput) {
    sessionDispatchFilterInput.disabled = loading;
  }
  if (sessionDispatchMessageInput) {
    sessionDispatchMessageInput.disabled = loading;
  }
  updateSessionDispatchActionState();
}

function updateSessionDispatchActionState() {
  const selected = getSelectedSessionRow();
  const selectedAlreadyActive = Boolean(
    selected && sessionDispatchState.activeAgentTarget?.sessionId === selected.sessionId,
  );
  const hasSelectedSession = Boolean(selected);
  const customMessage = sessionDispatchMessageInput?.value?.trim() ?? "";
  const hasMessage = customMessage.length > 0;

  if (sessionDispatchMakeActiveButton) {
    const enabled = !sessionDispatchState.loading && hasSelectedSession && !selectedAlreadyActive;
    sessionDispatchMakeActiveButton.disabled = !enabled;
  }

  if (sessionDispatchSendButton) {
    const enabled = !sessionDispatchState.loading && hasSelectedSession && hasMessage;
    sessionDispatchSendButton.disabled = !enabled;
  }
}

function renderSessionDispatchList() {
  if (!sessionDispatchListEl) {
    return;
  }

  sessionDispatchListEl.textContent = "";

  if (sessionDispatchState.filteredRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-row";
    empty.textContent = "No active sessions match your filter.";
    sessionDispatchListEl.append(empty);
    return;
  }

  for (const row of sessionDispatchState.filteredRows) {
    const card = document.createElement("article");
    const isSelected = row.sessionId === sessionDispatchState.selectedSessionId;
    card.className = `session-row${isSelected ? " selected" : ""}`;

    const head = document.createElement("div");
    head.className = "session-row-head";

    const title = document.createElement("div");
    title.className = "session-row-title";
    title.textContent = row.resolvedTitle;

    const voiceButton = document.createElement("button");
    voiceButton.className = "session-row-voice";
    voiceButton.type = "button";
    voiceButton.textContent = "Voice";
    const voiceGate = canStartSessionVoiceCapture({
      wsConnected: isWsConnected(),
      serviceEnabled,
      recognitionEnabled,
      sessionId: row.sessionId,
      activeTurnId: turnRuntimeState.activeTurnId ?? "",
      pendingRecognitionCount: pendingRecognitionRequestIds.size,
    });
    voiceButton.disabled = !voiceGate.ok;
    voiceButton.title = voiceGate.ok
      ? `Voice send to ${formatWorkspaceAndTitle(row.workspace, row.resolvedTitle)}`
      : voiceGate.reason;
    voiceButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sessionDispatchState.selectedSessionId = row.sessionId;
      renderSessionDispatchList();
      updateSessionDispatchActionState();
      void startSessionVoiceCaptureForTarget(row, { closeModal: true });
    });

    head.append(title, voiceButton);

    const workspace = document.createElement("div");
    workspace.className = "session-row-workspace";
    workspace.textContent = `Workspace: ${workspaceLabel(row.workspace)}`;

    const meta = document.createElement("div");
    meta.className = "session-row-meta";
    const lastActivity = document.createElement("span");
    lastActivity.textContent = row.lastActivity
      ? `Last activity: ${formatTime(row.lastActivity)}`
      : "";

    const active = document.createElement("span");
    const isActiveTarget = sessionDispatchState.activeAgentTarget?.sessionId === row.sessionId;
    active.className = "session-row-active";
    active.textContent = isActiveTarget ? "Active agent" : "";

    meta.append(lastActivity, active);
    card.append(head, workspace, meta);
    card.addEventListener("click", () => {
      sessionDispatchState.selectedSessionId = row.sessionId;
      renderSessionDispatchList();
      updateSessionDispatchActionState();
    });
    sessionDispatchListEl.append(card);
  }
}

function applySessionDispatchFilter() {
  const query = sessionDispatchFilterInput?.value ?? "";
  sessionDispatchState.filteredRows = filterSessionRows(sessionDispatchState.allRows, query);
  if (
    sessionDispatchState.selectedSessionId &&
    !sessionDispatchState.allRows.some(
      (row) => row.sessionId === sessionDispatchState.selectedSessionId,
    )
  ) {
    sessionDispatchState.selectedSessionId = null;
  }
  renderSessionDispatchList();
  updateSessionDispatchActionState();
}

function reconcileActiveAgentTarget() {
  const target = sessionDispatchState.activeAgentTarget;
  if (!target) {
    return;
  }

  const matched = sessionDispatchState.allRows.find((row) => row.sessionId === target.sessionId);
  if (!matched) {
    return;
  }

  sessionDispatchState.activeAgentTarget = {
    sessionId: matched.sessionId,
    workspace: matched.workspace,
    resolvedTitle: matched.resolvedTitle,
  };
  persistActiveAgentTarget(sessionDispatchState.activeAgentTarget);
}

async function refreshSessionDispatchSessions() {
  setSessionDispatchLoading(true);
  setSessionDispatchStatus("Loading sessions...");

  try {
    const response = await fetch("/api/session-dispatch/sessions", {
      method: "GET",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    const rows = normalizeSessionRows(payload).filter((row) => row.isActive !== false);
    sessionDispatchState.allRows = rows;
    reconcileActiveAgentTarget();
    applySessionDispatchFilter();
    updateActiveAgentLabel();
    setSessionDispatchStatus(`Loaded ${rows.length} active sessions.`);
  } catch (error) {
    sessionDispatchState.allRows = [];
    sessionDispatchState.filteredRows = [];
    sessionDispatchState.selectedSessionId = null;
    renderSessionDispatchList();
    setSessionDispatchStatus(`Session list failed: ${String(error)}`, true);
  } finally {
    setSessionDispatchLoading(false);
  }
}

function closeSessionDispatchModal() {
  if (!sessionDispatchModalEl) {
    return;
  }
  if (sessionDispatchModalEl.classList.contains("hidden")) {
    return;
  }
  sessionDispatchModalEl.classList.add("hidden");
  unlockBackgroundScroll();
}

function openSessionDispatchModal() {
  if (!sessionDispatchModalEl) {
    return;
  }
  if (!sessionDispatchModalEl.classList.contains("hidden")) {
    return;
  }
  sessionDispatchModalEl.classList.remove("hidden");
  lockBackgroundScroll();
  applySessionDispatchFilter();
  if (sessionDispatchState.allRows.length === 0) {
    void refreshSessionDispatchSessions();
  }
}

function appendLocalUserBubble(text, sessionRow) {
  const bubble = document.createElement("article");
  bubble.className = "chat-bubble user";
  if (sessionRow?.sessionId) {
    bubble.dataset.sessionId = sessionRow.sessionId;
    bubble.dataset.sessionLabel = formatWorkspaceAndTitle(
      sessionRow.workspace,
      sessionRow.resolvedTitle,
    );
  }

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = `You ${formatTime(new Date().toISOString())}`;

  const body = document.createElement("div");
  body.className = "bubble-text";
  body.textContent = text;

  bubble.append(meta, body);
  if (sessionRow) {
    const session = document.createElement("div");
    session.className = "bubble-session";
    session.textContent = `Sent to ${formatWorkspaceAndTitle(sessionRow.workspace, sessionRow.resolvedTitle)}`;
    bubble.append(session);
  }
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  renderSessionFilterTabs();
  applySessionFilter();
}

function createSessionVoiceCaptureBubble(requestId, sessionRow) {
  const bubble = document.createElement("article");
  bubble.className = "chat-bubble pending";
  bubble.dataset.requestId = requestId;
  bubble.dataset.sessionId = sessionRow.sessionId;
  bubble.dataset.sessionLabel = formatWorkspaceAndTitle(
    sessionRow.workspace,
    sessionRow.resolvedTitle,
  );

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = `Voice capture ${formatTime(new Date().toISOString())} | target=${formatWorkspaceAndTitle(sessionRow.workspace, sessionRow.resolvedTitle)}`;

  const body = document.createElement("div");
  body.className = "bubble-text";
  body.textContent = "Listening for message to selected session...";

  const recognition = document.createElement("div");
  recognition.className = "bubble-recognition";
  recognition.textContent = "Recognition: waiting to capture microphone...";

  bubble.append(meta, body, recognition);
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  renderSessionFilterTabs();
  applySessionFilter();

  const entry = {
    bubble,
    meta,
    requestRecognition: true,
    recognitionModelId: undefined,
  };
  bubbleByRequestId.set(requestId, entry);
  bindBubbleTurnInteractions(entry, requestId);
}

async function sendSessionVoiceTranscript(requestId, payload) {
  const target = sessionVoiceCaptureTargetByRequestId.get(requestId);
  if (!target) {
    return false;
  }

  if (isRetryableRecognitionResult(payload)) {
    clearRecognitionWatchdog(requestId);
    recorder.stopSession(requestId);
    const retryText =
      payload.error === "no_usable_speech"
        ? "Recognition: no usable speech detected, listening again..."
        : "Recognition: no speech detected, listening again...";
    setRecognitionText(requestId, retryText);
    setActiveTurnState(requestId, "listen_handoff");
    void triggerRecognitionForRequest(requestId, undefined, {
      forceRestart: true,
    });
    return true;
  }

  teardownRecognition(requestId);

  if (!payload.success) {
    const cancellation = resolveCancellationMetadata(payload);
    if (cancellation.canceled) {
      forceLocalPlaybackCancel(
        requestId,
        `session_voice_result_${cancellation.cancelReason ?? "canceled"}`,
      );
      completeBubble({
        turnId: requestId,
        success: false,
        error: "canceled",
        canceled: true,
        ...(cancellation.cancelReason
          ? {
              cancelReason: cancellation.cancelReason,
            }
          : {}),
      });
      setRecognitionText(requestId, "Recognition: canceled");
    } else if (isNoUsableSpeechReason(payload.error)) {
      setBubbleAsNoResponse(requestId);
      setRecognitionText(requestId, "Recognition: no usable speech detected");
    } else if (isTimeoutReason(payload.error)) {
      setBubbleAsNoResponse(requestId);
      setRecognitionText(requestId, "Recognition: timed out");
    } else {
      completeBubble({
        turnId: requestId,
        success: false,
        error: payload.error || "unknown error",
      });
      setRecognitionText(
        requestId,
        `Recognition failed: ${payload.error || "unknown error"}`,
        true,
      );
    }
    sessionVoiceCaptureTargetByRequestId.delete(requestId);
    resumeAmbientRecognition();
    if (turnRuntimeState.activeTurnId === requestId) {
      setActiveTurnState(null, "idle");
    }
    updateSessionVoiceActiveButtonState();
    return true;
  }

  const transcript = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!transcript) {
    setBubbleAsNoResponse(requestId);
    setRecognitionText(requestId, "Recognition: empty transcript");
    sessionVoiceCaptureTargetByRequestId.delete(requestId);
    resumeAmbientRecognition();
    if (turnRuntimeState.activeTurnId === requestId) {
      setActiveTurnState(null, "idle");
    }
    updateSessionVoiceActiveButtonState();
    return true;
  }

  setRecognitionText(requestId, `Recognition result: ${transcript}`);
  const dispatchMessage = buildSessionDispatchCustomMessage(
    transcript,
    SESSION_DISPATCH_VOICE_INSTRUCTION,
  );
  setRecognitionText(
    requestId,
    `Recognition result: ${transcript}\nSending to ${formatWorkspaceAndTitle(target.workspace, target.resolvedTitle)}...`,
  );

  try {
    const result = await postJson("/api/session-dispatch/send", {
      sessionId: target.sessionId,
      mode: "custom",
      message: dispatchMessage,
    });
    appendLocalUserBubble(transcript, target);
    completeBubble({
      turnId: requestId,
      success: true,
    });
    setRecognitionText(requestId, `Voice dispatch sent (${result?.bytes ?? 0} bytes).`);
  } catch (error) {
    completeBubble({
      turnId: requestId,
      success: false,
      error: String(error),
    });
    setRecognitionText(requestId, `Voice dispatch failed: ${String(error)}`, true);
  } finally {
    sessionVoiceCaptureTargetByRequestId.delete(requestId);
    resumeAmbientRecognition();
    if (turnRuntimeState.activeTurnId === requestId) {
      setActiveTurnState(null, "idle");
    }
    updateSessionVoiceActiveButtonState();
  }

  return true;
}

async function startSessionVoiceCaptureForTarget(sessionRow, options = {}) {
  const target = sessionRow
    ? {
        sessionId: sessionRow.sessionId,
        workspace: sessionRow.workspace || "",
        resolvedTitle: sessionRow.resolvedTitle || sessionRow.sessionId,
      }
    : null;
  const gate = canStartSessionVoiceCapture({
    wsConnected: isWsConnected(),
    serviceEnabled,
    recognitionEnabled,
    sessionId: target?.sessionId ?? "",
    activeTurnId: turnRuntimeState.activeTurnId ?? "",
    pendingRecognitionCount: pendingRecognitionRequestIds.size,
  });
  if (!gate.ok) {
    setSessionDispatchStatus(gate.reason, true);
    return false;
  }

  const requestId = createSessionVoiceCaptureRequestId();
  sessionVoiceCaptureTargetByRequestId.set(requestId, target);
  createSessionVoiceCaptureBubble(requestId, target);
  setActiveTurnState(requestId, "listen_handoff");
  updateSessionVoiceActiveButtonState();
  if (options.closeModal) {
    closeSessionDispatchModal();
  }
  void triggerRecognitionForRequest(requestId, undefined);
  return true;
}

function setActiveAgentTargetFromSelection() {
  const selected = getSelectedSessionRow();
  if (!selected) {
    setSessionDispatchStatus("Select a session before setting active agent.", true);
    return;
  }
  if (sessionDispatchState.activeAgentTarget?.sessionId === selected.sessionId) {
    setSessionDispatchStatus("Selected session is already active.");
    updateSessionDispatchActionState();
    return;
  }
  sessionDispatchState.activeAgentTarget = {
    sessionId: selected.sessionId,
    workspace: selected.workspace,
    resolvedTitle: selected.resolvedTitle,
  };
  persistActiveAgentTarget(sessionDispatchState.activeAgentTarget);
  updateActiveAgentLabel();
  renderSessionDispatchList();
  updateSessionDispatchActionState();
  setSessionDispatchStatus(
    `Active agent set: ${formatWorkspaceAndTitle(selected.workspace, selected.resolvedTitle)}`,
  );
}

async function sendMessageToSelectedSession() {
  const selected = getSelectedSessionRow();
  if (!selected) {
    setSessionDispatchStatus("Select a session before sending.", true);
    return;
  }
  const rawMessage = sessionDispatchMessageInput?.value?.trim() ?? "";
  if (!rawMessage) {
    setSessionDispatchStatus("Enter a message before sending.", true);
    return;
  }
  const dispatchMessage = buildSessionDispatchCustomMessage(
    rawMessage,
    SESSION_DISPATCH_VOICE_INSTRUCTION,
  );
  if (!dispatchMessage) {
    setSessionDispatchStatus("Message is empty after trimming.", true);
    return;
  }

  setSessionDispatchLoading(true);
  setSessionDispatchStatus("Sending...");

  try {
    const payload = await postJson("/api/session-dispatch/send", {
      sessionId: selected.sessionId,
      mode: "custom",
      message: dispatchMessage,
    });
    appendLocalUserBubble(rawMessage, selected);
    setSessionDispatchStatus(`Sent (${payload?.bytes ?? 0} bytes).`);
    closeSessionDispatchModal();
  } catch (error) {
    setSessionDispatchStatus(`Send failed: ${String(error)}`, true);
  } finally {
    setSessionDispatchLoading(false);
  }
}

function handleGlobalEscapeKey(event) {
  if (event.key !== "Escape") {
    return;
  }
  if (mobileSidebarState.open) {
    setMobileSidebarOpen(false);
    event.preventDefault();
    return;
  }
  if (attachmentModalState.overlayEl) {
    closeAttachmentPreviewModal();
    event.preventDefault();
    return;
  }
  if (bubbleActionMenuState.menuEl) {
    removeBubbleActionMenu();
    event.preventDefault();
    return;
  }
  if (sessionDispatchModalEl && !sessionDispatchModalEl.classList.contains("hidden")) {
    closeSessionDispatchModal();
    event.preventDefault();
  }
}

function cleanupRuntime() {
  stopListenHealthMonitor();
  for (const requestId of pendingRecognitionRequestIds.values()) {
    clearRecognitionWatchdog(requestId);
  }
  for (const timer of recognitionWatchdogTimers.values()) {
    clearTimeout(timer);
  }
  recognitionWatchdogTimers.clear();
  removeBubbleActionMenu();
  closeAttachmentPreviewModal();
  sessionVoiceCaptureTargetByRequestId.clear();
  suppressedTurnAudioById.clear();
  playedTurnAudioById.clear();
  pendingPlaybackTerminalAckByTurnId.clear();
}

try {
  document.addEventListener("keydown", handleGlobalEscapeKey);
  window.addEventListener("beforeunload", cleanupRuntime);
  window.addEventListener("resize", () => {
    if (!isCompactSidebarMode()) {
      setMobileSidebarOpen(false);
    }
  });
} catch {
  // Non-browser environment guard.
}

function removeBubbleActionMenu() {
  if (bubbleActionMenuState.menuEl) {
    bubbleActionMenuState.menuEl.remove();
  }
  bubbleActionMenuState.menuEl = null;
  bubbleActionMenuState.turnId = null;
}

function setActiveTurnState(turnId, phase) {
  const previousTurnId = turnRuntimeState.activeTurnId;
  const previousInTurn = Boolean(previousTurnId);
  if (previousTurnId && previousTurnId !== turnId) {
    const previousEntry = bubbleByRequestId.get(previousTurnId);
    previousEntry?.bubble.classList.remove("active-turn");
  }

  turnRuntimeState.activeTurnId = typeof turnId === "string" && turnId.length > 0 ? turnId : null;
  turnRuntimeState.phase = turnRuntimeState.activeTurnId ? phase : "idle";
  const nextInTurn = Boolean(turnRuntimeState.activeTurnId);
  if (turnRuntimeState.phase === "listen") {
    listenHealthState.lastEventAtMs = Date.now();
  }

  if (!turnRuntimeState.activeTurnId) {
    removeBubbleActionMenu();
    updateSessionVoiceActiveButtonState();
    if (previousInTurn !== nextInTurn) {
      sendClientState();
    }
    return;
  }

  const nextEntry = bubbleByRequestId.get(turnRuntimeState.activeTurnId);
  if (nextEntry) {
    nextEntry.bubble.classList.add("active-turn");
  }

  if (
    bubbleActionMenuState.turnId &&
    bubbleActionMenuState.turnId !== turnRuntimeState.activeTurnId
  ) {
    removeBubbleActionMenu();
  }

  logRuntime("turn_state", {
    activeTurnId: turnRuntimeState.activeTurnId,
    phase: turnRuntimeState.phase,
  });
  updateSessionVoiceActiveButtonState();
  if (previousInTurn !== nextInTurn) {
    sendClientState();
  }
}

function logRuntime(event, details = {}) {
  // Browser-side runtime diagnostics for stuck-turn investigations.
  console.info(`[agent-voice-adapter:web] ${event}`, details);
}

function clearSuppressedTurnAudio(turnId) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    return;
  }
  suppressedTurnAudioById.delete(turnId);
}

function pruneSuppressedTurnAudio(nowMs = Date.now()) {
  if (suppressedTurnAudioById.size === 0) {
    return;
  }

  for (const [turnId, markedAtMs] of suppressedTurnAudioById.entries()) {
    if (!Number.isFinite(markedAtMs) || nowMs - markedAtMs >= TURN_AUDIO_SUPPRESSION_TTL_MS) {
      suppressedTurnAudioById.delete(turnId);
    }
  }

  const overflow = suppressedTurnAudioById.size - TURN_AUDIO_SUPPRESSION_MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }

  const evictionOrder = [...suppressedTurnAudioById.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, overflow)
    .map(([turnId]) => turnId);
  for (const turnId of evictionOrder) {
    suppressedTurnAudioById.delete(turnId);
  }
}

function forceLocalPlaybackCancel(turnId, reason) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    return false;
  }

  pruneSuppressedTurnAudio();
  const alreadySuppressed = suppressedTurnAudioById.has(turnId);
  suppressedTurnAudioById.set(turnId, Date.now());
  player.stopAll(reason);
  logRuntime("local_playback_cancel", {
    turnId,
    reason,
    duplicate: alreadySuppressed,
  });
  return !alreadySuppressed;
}

function sendTurnPlaybackTerminal(turnId, status, reason) {
  if (
    typeof turnId !== "string" ||
    turnId.length === 0 ||
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "turn_playback_terminal",
      turnId,
      status,
      ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    }),
  );
}

function maybeFinalizeNoListenTurn(turnId, fallbackStatus = "done", fallbackReason = null) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    return;
  }
  if (pendingPlaybackTerminalAckByTurnId.has(turnId)) {
    return;
  }

  const pendingAck = (async () => {
    const drainResult = playedTurnAudioById.has(turnId)
      ? await player.waitForDrain()
      : { status: fallbackStatus, reason: fallbackReason };
    const terminalStatus =
      drainResult.status === "aborted" || fallbackStatus === "aborted" ? "aborted" : "done";
    const terminalReason =
      terminalStatus === "aborted" ? (drainResult.reason ?? fallbackReason) : null;
    sendTurnPlaybackTerminal(turnId, terminalStatus, terminalReason);
  })().finally(() => {
    playedTurnAudioById.delete(turnId);
    pendingPlaybackTerminalAckByTurnId.delete(turnId);
    if (turnRuntimeState.activeTurnId === turnId) {
      clearRecognitionWatchdog(turnId);
      setActiveTurnState(null, "idle");
    }
  });

  pendingPlaybackTerminalAckByTurnId.set(turnId, pendingAck);
}

function isCurrentLocalTurn(turnId) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    return false;
  }

  return (
    turnRuntimeState.activeTurnId === turnId ||
    pendingRecognitionRequestIds.has(turnId) ||
    playedTurnAudioById.has(turnId) ||
    pendingPlaybackTerminalAckByTurnId.has(turnId)
  );
}

function clearRecognitionWatchdog(turnId) {
  const timer = recognitionWatchdogTimers.get(turnId);
  if (timer) {
    clearTimeout(timer);
    recognitionWatchdogTimers.delete(turnId);
  }
}

function teardownRecognition(turnId) {
  clearRecognitionWatchdog(turnId);
  pendingRecognitionRequestIds.delete(turnId);
  recorder.stopSession(turnId);
}

function startRecognitionWatchdog(turnId) {
  clearRecognitionWatchdog(turnId);
  const timeout = setTimeout(() => {
    recognitionWatchdogTimers.delete(turnId);
    void recoverStaleListenTurn(turnId, "watchdog_timeout");
  }, RECOGNITION_WATCHDOG_TIMEOUT_MS);
  recognitionWatchdogTimers.set(turnId, timeout);
}

async function recoverStaleListenTurn(turnId, reason) {
  if (!turnId) {
    return;
  }
  logRuntime("listen_recovery_begin", {
    turnId,
    reason,
    phase: turnRuntimeState.phase,
    pendingRecognitionCount: pendingRecognitionRequestIds.size,
  });

  teardownRecognition(turnId);

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "turn_listen_stream_end",
        turnId,
      }),
    );
  }

  setRecognitionText(turnId, `Recognition recovered locally (${reason}).`, true);
  await invokeTurnAction("cancel_turn", turnId);
  resumeAmbientRecognition();
  if (turnRuntimeState.activeTurnId === turnId) {
    setActiveTurnState(null, "idle");
  }
  logRuntime("listen_recovery_end", {
    turnId,
    reason,
    pendingRecognitionCount: pendingRecognitionRequestIds.size,
  });
}

function startListenHealthMonitor() {
  if (listenHealthState.monitorTimer !== null) {
    return;
  }
  listenHealthState.monitorTimer = setInterval(() => {
    const nowMs = Date.now();
    const activeTurnId = turnRuntimeState.activeTurnId;
    if (
      shouldRecoverStaleListen({
        activePhase: turnRuntimeState.phase,
        activeTurnId,
        lastListenEventAtMs: listenHealthState.lastEventAtMs,
        nowMs,
        staleThresholdMs: LISTEN_STALE_THRESHOLD_MS,
      })
    ) {
      void recoverStaleListenTurn(activeTurnId, "listen_stale_monitor");
    }
  }, LISTEN_HEALTH_MONITOR_INTERVAL_MS);
}

function stopListenHealthMonitor() {
  if (listenHealthState.monitorTimer !== null) {
    clearInterval(listenHealthState.monitorTimer);
    listenHealthState.monitorTimer = null;
  }
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function postTurnAction(path, turnId) {
  return postJson(path, { turnId });
}

function shouldAutoStartRecognitionForEntry(entry) {
  return (
    shouldHandleTurnRecognition() && entry?.requestRecognition && entry.quickReplySelected !== true
  );
}

function maybeStartRecognitionHandoff(turnId, entry) {
  if (!shouldAutoStartRecognitionForEntry(entry)) {
    return false;
  }
  void triggerRecognitionForRequest(turnId, entry.recognitionModelId);
  return true;
}

async function invokeTurnAction(actionType, turnId) {
  if (!turnId || turnRuntimeState.actionInFlight) {
    return;
  }
  turnRuntimeState.actionInFlight = true;
  removeBubbleActionMenu();

  try {
    if (actionType === "stop_tts") {
      forceLocalPlaybackCancel(turnId, "local_stop_tts");
      const result = await postTurnAction("/api/turn/stop-tts", turnId);
      const entry = bubbleByRequestId.get(turnId);
      if (!maybeStartRecognitionHandoff(turnId, entry)) {
        setRecognitionText(turnId, "Stop TTS requested...");
      } else if (result?.stoppedTts === false) {
        setRecognitionText(turnId, "Recognition: waiting to capture microphone...");
      }
      return;
    }
    if (actionType === "cancel_turn") {
      forceLocalPlaybackCancel(turnId, "local_cancel");
      clearRecognitionWatchdog(turnId);
      setRecognitionText(turnId, "Cancel requested...");
      await postTurnAction("/api/turn/cancel", turnId);
    }
  } catch (error) {
    setRecognitionText(turnId, `Action failed: ${String(error)}`, true);
  } finally {
    turnRuntimeState.actionInFlight = false;
  }
}

function openBubbleActionMenu(turnId, anchorEl) {
  removeBubbleActionMenu();
  if (!anchorEl) {
    return;
  }

  const menu = document.createElement("div");
  menu.className = "bubble-action-menu";

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "Stop TTS";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel turn";

  const phase = turnRuntimeState.activeTurnId === turnId ? turnRuntimeState.phase : "idle";
  stopButton.disabled = phase !== "tts";
  cancelButton.disabled = phase !== "listen";

  stopButton.addEventListener("click", () => {
    void invokeTurnAction("stop_tts", turnId);
  });
  cancelButton.addEventListener("click", () => {
    void invokeTurnAction("cancel_turn", turnId);
  });

  menu.append(stopButton, cancelButton);
  document.body.append(menu);

  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.left))}px`;
  menu.style.top = `${Math.max(8, rect.bottom + 6)}px`;
  bubbleActionMenuState.menuEl = menu;
  bubbleActionMenuState.turnId = turnId;

  const onOutsidePointerDown = (event) => {
    if (!menu.contains(event.target)) {
      document.removeEventListener("pointerdown", onOutsidePointerDown);
      removeBubbleActionMenu();
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutsidePointerDown);
  }, 0);
}

function bindBubbleTurnInteractions(entry, turnId) {
  let longPressTimer = null;
  let longPressTriggered = false;
  let suppressClickAfterPointerUp = false;

  const clearLongPressTimer = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const invokePrimaryBubbleAction = () => {
    if (turnRuntimeState.activeTurnId !== turnId) {
      return false;
    }
    const actionType = resolvePrimaryBubbleAction(turnRuntimeState.phase);
    if (!actionType) {
      return false;
    }
    void invokeTurnAction(actionType, turnId);
    return true;
  };

  entry.bubble.addEventListener("pointerdown", () => {
    longPressTriggered = false;
    suppressClickAfterPointerUp = false;
    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      openBubbleActionMenu(turnId, entry.bubble);
    }, BUBBLE_LONG_PRESS_DELAY_MS);
  });

  entry.bubble.addEventListener("pointerup", () => {
    clearLongPressTimer();
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }
    suppressClickAfterPointerUp = invokePrimaryBubbleAction();
  });

  entry.bubble.addEventListener("pointercancel", () => {
    clearLongPressTimer();
    suppressClickAfterPointerUp = false;
  });

  entry.bubble.addEventListener("click", () => {
    if (suppressClickAfterPointerUp) {
      suppressClickAfterPointerUp = false;
      return;
    }
    if (longPressTriggered) {
      longPressTriggered = false;
      return;
    }
    invokePrimaryBubbleAction();
  });
}

function isAmbientRequestId(requestId) {
  return typeof requestId === "string" && requestId.startsWith(AMBIENT_REQUEST_PREFIX);
}

function isTimeoutReason(value) {
  if (typeof value !== "string") {
    return false;
  }

  return value.toLowerCase().includes("timed out");
}

function isNoUsableSpeechReason(value) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.toLowerCase();
  return normalized === "no_usable_speech" || normalized.includes("no usable speech detected");
}

function isRetryableRecognitionResult(payload) {
  return Boolean(payload && payload.retryable === true);
}

function shouldPlayRecognitionCompletionChime(payload) {
  if (isRetryableRecognitionResult(payload)) {
    return false;
  }

  if (!payload || payload.success === true) {
    return true;
  }

  const cancellation = resolveCancellationMetadata(payload);
  return (
    cancellation.canceled || isTimeoutReason(payload.error) || isNoUsableSpeechReason(payload.error)
  );
}

function createAmbientRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return `${AMBIENT_REQUEST_PREFIX}${window.crypto.randomUUID()}`;
  }

  return `${AMBIENT_REQUEST_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clearAmbientRestartTimer() {
  if (ambientRecognitionState.restartTimer !== null) {
    clearTimeout(ambientRecognitionState.restartTimer);
    ambientRecognitionState.restartTimer = null;
  }
}

function scheduleAmbientRecognitionRestart(delayMs = AMBIENT_RESTART_DELAY_MS) {
  clearAmbientRestartTimer();
  ambientRecognitionState.restartTimer = setTimeout(() => {
    ambientRecognitionState.restartTimer = null;
    void maybeStartAmbientRecognition();
  }, delayMs);
}

function createAmbientTranscriptBubble(payload) {
  const transcript = typeof payload.text === "string" ? payload.text.trim() : "";
  if (transcript.length === 0) {
    return null;
  }

  const wakeTriggerMatch = WAKE_TRIGGER_REGEX.exec(transcript);
  const wakeMatch = Boolean(wakeTriggerMatch);
  const wakeTriggerWord = wakeTriggerMatch ? wakeTriggerMatch[1].toLowerCase() : null;
  const bubble = document.createElement("article");
  bubble.className = `chat-bubble ambient ${wakeMatch ? "wake-match" : "wake-miss"}`;

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = `Ambient transcript ${formatTime(new Date().toISOString())} | provider=${payload.providerId || "unknown"} | model=${payload.modelId || "unknown"}`;

  const text = document.createElement("div");
  text.className = "bubble-text";
  text.textContent = transcript;

  const wakeStatus = document.createElement("div");
  wakeStatus.className = `bubble-wake ${wakeMatch ? "wake-match-text" : "wake-miss-text"}`;
  wakeStatus.textContent = wakeMatch
    ? `Wake match: contains "${wakeTriggerWord}"`
    : 'Wake match: no "agent" or "assistant" detected';

  bubble.append(meta, text, wakeStatus);
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;

  return {
    wakeMatch,
    transcript,
  };
}

function createWakeIntentBubble(payload) {
  const bubble = document.createElement("article");
  bubble.className = "chat-bubble intent";

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = `Wake intent ${formatTime(new Date().toISOString())} | action=${payload.intent?.action || "unknown"} | confidence=${typeof payload.intent?.confidence === "number" ? payload.intent.confidence.toFixed(2) : "n/a"}`;

  const text = document.createElement("div");
  text.className = "bubble-text";

  if (payload.execution?.executed) {
    text.textContent = payload.execution.output || "(no output)";
  } else if (payload.execution?.error === "clarify") {
    text.textContent = `Clarify needed: ${payload.intent?.strippedText || "(empty)"}`;
  } else {
    text.textContent = payload.execution?.error || "Wake intent failed";
  }

  bubble.append(meta, text);
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

async function processWakeIntentTranscript(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    return;
  }

  const playWakeCues = WAKE_TRIGGER_REGEX.test(transcript);
  if (playWakeCues) {
    player.playWakeCommandBeep("start");
  }

  try {
    const response = await fetch("/api/wake-intent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: transcript,
      }),
    });

    if (!response.ok) {
      throw new Error(`wake intent request failed (${response.status})`);
    }

    const payload = await response.json();
    createWakeIntentBubble(payload);
  } catch (error) {
    createWakeIntentBubble({
      intent: { action: "clarify", confidence: 0, strippedText: transcript },
      execution: { executed: false, error: String(error) },
    });
  } finally {
    if (playWakeCues) {
      player.playWakeCommandBeep("end");
    }
  }
}

function closeAttachmentPreviewModal() {
  if (!attachmentModalState.overlayEl) {
    return;
  }
  attachmentModalState.overlayEl.remove();
  attachmentModalState.overlayEl = null;
  unlockBackgroundScroll();
}

function stopEventPropagation(event) {
  event.stopPropagation();
}

function suppressAttachmentBubbleClickThrough(section) {
  section.addEventListener("pointerdown", stopEventPropagation);
  section.addEventListener("pointerup", stopEventPropagation);
  section.addEventListener("pointercancel", stopEventPropagation);
  section.addEventListener("click", stopEventPropagation);
}

function buildAttachmentShowMoreButton(attachment, sessionTarget) {
  const showMoreButton = document.createElement("button");
  showMoreButton.type = "button";
  showMoreButton.className = "bubble-attachment-more";
  showMoreButton.textContent = "Show more";
  showMoreButton.addEventListener("click", () => {
    openAttachmentPreviewModal(attachment, sessionTarget);
  });
  return showMoreButton;
}

function maybeAppendMarkdownPreviewExpandControl(section, previewEl, attachment, sessionTarget) {
  if (!previewEl.classList.contains("bubble-attachment-preview-clamped")) {
    return;
  }

  const hasOverflow = previewEl.scrollHeight > previewEl.clientHeight + 1;
  if (hasOverflow) {
    section.append(buildAttachmentShowMoreButton(attachment, sessionTarget));
  } else {
    previewEl.classList.remove("bubble-attachment-preview-clamped");
  }
}

function renderNonMarkdownAttachmentText(targetEl, text, fileName, contentType) {
  const language = isTextLikeContentType(contentType) ? resolveSyntaxLanguage(fileName) : null;
  if (language) {
    targetEl.classList.add("attachment-syntax");
    targetEl.innerHTML = renderCodeBlockHtml(text, language);
    return true;
  }
  targetEl.textContent = text;
  return false;
}

function resolveAttachmentBlobType(attachment, fallback) {
  const normalized =
    typeof attachment.contentType === "string" ? attachment.contentType.trim() : "";
  return normalized || fallback;
}

function clickAttachmentObjectUrlAnchor(objectUrl, configureAnchor) {
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.style.display = "none";
  configureAnchor(anchor);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 60_000);
}

function openHtmlAttachmentInBrowser(attachment) {
  if (!(attachment.decodedBytes instanceof Uint8Array)) {
    return false;
  }
  const blob = new Blob([attachment.decodedBytes], {
    type: resolveAttachmentBlobType(attachment, "text/html;charset=utf-8"),
  });
  const objectUrl = URL.createObjectURL(blob);
  clickAttachmentObjectUrlAnchor(objectUrl, (anchor) => {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  });
  return true;
}

function downloadAttachmentFile(attachment) {
  if (!attachment.fileName || !(attachment.decodedBytes instanceof Uint8Array)) {
    return;
  }

  const blob = new Blob([attachment.decodedBytes], {
    type: resolveAttachmentBlobType(attachment, "application/octet-stream"),
  });
  const objectUrl = URL.createObjectURL(blob);
  clickAttachmentObjectUrlAnchor(objectUrl, (anchor) => {
    anchor.download = sanitizeAttachmentFileName(attachment.fileName);
    anchor.rel = "noopener noreferrer";
  });
}

function downloadInvalidAttachmentFile(attachment) {
  if (!attachment.fileName || attachment.decodeState !== "invalid_base64") {
    return;
  }

  const blob = new Blob([attachment.dataBase64], {
    type: "text/plain;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(blob);
  clickAttachmentObjectUrlAnchor(objectUrl, (anchor) => {
    anchor.download = buildInvalidAttachmentFileName(attachment.fileName);
    anchor.rel = "noopener noreferrer";
  });
}

function buildAttachmentActionRow(...buttons) {
  const row = document.createElement("div");
  row.className = "bubble-attachment-actions";
  for (const button of buttons) {
    if (button) {
      row.append(button);
    }
  }
  return row;
}

function buildAttachmentDownloadButton(attachment) {
  if (!attachment.fileName || !(attachment.decodedBytes instanceof Uint8Array)) {
    return null;
  }
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "bubble-attachment-download";
  downloadButton.textContent = "Download";
  downloadButton.addEventListener("click", () => {
    downloadAttachmentFile(attachment);
  });
  return downloadButton;
}

function buildInvalidAttachmentDownloadButton(attachment) {
  if (!attachment.fileName || attachment.decodeState !== "invalid_base64") {
    return null;
  }
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "bubble-attachment-download";
  downloadButton.textContent = "Download invalid file";
  downloadButton.addEventListener("click", () => {
    downloadInvalidAttachmentFile(attachment);
  });
  return downloadButton;
}

function openAttachmentPreviewModal(attachment, sessionTarget) {
  if (attachment.previewMode === "html") {
    openHtmlAttachmentInBrowser(attachment);
    return;
  }
  closeAttachmentPreviewModal();

  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Attachment preview");

  const card = document.createElement("div");
  card.className = "modal-card attachment-modal-card";

  const header = document.createElement("div");
  header.className = "modal-header";

  const title = document.createElement("h2");
  title.textContent = "Attachment";

  const headerActions = document.createElement("div");
  headerActions.className = "attachment-modal-header-actions";

  const voiceButton = document.createElement("button");
  voiceButton.type = "button";
  voiceButton.className = "attachment-modal-voice-button";
  voiceButton.textContent = "💬";
  const voiceGate = canStartSessionVoiceCapture({
    wsConnected: isWsConnected(),
    serviceEnabled,
    recognitionEnabled,
    sessionId: sessionTarget?.sessionId ?? "",
    activeTurnId: turnRuntimeState.activeTurnId ?? "",
    pendingRecognitionCount: pendingRecognitionRequestIds.size,
  });
  voiceButton.disabled = !voiceGate.ok;
  voiceButton.title = voiceGate.ok ? "Start voice capture for this session" : voiceGate.reason;
  voiceButton.addEventListener("click", () => {
    void startSessionVoiceCaptureForTarget(sessionTarget, { closeModal: false });
  });

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => {
    closeAttachmentPreviewModal();
  });

  headerActions.append(voiceButton, closeButton);
  header.append(title, headerActions);

  const meta = document.createElement("p");
  meta.className = "modal-status";
  const fileLabel = attachment.fileName || "inline";
  const typeLabel = attachment.contentType || "text/plain";
  meta.textContent = `${fileLabel} • ${typeLabel}`;

  const markdownAttachment = attachment.previewMode === "markdown";
  const textAttachment = attachment.previewMode === "text";
  const textPreviewAvailable = typeof attachment.text === "string";
  const body = document.createElement(markdownAttachment ? "div" : "pre");
  body.className = "attachment-modal-body";
  if (attachment.decodeState === "invalid_base64") {
    body.textContent = "Invalid attachment encoding.";
  } else if (attachment.decodeState === "preview_unavailable") {
    body.textContent = "Preview unavailable";
  } else if (markdownAttachment && textPreviewAvailable) {
    body.classList.add("attachment-modal-markdown");
    body.innerHTML = renderMarkdownToSafeHtml(attachment.text);
  } else if (textAttachment && textPreviewAvailable) {
    const usedSyntax = renderNonMarkdownAttachmentText(
      body,
      attachment.text,
      attachment.fileName,
      attachment.contentType,
    );
    if (usedSyntax) {
      body.classList.add("attachment-modal-syntax");
    }
  } else {
    body.textContent = "No preview available for this attachment type.";
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const copyButton =
    textPreviewAvailable && (markdownAttachment || textAttachment)
      ? document.createElement("button")
      : null;
  if (copyButton) {
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(attachment.text);
        copyButton.textContent = "Copied";
        setTimeout(() => {
          copyButton.textContent = "Copy";
        }, 1200);
      } catch {
        copyButton.textContent = "Copy failed";
        setTimeout(() => {
          copyButton.textContent = "Copy";
        }, 1200);
      }
    });
  }

  const downloadButton = buildAttachmentDownloadButton(attachment);
  const invalidDownloadButton = buildInvalidAttachmentDownloadButton(attachment);

  const closeActionButton = document.createElement("button");
  closeActionButton.type = "button";
  closeActionButton.textContent = "Close";
  closeActionButton.addEventListener("click", () => {
    closeAttachmentPreviewModal();
  });

  if (copyButton) {
    actions.append(copyButton);
  }
  if (downloadButton) {
    actions.append(downloadButton);
  }
  if (invalidDownloadButton) {
    actions.append(invalidDownloadButton);
  }
  actions.append(closeActionButton);
  card.append(header, meta, body, actions);

  overlay.append(card);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeAttachmentPreviewModal();
    }
  });

  document.body.append(overlay);
  attachmentModalState.overlayEl = overlay;
  lockBackgroundScroll();
}

function appendBubbleAttachmentSection(bubble, attachment, sessionTarget) {
  const fileLabel = attachment.fileName || "inline";
  const typeLabel = attachment.contentType || "text/plain";
  const htmlAttachment = attachment.previewMode === "html";
  const markdownAttachment = attachment.previewMode === "markdown";
  const textAttachment = attachment.previewMode === "text";
  const textPreviewAvailable = typeof attachment.text === "string";
  const downloadButton = buildAttachmentDownloadButton(attachment);
  const invalidDownloadButton = buildInvalidAttachmentDownloadButton(attachment);

  const section = document.createElement("section");
  section.className = "bubble-attachment";
  suppressAttachmentBubbleClickThrough(section);

  const meta = document.createElement("div");
  meta.className = "bubble-attachment-meta";
  meta.textContent = `Attachment • ${fileLabel} • ${typeLabel}`;

  if (attachment.decodeState === "invalid_base64") {
    const status = document.createElement("pre");
    status.className = "bubble-attachment-preview";
    status.textContent = "Invalid attachment encoding.";
    section.append(meta, status);
    if (invalidDownloadButton) {
      section.append(buildAttachmentActionRow(invalidDownloadButton));
    }
    bubble.append(section);
    return;
  }

  if (htmlAttachment) {
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "bubble-attachment-open";
    openButton.textContent = "Open in browser";
    openButton.addEventListener("click", () => {
      openHtmlAttachmentInBrowser(attachment);
    });
    if (downloadButton) {
      section.append(meta, buildAttachmentActionRow(openButton, downloadButton));
    } else {
      section.append(meta, openButton);
    }
    bubble.append(section);
    return;
  }

  if (attachment.decodeState === "preview_unavailable") {
    const status = document.createElement("pre");
    status.className = "bubble-attachment-preview";
    status.textContent = "Preview unavailable";
    section.append(meta, status);
    if (downloadButton) {
      section.append(buildAttachmentActionRow(downloadButton));
    }
    bubble.append(section);
    return;
  }

  if (!markdownAttachment && !textAttachment) {
    section.append(meta);
    if (downloadButton) {
      section.append(buildAttachmentActionRow(downloadButton));
    }
    bubble.append(section);
    return;
  }

  if (!textPreviewAvailable) {
    section.append(meta);
    if (downloadButton) {
      section.append(buildAttachmentActionRow(downloadButton));
    }
    bubble.append(section);
    return;
  }

  const previewEl = document.createElement(markdownAttachment ? "div" : "pre");
  previewEl.className = "bubble-attachment-preview";
  if (markdownAttachment) {
    previewEl.classList.add(
      "bubble-attachment-preview-markdown",
      "bubble-attachment-preview-clamped",
    );
    previewEl.innerHTML = renderMarkdownToSafeHtml(attachment.text);
  } else if (textAttachment) {
    const preview = buildAttachmentPreview(attachment.text);
    const usedSyntax = renderNonMarkdownAttachmentText(
      previewEl,
      preview.previewText,
      attachment.fileName,
      attachment.contentType,
    );
    if (usedSyntax) {
      previewEl.classList.add("bubble-attachment-preview-syntax");
    }
    if (preview.truncated) {
      previewEl.classList.add("truncated");
      section.append(meta, previewEl, buildAttachmentShowMoreButton(attachment, sessionTarget));
      if (downloadButton) {
        section.append(buildAttachmentActionRow(downloadButton));
      }
      bubble.append(section);
      return;
    }
  }
  section.append(meta, previewEl);
  if (downloadButton) {
    section.append(buildAttachmentActionRow(downloadButton));
  } else if (invalidDownloadButton) {
    section.append(buildAttachmentActionRow(invalidDownloadButton));
  }
  bubble.append(section);

  if (markdownAttachment) {
    requestAnimationFrame(() => {
      maybeAppendMarkdownPreviewExpandControl(section, previewEl, attachment, sessionTarget);
    });
  }
}

function normalizeQuickReplies(rawQuickReplies) {
  if (!Array.isArray(rawQuickReplies)) {
    return [];
  }
  const quickReplies = [];
  for (const item of rawQuickReplies) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!label || !text) {
      continue;
    }
    quickReplies.push({
      id: typeof item.id === "string" ? item.id.trim() : "",
      label,
      text,
      defaultResume: item.defaultResume === true,
    });
    if (quickReplies.length >= 8) {
      break;
    }
  }
  return quickReplies;
}

function setBubbleQuickReplyButtonsEnabled(bubble, enabled) {
  const buttons = bubble.querySelectorAll(".bubble-quick-reply-btn");
  for (const button of buttons) {
    button.disabled = !enabled;
  }
}

function appendBubbleQuickRepliesSection(bubble, turnId, quickReplies) {
  if (!Array.isArray(quickReplies) || quickReplies.length < 1) {
    return;
  }

  const section = document.createElement("div");
  section.className = "bubble-quick-replies";
  const hasSingleDefaultResume =
    quickReplies.length === 1 && quickReplies[0]?.defaultResume === true;
  if (hasSingleDefaultResume) {
    section.classList.add("bubble-quick-replies-default-resume");
  }

  for (const quickReply of quickReplies) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bubble-quick-reply-btn";
    button.textContent = quickReply.label;
    button.addEventListener("click", () => {
      const entry = bubbleByRequestId.get(turnId);
      const isActiveTurn = turnRuntimeState.activeTurnId === turnId;
      const allowInactiveQuickReply = entry?.persistQuickRepliesAfterTts === true;
      if (!isActiveTurn && !allowInactiveQuickReply) {
        setBubbleQuickReplyButtonsEnabled(bubble, false);
        return;
      }
      if (entry?.quickRepliesConsumed === true) {
        return;
      }
      if (entry) {
        // Prevent automatic mic capture start when quick reply is selected during TTS.
        entry.requestRecognition = false;
        entry.quickReplySelected = true;
        entry.quickRepliesConsumed = true;
      }
      setBubbleQuickReplyButtonsEnabled(bubble, false);
      if (isActiveTurn) {
        forceLocalPlaybackCancel(turnId, "quick_reply");
        void postTurnAction("/api/turn/stop-tts", turnId).catch(() => {});
        teardownRecognition(turnId);
      }

      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setRecognitionText(turnId, "Quick reply skipped: websocket is disconnected", true);
        if (entry) {
          entry.quickRepliesConsumed = false;
        }
        setBubbleQuickReplyButtonsEnabled(
          bubble,
          turnRuntimeState.activeTurnId === turnId || allowInactiveQuickReply,
        );
        return;
      }

      socket.send(
        JSON.stringify({
          type: "turn_listen_quick_reply",
          turnId,
          text: quickReply.text,
          ...(quickReply.id ? { quickReplyId: quickReply.id } : {}),
        }),
      );
      setRecognitionText(turnId, `Quick reply sent: "${quickReply.label}"`);
    });
    section.appendChild(button);
  }

  bubble.append(section);
}

function collectSessionFilterOptions() {
  const options = [
    {
      filterId: GLOBAL_SESSION_FILTER_ID,
      label: "Global",
    },
  ];
  const seen = new Set([GLOBAL_SESSION_FILTER_ID]);

  const activeTarget = sessionDispatchState.activeAgentTarget;
  if (activeTarget?.sessionId && !seen.has(activeTarget.sessionId)) {
    options.push({
      filterId: activeTarget.sessionId,
      label: formatWorkspaceAndTitle(activeTarget.workspace, activeTarget.resolvedTitle),
    });
    seen.add(activeTarget.sessionId);
  }

  for (const bubble of chatLogEl.querySelectorAll(".chat-bubble")) {
    const sessionId =
      typeof bubble.dataset.sessionId === "string" ? bubble.dataset.sessionId.trim() : "";
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    const label =
      typeof bubble.dataset.sessionLabel === "string" &&
      bubble.dataset.sessionLabel.trim().length > 0
        ? bubble.dataset.sessionLabel.trim()
        : sessionId;
    options.push({
      filterId: sessionId,
      label,
    });
    seen.add(sessionId);
  }

  return options;
}

function applySessionFilter(filterId = sessionFilterState.selectedFilterId) {
  const normalizedFilterId = typeof filterId === "string" ? filterId.trim() : "";
  sessionFilterState.selectedFilterId = normalizedFilterId;
  persistSessionFilterId(normalizedFilterId);

  for (const bubble of chatLogEl.querySelectorAll(".chat-bubble")) {
    const bubbleSessionId =
      typeof bubble.dataset.sessionId === "string" ? bubble.dataset.sessionId.trim() : "";
    bubble.hidden = Boolean(normalizedFilterId) && bubbleSessionId !== normalizedFilterId;
  }

  if (!sessionFilterBarEl) {
    return;
  }
  for (const chip of sessionFilterBarEl.querySelectorAll(".session-filter-chip")) {
    chip.classList.toggle("active", chip.dataset.filterId === normalizedFilterId);
  }
}

function renderSessionFilterTabs() {
  if (!sessionFilterBarEl) {
    return;
  }

  const options = collectSessionFilterOptions();
  const optionIds = new Set(options.map((option) => option.filterId));
  if (!optionIds.has(sessionFilterState.selectedFilterId)) {
    sessionFilterState.selectedFilterId = GLOBAL_SESSION_FILTER_ID;
    persistSessionFilterId(sessionFilterState.selectedFilterId);
  }

  sessionFilterBarEl.replaceChildren();
  for (const option of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "session-filter-chip";
    chip.dataset.filterId = option.filterId;
    chip.textContent = option.label;
    chip.classList.toggle("active", option.filterId === sessionFilterState.selectedFilterId);
    chip.addEventListener("click", () => {
      applySessionFilter(option.filterId);
    });
    sessionFilterBarEl.append(chip);
  }
}

function createBubble(payload) {
  const turnId = payload.turnId;
  if (typeof turnId !== "string" || turnId.length === 0) {
    return;
  }
  clearSuppressedTurnAudio(turnId);

  const bubble = document.createElement("article");
  bubble.className = "chat-bubble pending";
  bubble.dataset.requestId = turnId;

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const provider = payload.providerId || "unknown";
  const model = payload.modelId || "default";
  const voice = payload.voiceId || "default";
  meta.textContent = `Queued ${formatTime(payload.createdAt)} | provider=${provider} | model=${model} | voice=${voice}`;

  const text = document.createElement("div");
  text.className = "bubble-text";
  text.textContent = payload.originalText;

  bubble.append(meta, text);

  const linkedSessionTarget = resolveBubbleLinkedSessionTarget(payload);
  if (linkedSessionTarget) {
    bubble.dataset.sessionId = linkedSessionTarget.sessionId;
    bubble.dataset.sessionLabel = formatWorkspaceAndTitle(
      linkedSessionTarget.workspace,
      linkedSessionTarget.resolvedTitle,
    );
  }
  const attachment = normalizeAttachment(payload.attachment);
  if (attachment) {
    appendBubbleAttachmentSection(bubble, attachment, linkedSessionTarget);
  }
  const quickReplies = normalizeQuickReplies(payload.quickReplies);
  if (quickReplies.length > 0) {
    appendBubbleQuickRepliesSection(bubble, turnId, quickReplies);
  }

  if (payload.textChangedBySanitizer && payload.sanitizedText !== payload.originalText) {
    const sanitized = document.createElement("div");
    sanitized.className = "bubble-sanitized";
    sanitized.textContent = `Sanitized for speech: ${payload.sanitizedText}`;
    bubble.append(sanitized);
  }

  if (payload.listenRequested) {
    const recognition = document.createElement("div");
    recognition.className = "bubble-recognition";
    recognition.textContent = "Recognition requested";
    bubble.append(recognition);
  }

  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  renderSessionFilterTabs();
  applySessionFilter();

  const entry = {
    bubble,
    meta,
    requestRecognition: payload.listenRequested === true,
    quickReplySelected: false,
    persistQuickRepliesAfterTts: payload.listenRequested !== true && quickReplies.length > 0,
    quickRepliesConsumed: false,
    recognitionModelId:
      typeof payload.listenModelId === "string" && payload.listenModelId.length > 0
        ? payload.listenModelId
        : undefined,
  };
  bubbleByRequestId.set(turnId, entry);
  bindBubbleTurnInteractions(entry, turnId);
  if (shouldHandleTurnSpeech()) {
    setActiveTurnState(turnId, "tts");
  }
}

function ensureRecognitionBlock(entry) {
  const existing = entry.bubble.querySelector(".bubble-recognition");
  if (existing) {
    return existing;
  }

  const recognition = document.createElement("div");
  recognition.className = "bubble-recognition";
  entry.bubble.append(recognition);
  return recognition;
}

function setRecognitionText(requestId, text, isError = false) {
  const entry = bubbleByRequestId.get(requestId);
  if (!entry) {
    return;
  }

  const node = ensureRecognitionBlock(entry);
  node.textContent = text;
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function completeBubble(payload) {
  const turnId = payload.turnId;
  const entry = bubbleByRequestId.get(turnId);
  if (!entry) {
    return;
  }

  const applyBubbleState = (className, statusText, errorText) => {
    entry.bubble.classList.remove("pending", "success", "error", "canceled");
    entry.bubble.classList.add(className);
    const keepQuickRepliesEnabled =
      className === "success" &&
      entry.persistQuickRepliesAfterTts === true &&
      entry.quickRepliesConsumed !== true;
    setBubbleQuickReplyButtonsEnabled(entry.bubble, keepQuickRepliesEnabled);
    const baseMeta = (entry.meta.textContent || "").replace(
      /\s\|\s(?:done|failed|canceled|no response)$/,
      "",
    );
    entry.meta.textContent = `${baseMeta} | ${statusText}`;

    const existingErrors = entry.bubble.querySelectorAll(".bubble-error");
    for (const node of existingErrors) {
      node.remove();
    }

    if (className === "error" && typeof errorText === "string" && errorText.length > 0) {
      const error = document.createElement("div");
      error.className = "bubble-error";
      error.textContent = errorText;
      entry.bubble.append(error);
    }
  };

  if (payload.success) {
    applyBubbleState("success", "done");
    return;
  }

  const cancellation = resolveCancellationMetadata(payload);
  if (cancellation.canceled) {
    applyBubbleState("canceled", "canceled");
    return;
  }

  applyBubbleState("error", "failed", payload.error);
}

function setBubbleAsNoResponse(requestId) {
  const entry = bubbleByRequestId.get(requestId);
  if (!entry) {
    return;
  }

  entry.bubble.classList.remove("pending", "success", "error", "canceled");
  entry.bubble.classList.add("canceled");
  setBubbleQuickReplyButtonsEnabled(entry.bubble, false);

  const baseMeta = (entry.meta.textContent || "").replace(
    /\s\|\s(?:done|failed|canceled|no response)$/,
    "",
  );
  entry.meta.textContent = `${baseMeta} | no response`;

  const existingErrors = entry.bubble.querySelectorAll(".bubble-error");
  for (const node of existingErrors) {
    node.remove();
  }
}

function setSpeechButtonState() {
  speechToggleButton.textContent = speechEnabled ? "Speech: ON" : "Speech: OFF";
  speechToggleButton.setAttribute("aria-pressed", speechEnabled ? "true" : "false");
  speechStatusEl.textContent = speechEnabled ? "on" : "off";
}

function setServiceButtonState() {
  serviceToggleButton.textContent = serviceEnabled ? "Service: ON" : "Service: OFF";
  serviceToggleButton.setAttribute("aria-pressed", serviceEnabled ? "true" : "false");
  updateSessionVoiceActiveButtonState();
}

function setRecognitionUiState() {
  recognitionStatusEl.textContent = recognitionEnabled ? "ready" : "off";
  updateSessionVoiceActiveButtonState();
}

function setActivationUiState() {
  if (!activateToggleButton || !activationStatusEl) {
    return;
  }

  const wsReady = Boolean(socket && socket.readyState === WebSocket.OPEN);
  if (!wsReady) {
    activateToggleButton.textContent = "Activate";
    activateToggleButton.disabled = true;
    activateToggleButton.setAttribute("aria-pressed", "false");
    activationStatusEl.textContent = "disconnected";
  } else if (clientActivationState.active) {
    activateToggleButton.textContent = "Deactivate";
    activateToggleButton.disabled = false;
    activateToggleButton.setAttribute("aria-pressed", "true");
    activationStatusEl.textContent = "this device";
  } else {
    activateToggleButton.textContent = "Activate";
    activateToggleButton.disabled = false;
    activateToggleButton.setAttribute("aria-pressed", "false");
    activationStatusEl.textContent = clientActivationState.activeClientConnected
      ? "other device"
      : "none";
  }
  updateSessionVoiceActiveButtonState();
}

function shouldHandleTurnSpeech() {
  return clientActivationState.active && speechEnabled;
}

function shouldHandleTurnRecognition() {
  return clientActivationState.active && speechEnabled && recognitionEnabled;
}

function setWakeButtonState() {
  if (!wakeToggleButton) {
    return;
  }

  wakeToggleButton.textContent = ambientWakeEnabled ? "Wake: ON" : "Wake: OFF";
  wakeToggleButton.setAttribute("aria-pressed", ambientWakeEnabled ? "true" : "false");
}

function persistAmbientWakePreference() {
  try {
    window.localStorage.setItem(AMBIENT_WAKE_STORAGE_KEY, ambientWakeEnabled ? "1" : "0");
  } catch {
    // Ignore storage failures.
  }
}

function setMicSelectEnabled(enabled) {
  if (!micDeviceSelect) {
    return;
  }
  micDeviceSelect.disabled = !enabled;
}

function setLoopbackButtonState() {
  if (!loopbackTestButton) {
    return;
  }

  loopbackTestButton.disabled = loopbackTestInFlight;
  loopbackTestButton.textContent = loopbackTestInFlight
    ? LOOPBACK_BUTTON_RUNNING_TEXT
    : LOOPBACK_BUTTON_READY_TEXT;
}

async function submitLoopbackTestTurn() {
  if (loopbackTestInFlight) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (loopbackTestButton) {
      loopbackTestButton.textContent = "Loopback: WS Offline";
      setTimeout(() => {
        setLoopbackButtonState();
      }, 1500);
    }
    return;
  }

  if (!serviceEnabled) {
    if (loopbackTestButton) {
      loopbackTestButton.textContent = "Loopback: Service OFF";
      setTimeout(() => {
        setLoopbackButtonState();
      }, 1500);
    }
    return;
  }

  if (!recognitionEnabled) {
    if (loopbackTestButton) {
      loopbackTestButton.textContent = "Loopback: Enable Mic";
      setTimeout(() => {
        setLoopbackButtonState();
      }, 1800);
    }
    return;
  }

  loopbackTestInFlight = true;
  setLoopbackButtonState();
  let shouldDeferReset = false;

  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: LOOPBACK_TEST_PROMPT_TEXT,
        listen: true,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`loopback request failed (${response.status}): ${bodyText}`);
    }
  } catch (error) {
    console.error("Loopback test request failed", error);
    if (loopbackTestButton) {
      shouldDeferReset = true;
      loopbackTestButton.textContent = "Loopback: Request Error";
      setTimeout(() => {
        setLoopbackButtonState();
      }, 1800);
    }
  } finally {
    loopbackTestInFlight = false;
    if (!shouldDeferReset) {
      setLoopbackButtonState();
    }
  }
}

function persistMicDevicePreference(deviceId) {
  try {
    window.localStorage.setItem(MIC_DEVICE_STORAGE_KEY, deviceId || "");
  } catch {
    // Ignore storage failures.
  }
}

function buildMicOptionLabel(device, index) {
  const raw = typeof device.label === "string" ? device.label.trim() : "";
  if (raw.length > 0) {
    return raw;
  }
  return `Microphone ${index + 1}`;
}

async function refreshMicDeviceOptions() {
  if (!micDeviceSelect) {
    return;
  }

  const devices = await recorder.listAudioInputDevices();
  const currentValue = selectedMicDeviceId;

  while (micDeviceSelect.options.length > 0) {
    micDeviceSelect.remove(0);
  }

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Mic: default";
  micDeviceSelect.append(defaultOption);

  for (let index = 0; index < devices.length; index += 1) {
    const device = devices[index];
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = buildMicOptionLabel(device, index);
    micDeviceSelect.append(option);
  }

  const hasCurrent = devices.some((device) => device.deviceId === currentValue);
  selectedMicDeviceId = hasCurrent ? currentValue : "";
  micDeviceSelect.value = selectedMicDeviceId;
  persistMicDevicePreference(selectedMicDeviceId);
  recorder.setPreferredDeviceId(selectedMicDeviceId);
}

function sendClientState() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "client_state_update",
      acceptingTurns: serviceEnabled,
      speechEnabled,
      listeningEnabled: recognitionEnabled,
      inTurn: Boolean(turnRuntimeState.activeTurnId),
      turnModeEnabled: true,
      directTtsEnabled: false,
      directSttEnabled: false,
    }),
  );
}

function pauseAmbientRecognition() {
  if (!ambientWakeEnabled) {
    return;
  }

  ambientRecognitionState.paused = true;
  clearAmbientRestartTimer();

  if (ambientRecognitionState.activeRequestId) {
    recorder.stopSession(ambientRecognitionState.activeRequestId);
  }
}

function resumeAmbientRecognition() {
  if (!ambientWakeEnabled) {
    return;
  }

  ambientRecognitionState.paused = false;
  scheduleAmbientRecognitionRestart(80);
}

async function maybeStartAmbientRecognition() {
  if (!ambientWakeEnabled) {
    return;
  }

  if (!recognitionEnabled) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (ambientRecognitionState.paused) {
    return;
  }

  if (ambientRecognitionState.activeRequestId) {
    return;
  }

  if (pendingRecognitionRequestIds.size > 0) {
    return;
  }

  const requestId = createAmbientRequestId();
  ambientRecognitionState.activeRequestId = requestId;

  try {
    const streamFormat = await recorder.startSession({
      requestId,
      onChunk: (pcmBytes) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            type: "turn_listen_stream_chunk",
            turnId: requestId,
            chunkBase64: bytesToBase64(pcmBytes),
          }),
        );
      },
      onStop: () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            type: "turn_listen_stream_end",
            turnId: requestId,
          }),
        );
      },
    });

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      recorder.stopSession(requestId);
      ambientRecognitionState.activeRequestId = null;
      return;
    }

    socket.send(
      JSON.stringify({
        type: "turn_listen_stream_start",
        turnId: requestId,
        sampleRate: streamFormat.sampleRate,
        channels: streamFormat.channels,
        encoding: streamFormat.encoding,
      }),
    );
  } catch {
    if (ambientRecognitionState.activeRequestId === requestId) {
      ambientRecognitionState.activeRequestId = null;
    }
    scheduleAmbientRecognitionRestart();
  }
}

async function triggerRecognitionForRequest(requestId, recognitionModelId, options = {}) {
  const forceRestart = options.forceRestart === true;

  if (pendingRecognitionRequestIds.has(requestId) && !forceRestart) {
    return;
  }

  if (!recognitionEnabled) {
    setRecognitionText(requestId, "Recognition skipped: microphone is not enabled", true);
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setRecognitionText(requestId, "Recognition skipped: websocket is disconnected", true);
    return;
  }

  if (!pendingRecognitionRequestIds.has(requestId)) {
    pendingRecognitionRequestIds.add(requestId);
  }
  setActiveTurnState(requestId, "listen_handoff");
  listenHealthState.lastEventAtMs = Date.now();
  pauseAmbientRecognition();
  setRecognitionText(requestId, "Recognition: waiting to capture microphone...");

  await player.waitForDrain();
  if (!pendingRecognitionRequestIds.has(requestId)) {
    return;
  }

  try {
    recorder.stopActiveSession();
    setRecognitionText(requestId, "Recognition: starting stream...");
    const streamFormat = await recorder.startSession({
      requestId,
      onChunk: (pcmBytes) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            type: "turn_listen_stream_chunk",
            turnId: requestId,
            chunkBase64: bytesToBase64(pcmBytes),
          }),
        );
      },
      onStop: () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            type: "turn_listen_stream_end",
            turnId: requestId,
          }),
        );
      },
    });

    if (!pendingRecognitionRequestIds.has(requestId)) {
      recorder.stopSession(requestId);
      return;
    }

    socket.send(
      JSON.stringify({
        type: "turn_listen_stream_start",
        turnId: requestId,
        sampleRate: streamFormat.sampleRate,
        channels: streamFormat.channels,
        encoding: streamFormat.encoding,
        modelId: recognitionModelId,
      }),
    );

    setActiveTurnState(requestId, "listen");
    setRecognitionText(requestId, "Recognition: listening...");
    listenHealthState.lastEventAtMs = Date.now();
    startRecognitionWatchdog(requestId);
  } catch (error) {
    teardownRecognition(requestId);
    const message = String(error);
    if (isCanceledReason(message) || message.toLowerCase().includes("already active")) {
      setRecognitionText(requestId, "Recognition: canceled");
    } else {
      setRecognitionText(requestId, `Recognition capture failed: ${message}`, true);
    }
    resumeAmbientRecognition();
    if (turnRuntimeState.activeTurnId === requestId) {
      setActiveTurnState(null, "idle");
    }
  }
}

renderSessionFilterTabs();
applySessionFilter();
applyThemeMode(themeMode, { persist: false });
setMobileSidebarOpen(false);

enableAudioButton.addEventListener("click", async () => {
  try {
    await player.enableAudio();
    enableAudioButton.textContent = "Audio Ready";
    enableAudioButton.disabled = true;
  } catch (error) {
    enableAudioButton.textContent = `Audio Error: ${String(error)}`;
  }
});

enableMicButton.addEventListener("click", async () => {
  try {
    await recorder.enable();
    await refreshMicDeviceOptions();
    setMicSelectEnabled(true);
    recognitionEnabled = true;
    setRecognitionUiState();
    sendClientState();
    void maybeStartAmbientRecognition();
    enableMicButton.textContent = ambientWakeEnabled ? "Mic Ready (wake on)" : "Mic Ready";
    enableMicButton.disabled = true;
  } catch (error) {
    enableMicButton.textContent = `Mic Error: ${String(error)}`;
  }
});

if (loopbackTestButton) {
  loopbackTestButton.addEventListener("click", () => {
    void submitLoopbackTestTurn();
  });
}

speechToggleButton.addEventListener("click", () => {
  speechEnabled = !speechEnabled;
  player.setSpeechEnabled(speechEnabled);
  setSpeechButtonState();
  sendClientState();
});

serviceToggleButton.addEventListener("click", () => {
  serviceEnabled = !serviceEnabled;
  setServiceButtonState();
  sendClientState();
});

if (themeToggleButton) {
  themeToggleButton.addEventListener("click", () => {
    applyThemeMode(themeMode === "dark" ? "light" : "dark");
  });
}

if (sidebarMenuToggleButton) {
  sidebarMenuToggleButton.addEventListener("click", () => {
    setMobileSidebarOpen(!mobileSidebarState.open);
  });
}

if (activateToggleButton) {
  activateToggleButton.addEventListener("click", () => {
    const activate = !clientActivationState.active;
    wantActive = activate;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: activate ? "client_activate" : "client_deactivate",
      }),
    );
  });
}

if (micDeviceSelect) {
  micDeviceSelect.addEventListener("change", () => {
    selectedMicDeviceId = micDeviceSelect.value || "";
    recorder.setPreferredDeviceId(selectedMicDeviceId);
    persistMicDevicePreference(selectedMicDeviceId);
  });
}

if (wakeToggleButton) {
  wakeToggleButton.addEventListener("click", () => {
    ambientWakeEnabled = !ambientWakeEnabled;
    recorder.setHoldStreamOpen(ambientWakeEnabled);
    persistAmbientWakePreference();
    setWakeButtonState();

    if (!ambientWakeEnabled) {
      clearAmbientRestartTimer();
      if (ambientRecognitionState.activeRequestId) {
        recorder.stopSession(ambientRecognitionState.activeRequestId);
      }
      ambientRecognitionState.activeRequestId = null;
      ambientRecognitionState.paused = false;
      return;
    }

    if (recognitionEnabled) {
      void maybeStartAmbientRecognition();
    }
  });
}

if (sessionDispatchOpenButton) {
  sessionDispatchOpenButton.addEventListener("click", () => {
    openSessionDispatchModal();
  });
}

if (sessionVoiceActiveButton) {
  sessionVoiceActiveButton.addEventListener("click", () => {
    const target = sessionDispatchState.activeAgentTarget;
    void startSessionVoiceCaptureForTarget(target, { closeModal: false });
  });
}

if (sessionDispatchCloseButton) {
  sessionDispatchCloseButton.addEventListener("click", () => {
    closeSessionDispatchModal();
  });
}

if (sessionDispatchModalEl) {
  sessionDispatchModalEl.addEventListener("click", (event) => {
    if (event.target === sessionDispatchModalEl) {
      closeSessionDispatchModal();
    }
  });
}

if (sessionDispatchRefreshButton) {
  sessionDispatchRefreshButton.addEventListener("click", () => {
    void refreshSessionDispatchSessions();
  });
}

if (sessionDispatchFilterInput) {
  sessionDispatchFilterInput.addEventListener("input", () => {
    applySessionDispatchFilter();
  });
}

if (sessionDispatchMessageInput) {
  sessionDispatchMessageInput.addEventListener("input", () => {
    updateSessionDispatchActionState();
  });
}

if (sessionDispatchMakeActiveButton) {
  sessionDispatchMakeActiveButton.addEventListener("click", () => {
    setActiveAgentTargetFromSelection();
  });
}

if (sessionDispatchSendButton) {
  sessionDispatchSendButton.addEventListener("click", () => {
    void sendMessageToSelectedSession();
  });
}

function createWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    logRuntime("ws_open");
    wsStatusEl.textContent = "connected";
    sendClientState();
    if (wantActive) {
      socket.send(
        JSON.stringify({
          type: "client_activate",
        }),
      );
    }
    void maybeStartAmbientRecognition();
    setActivationUiState();
  });

  socket.addEventListener("close", () => {
    logRuntime("ws_close");
    wsStatusEl.textContent = "disconnected";
    acceptingStatusEl.textContent = "-";
    clientActivationState.active = false;
    clientActivationState.activeClientConnected = false;
    clientActivationState.connectedClients = 0;
    setActivationUiState();
    pauseAmbientRecognition();
    ambientRecognitionState.activeRequestId = null;
    ambientRecognitionState.paused = false;
    clearAmbientRestartTimer();
    for (const requestId of pendingRecognitionRequestIds.values()) {
      teardownRecognition(requestId);
    }
    sessionVoiceCaptureTargetByRequestId.clear();
    suppressedTurnAudioById.clear();
    setActiveTurnState(null, "idle");
    setTimeout(createWebSocket, 1000);
  });

  socket.addEventListener("message", (event) => {
    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (payload.type) {
      case "server_state": {
        queueStatusEl.textContent = `${payload.queueLength} queued`;
        acceptingStatusEl.textContent = `${payload.acceptingTurnClients}/${payload.connectedClients} (listen:${payload.listeningEnabledClients})`;
        if (typeof payload.activeClientConnected === "boolean") {
          clientActivationState.activeClientConnected = payload.activeClientConnected;
          if (!payload.activeClientConnected) {
            clientActivationState.active = false;
          }
          if (typeof payload.connectedClients === "number") {
            clientActivationState.connectedClients = payload.connectedClients;
          }
          setActivationUiState();
        }
        break;
      }
      case "client_activation_state": {
        const wasActive = clientActivationState.active;
        clientActivationState.active = payload.active === true;
        clientActivationState.activeClientConnected = payload.activeClientConnected === true;
        clientActivationState.connectedClients =
          typeof payload.connectedClients === "number" ? payload.connectedClients : 0;
        if (
          !clientActivationState.active &&
          (wasActive || clientActivationState.activeClientConnected)
        ) {
          wantActive = false;
        }
        setActivationUiState();
        break;
      }
      case "turn_start": {
        createBubble(payload);
        break;
      }
      case "turn_audio_chunk": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
        if (turnId) {
          pruneSuppressedTurnAudio();
          if (suppressedTurnAudioById.has(turnId)) {
            logRuntime("turn_audio_chunk_dropped", { turnId, reason: "suppressed_after_cancel" });
            break;
          }
        }
        const shouldHandleLocalTurn = clientActivationState.active || isCurrentLocalTurn(turnId);
        if (!shouldHandleLocalTurn) {
          if (turnId) {
            logRuntime("turn_audio_chunk_dropped", { turnId, reason: "inactive_client" });
          }
          break;
        }
        if (speechEnabled) {
          player.playBase64Pcm(payload.chunkBase64, payload.sampleRate);
          if (turnId) {
            playedTurnAudioById.add(turnId);
          }
        } else if (turnId) {
          logRuntime("turn_audio_chunk_dropped", { turnId, reason: "speech_disabled" });
        }
        if (turnId && speechEnabled) {
          setActiveTurnState(turnId, "tts");
        }
        break;
      }
      case "turn_tts_end": {
        completeBubble(payload);
        const turnId = payload.turnId;
        if (typeof turnId !== "string") {
          break;
        }
        const localTurnActive = isCurrentLocalTurn(turnId);
        const canHandleTurnTerminal = clientActivationState.active || localTurnActive;
        if (!canHandleTurnTerminal) {
          break;
        }
        const cancellation = resolveCancellationMetadata(payload);
        const entry = bubbleByRequestId.get(turnId);
        const shouldStartRecognition =
          canHandleTurnTerminal && shouldAutoStartRecognitionForEntry(entry);
        const shouldAckPlaybackTerminal =
          canHandleTurnTerminal && speechEnabled && !shouldStartRecognition;
        if (!payload.success && cancellation.canceled) {
          forceLocalPlaybackCancel(
            turnId,
            `turn_tts_end_${cancellation.cancelReason ?? "canceled"}`,
          );
        }
        if (payload.success) {
          if (shouldStartRecognition) {
            playedTurnAudioById.delete(turnId);
            maybeStartRecognitionHandoff(turnId, entry);
          } else if (shouldAckPlaybackTerminal) {
            maybeFinalizeNoListenTurn(turnId);
          } else if (turnRuntimeState.activeTurnId === turnId) {
            playedTurnAudioById.delete(turnId);
            clearRecognitionWatchdog(turnId);
            setActiveTurnState(null, "idle");
          }
        } else if (cancellation.canceled) {
          teardownRecognition(turnId);
          setRecognitionText(turnId, "Recognition: canceled");
          resumeAmbientRecognition();
          if (shouldAckPlaybackTerminal) {
            maybeFinalizeNoListenTurn(
              turnId,
              "aborted",
              cancellation.cancelReason ?? "turn_canceled",
            );
          } else if (turnRuntimeState.activeTurnId === turnId) {
            playedTurnAudioById.delete(turnId);
            setActiveTurnState(null, "idle");
          }
        } else if (turnRuntimeState.activeTurnId === turnId) {
          playedTurnAudioById.delete(turnId);
          clearRecognitionWatchdog(turnId);
          setActiveTurnState(null, "idle");
        }
        break;
      }
      case "turn_listen_start": {
        const turnId = payload.turnId;
        if (typeof turnId !== "string" || isAmbientRequestId(turnId)) {
          break;
        }
        listenHealthState.lastEventAtMs = Date.now();
        setActiveTurnState(turnId, "listen");
        setRecognitionText(
          turnId,
          `Recognition: transcribing with ${payload.providerId}/${payload.modelId}...`,
        );
        break;
      }
      case "turn_listen_stop": {
        const turnId = payload.turnId;
        if (typeof turnId !== "string") {
          break;
        }
        listenHealthState.lastEventAtMs = Date.now();
        recorder.stopSession(turnId);
        if (isAmbientRequestId(turnId)) {
          break;
        }
        if (payload.reason === "silence") {
          setRecognitionText(turnId, "Recognition: detected end of speech...");
        } else if (payload.reason === "max_duration") {
          setRecognitionText(turnId, "Recognition: max capture window reached...");
        }
        break;
      }
      case "turn_listen_result": {
        const turnId = payload.turnId;
        if (typeof turnId !== "string") {
          break;
        }
        const cancellation = resolveCancellationMetadata(payload);
        if (isAmbientRequestId(turnId)) {
          recorder.stopSession(turnId);

          if (ambientRecognitionState.activeRequestId === turnId) {
            ambientRecognitionState.activeRequestId = null;
          }

          if (!ambientWakeEnabled) {
            break;
          }

          if (payload.success) {
            const ambient = createAmbientTranscriptBubble(payload);
            if (ambient?.wakeMatch) {
              void processWakeIntentTranscript(ambient.transcript);
            }
          }

          if (!ambientRecognitionState.paused) {
            scheduleAmbientRecognitionRestart();
          }
          break;
        }

        if (isSessionVoiceCaptureRequestId(turnId)) {
          void sendSessionVoiceTranscript(turnId, payload);
          break;
        }

        if (isRetryableRecognitionResult(payload)) {
          clearRecognitionWatchdog(turnId);
          recorder.stopSession(turnId);
          const entry = bubbleByRequestId.get(turnId);
          const retryText =
            payload.error === "no_usable_speech"
              ? "Recognition: no usable speech detected, listening again..."
              : "Recognition: no speech detected, listening again...";
          setRecognitionText(turnId, retryText);
          setActiveTurnState(turnId, "listen_handoff");
          void triggerRecognitionForRequest(turnId, entry?.recognitionModelId, {
            forceRestart: true,
          });
          break;
        }

        teardownRecognition(turnId);
        if (cancellation.canceled) {
          forceLocalPlaybackCancel(
            turnId,
            `turn_listen_result_${cancellation.cancelReason ?? "canceled"}`,
          );
        }
        if (payload.success) {
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          const rendered = text.length > 0 ? text : "(empty transcript)";
          setRecognitionText(turnId, `Recognition result: ${rendered}`);
        } else {
          if (cancellation.canceled) {
            completeBubble({
              turnId,
              success: false,
              error: "canceled",
              canceled: true,
              ...(cancellation.cancelReason
                ? {
                    cancelReason: cancellation.cancelReason,
                  }
                : {}),
            });
            setRecognitionText(turnId, "Recognition: canceled");
          } else if (isNoUsableSpeechReason(payload.error)) {
            setBubbleAsNoResponse(turnId);
            setRecognitionText(turnId, "Recognition: no usable speech detected");
          } else if (isTimeoutReason(payload.error)) {
            setBubbleAsNoResponse(turnId);
            setRecognitionText(turnId, "Recognition: timed out");
          } else {
            setRecognitionText(
              turnId,
              `Recognition failed: ${payload.error || "unknown error"}`,
              true,
            );
          }
        }

        if (shouldPlayRecognitionCompletionChime(payload)) {
          const chimeDirection = payload.success ? "ascending" : "descending";
          player.playRecognitionCompletionChime(chimeDirection);
        }
        resumeAmbientRecognition();
        if (turnRuntimeState.activeTurnId === turnId) {
          setActiveTurnState(null, "idle");
        }
        break;
      }
      default:
        break;
    }
  });
}

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    if (recognitionEnabled) {
      void refreshMicDeviceOptions();
    }
  });
}

setSpeechButtonState();
setServiceButtonState();
setRecognitionUiState();
setActivationUiState();
setWakeButtonState();
setMicSelectEnabled(false);
setLoopbackButtonState();
updateActiveAgentLabel();
applySessionDispatchFilter();
setSessionDispatchStatus("Ready.");
startListenHealthMonitor();
createWebSocket();
