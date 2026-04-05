import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";

import express from "express";
import { WebSocket, WebSocketServer } from "ws";

import { createAsrProvider } from "./asrProvider";
import {
  type VoiceClientState,
  getAcceptingClientCount,
  getAudioEnabledAcceptingClientCount,
  getDirectSttEnabledClientCount,
  getDirectTtsEnabledClientCount,
  getRecognitionEnabledAcceptingClientCount,
  getVoiceClientCapabilities,
} from "./clientState";
import type { AppConfig } from "./config";
import { shutdownKokoroDaemonProcesses } from "./kokoroLocalDaemonClient";
import {
  applyLinkedSessionPrefixToTurnText,
  formatLinkedSessionPrefixLabel,
} from "./linkedSessionTtsPrefix";
import { shutdownParakeetDaemonProcesses } from "./parakeetLocalDaemonClient";
import { dequeueNext, removeByRequestId } from "./queueUtils";
import { sanitizeTtsText } from "./sanitizeText";
import { createSessionDispatchService } from "./sessionDispatch";
import { type StreamingTtsClient, createStreamingTtsClient } from "./ttsProvider";
import { resolveWakeIntentRequest } from "./wakeIntentRequest";
import {
  type ClientPingInboundMessage,
  type MediaSttChunkInboundMessage,
  type MediaSttEndInboundMessage,
  type MediaSttStartInboundMessage,
  type TurnListenBlobInboundMessage,
  type TurnListenQuickReplyInboundMessage,
  type TurnListenStreamChunkInboundMessage,
  type TurnListenStreamEndInboundMessage,
  type TurnListenStreamStartInboundMessage,
  isClientActivateMessage,
  isClientDeactivateMessage,
  isClientPingMessage,
  isClientStateUpdateMessage,
  isMediaSttCancelMessage,
  isMediaSttChunkMessage,
  isMediaSttEndMessage,
  isMediaSttStartMessage,
  isTurnListenBlobMessage,
  isTurnListenQuickReplyMessage,
  isTurnListenStreamChunkMessage,
  isTurnListenStreamEndMessage,
  isTurnListenStreamStartMessage,
  isTurnPlaybackTerminalMessage,
  parseInboundClientMessage,
} from "./wsInboundProtocol";

interface SpeakJob {
  requestId: string;
  createdAt: string;
  originalText: string;
  sanitizedText: string;
  attachment?: TurnAttachment;
  quickReplies?: TurnQuickReply[];
  sessionId?: string;
  sessionTitle?: string;
  textChangedBySanitizer: boolean;
  providerId: string;
  modelId: string;
  voiceId: string;
  waitForRecognition: boolean;
  recognitionModelId?: string;
  recognitionStartTimeoutMs: number;
  recognitionCompletionTimeoutMs: number;
  recognitionEndSilenceMs: number;
  cancellationSignal?: AbortSignal;
}

interface TurnStartMessage {
  type: "turn_start";
  turnId: string;
  createdAt: string;
  attachment?: TurnAttachment;
  quickReplies?: TurnQuickReply[];
  sessionId?: string;
  sessionTitle?: string;
  originalText: string;
  sanitizedText: string;
  textChangedBySanitizer: boolean;
  originalLength: number;
  sanitizedLength: number;
  providerId: string;
  modelId: string;
  voiceId: string;
  listenRequested: boolean;
  listenModelId: string | null;
}

interface TurnAudioChunkMessage {
  type: "turn_audio_chunk";
  turnId: string;
  sampleRate: number;
  encoding: "pcm_s16le";
  chunkBase64: string;
}

interface TurnTtsEndMessage {
  type: "turn_tts_end";
  turnId: string;
  success: boolean;
  error?: string;
}

interface TurnListenStartMessage {
  type: "turn_listen_start";
  turnId: string;
  providerId: string;
  modelId: string;
}

type TurnListenCancelReason =
  | "request_disconnected"
  | "owner_socket_closed"
  | "client_end"
  | "stop_tts"
  | "unknown";

interface TurnListenResultMessage {
  type: "turn_listen_result";
  turnId: string;
  success: boolean;
  text?: string;
  error?: string;
  canceled?: boolean;
  cancelReason?: TurnListenCancelReason;
  retryable?: boolean;
  timeoutFallbackUsed?: boolean;
  providerId: string;
  modelId: string;
  durationMs: number;
}

interface TurnListenStopMessage {
  type: "turn_listen_stop";
  turnId: string;
  reason: "silence" | "max_duration" | "client_end" | "max_bytes" | "socket_closed";
}

interface ServerStateMessage {
  type: "server_state";
  connectedClients: number;
  acceptingTurnClients: number;
  audioEnabledClients: number;
  listeningEnabledClients: number;
  directTtsCapableClients: number;
  directSttCapableClients: number;
  activeDirectTtsRequests: number;
  activeDirectSttRequests: number;
  activeClientConnected: boolean;
  queueLength: number;
  processing: boolean;
}

interface ClientIdentityMessage {
  type: "client_identity";
  clientId: string;
}

interface ServerPongMessage {
  type: "server_pong";
  echoedSentAtMs?: number;
  serverTimeMs: number;
}

interface ClientActivationStateMessage {
  type: "client_activation_state";
  active: boolean;
  activeClientConnected: boolean;
  connectedClients: number;
}

type DirectMediaTtsStatus = "completed" | "stopped" | "failed" | "canceled";
type DirectMediaSttInputMode = "stream" | "blob";
type DirectMediaSttStopReason =
  | "silence"
  | "max_duration"
  | "client_end"
  | "max_bytes"
  | "socket_closed"
  | "client_cancel";
type DirectMediaSttCancelReason = "client_cancel" | "client_disconnect" | "request_disconnected";

interface MediaTtsStartMessage {
  type: "media_tts_start";
  clientId: string;
  requestId: string;
  providerId: string;
  modelId: string;
  voiceId: string;
  textChangedBySanitizer: boolean;
  outputSampleRate: number;
}

interface MediaTtsAudioChunkMessage {
  type: "media_tts_audio_chunk";
  clientId: string;
  requestId: string;
  sampleRate: number;
  encoding: "pcm_s16le";
  chunkBase64: string;
}

interface MediaTtsEndMessage {
  type: "media_tts_end";
  clientId: string;
  requestId: string;
  status: DirectMediaTtsStatus;
  providerId: string;
  modelId: string;
  voiceId: string;
  error?: string;
}

interface MediaSttStartedMessage {
  type: "media_stt_started";
  clientId: string;
  requestId: string;
  inputMode: DirectMediaSttInputMode;
  providerId: string;
  modelId: string;
}

interface MediaSttStoppedMessage {
  type: "media_stt_stopped";
  clientId: string;
  requestId: string;
  inputMode: DirectMediaSttInputMode;
  reason: DirectMediaSttStopReason;
}

interface MediaSttResultMessage {
  type: "media_stt_result";
  clientId: string;
  requestId: string;
  inputMode: DirectMediaSttInputMode;
  success: boolean;
  text?: string;
  error?: string;
  canceled?: boolean;
  cancelReason?: DirectMediaSttCancelReason;
  retryable?: boolean;
  providerId: string;
  modelId: string;
  durationMs: number;
}

type OutboundMessage =
  | TurnStartMessage
  | TurnAudioChunkMessage
  | TurnTtsEndMessage
  | TurnListenStartMessage
  | TurnListenResultMessage
  | TurnListenStopMessage
  | ServerStateMessage
  | ClientIdentityMessage
  | ServerPongMessage
  | ClientActivationStateMessage
  | MediaTtsStartMessage
  | MediaTtsAudioChunkMessage
  | MediaTtsEndMessage
  | MediaSttStartedMessage
  | MediaSttStoppedMessage
  | MediaSttResultMessage;

type ClientState = VoiceClientState;

interface ServerState {
  queue: SpeakJob[];
  processing: boolean;
}

interface SpeakCompletionResult {
  success: boolean;
  error?: string;
}

interface PlaybackTerminalResult {
  status: "done" | "aborted";
  reason?: string;
  timeoutFallbackUsed?: boolean;
}

interface WaitForRecognitionJobCompletion {
  speak: SpeakCompletionResult;
  recognition?: RecognitionResultPayload;
}

interface TurnContext {
  ownerSocket?: WebSocket;
  cancellationController?: AbortController;
  pendingWaitResolver?: (result: WaitForRecognitionJobCompletion) => void;
  pendingPlaybackTerminalResolver?: (result: PlaybackTerminalResult) => void;
  pendingPlaybackTerminalTimeoutHandle?: NodeJS.Timeout;
  pendingPlaybackTerminalCancellationSignal?: AbortSignal;
  pendingPlaybackTerminalCancellationAbortHandler?: () => void;
  cachedPlaybackTerminalResult?: PlaybackTerminalResult;
  awaitingPlaybackTerminal: boolean;
  ttsActive: boolean;
  recognitionWaitState?: RecognitionWaitState;
  cachedRecognitionResult?: RecognitionResultPayload;
  cachedRecognitionCleanupTimer?: NodeJS.Timeout;
  recognitionInFlight: boolean;
  recognitionStreamSession?: RecognitionStreamSession;
  recognitionTimingSettings?: RecognitionTimingSettings;
  quickReplyContext?: TurnQuickReplyContext;
  quickReplyContextCleanupTimer?: NodeJS.Timeout;
}

interface RecognitionTimingSettings {
  startTimeoutMs: number;
  completionTimeoutMs: number;
  endSilenceMs: number;
}

interface RecognitionResultPayload {
  requestId: string;
  success: boolean;
  text?: string;
  error?: string;
  canceled?: boolean;
  cancelReason?: TurnListenCancelReason;
  retryable?: boolean;
  timeoutFallbackUsed?: boolean;
  providerId: string;
  modelId: string;
  durationMs: number;
}

interface RecognitionStreamSession {
  requestId: string;
  socket: WebSocket;
  modelId?: string;
  timing: RecognitionTimingSettings;
  sampleRate: number;
  channels: number;
  startedAtMs: number;
  sawSpeech: boolean;
  speechStartedAtMs: number | null;
  lastSpeechAtMs: number;
  totalBytes: number;
  chunks: Buffer[];
  finalizing: boolean;
}

interface DirectMediaTtsContext {
  clientId: string;
  socket: WebSocket;
  requestId: string;
  providerId: string;
  modelId: string;
  voiceId: string;
  textChangedBySanitizer: boolean;
  abortController: AbortController;
  outputSampleRate: number;
}

interface DirectMediaSttContext {
  clientId: string;
  socket: WebSocket;
  requestId: string;
  inputMode: DirectMediaSttInputMode;
  modelId?: string;
  timing: RecognitionTimingSettings;
  sampleRate: number;
  channels: number;
  startedAtMs: number;
  sawSpeech: boolean;
  speechStartedAtMs: number | null;
  lastSpeechAtMs: number;
  totalBytes: number;
  chunks: Buffer[];
  finalizing: boolean;
  completed: boolean;
  resultResolver?: (result: MediaSttResultMessage) => void;
}

interface RuntimeServerSettings {
  asrListenStartTimeoutMs: number;
  asrListenCompletionTimeoutMs: number;
  asrRecognitionEndSilenceMs: number;
  queueAdvanceDelayMs: number;
  prependLinkedSessionLabelForTts: boolean;
}

interface RecognitionWaitState {
  resolver?: (result: RecognitionResultPayload) => void;
  captureStartNotifier?: () => void;
  speechStartNotifier?: () => void;
  startTimeoutHandle?: NodeJS.Timeout;
  completionTimeoutHandle?: NodeJS.Timeout;
  captureStartTimeoutHandle?: NodeJS.Timeout;
  cancellationSignal?: AbortSignal;
  cancellationAbortHandler?: () => void;
  captureStarted: boolean;
  speechStarted: boolean;
}

interface TurnTtsDebugInfo {
  providerId: string;
  modelId: string;
  voiceId: string;
  outputSampleRate: number;
  listenRequested: boolean;
  requestTextChars: number;
  sanitizedTextChars: number;
  kokoroConfig?: {
    langCode: string;
    speed: number;
    device: "cuda" | "cpu" | "auto";
    maxTextCharsPerChunk: number;
    gapMsBetweenChunks: number;
  };
}

interface TurnAttachment {
  dataBase64: string;
  fileName?: string;
  contentType: string;
}

interface TurnQuickReply {
  id?: string;
  label: string;
  text: string;
  defaultResume?: boolean;
}

interface TurnQuickReplyContext {
  assistantText: string;
  sessionId?: string;
  waitForRecognition: boolean;
  quickReplies: TurnQuickReply[];
}

function logInfo(prefix: string, ...args: unknown[]): void {
  console.log(`${new Date().toISOString()} ${prefix}`, ...args);
}

function logError(prefix: string, ...args: unknown[]): void {
  console.error(`${new Date().toISOString()} ${prefix}`, ...args);
}

export function runWebsocketAsyncTaskSafely(params: {
  requestId: string | null;
  operation: string;
  task: () => Promise<void>;
  onRequestError?: (requestId: string, error: string) => void;
  logger?: (prefix: string, ...args: unknown[]) => void;
}): void {
  const log = params.logger ?? logError;
  void params.task().catch((error) => {
    const renderedError = normalizeErrorMessage(error);
    log("[agent-voice-adapter] websocket async handler failed", {
      operation: params.operation,
      requestId: params.requestId,
      error: renderedError,
    });
    if (params.requestId && params.onRequestError) {
      params.onRequestError(params.requestId, renderedError);
    }
  });
}

function sendJson(socket: WebSocket, message: OutboundMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function parsePositiveIntFromUnknown(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return fallback;
}

function parseNonNegativeIntFromUnknown(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return fallback;
}

function parseBooleanFromUnknown(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return fallback;
}

function parseOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalPositiveIntOverride(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function decodeBase64Strict(value: string): Buffer | null {
  if (value.length === 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    return null;
  }
  if (value.includes("=") && !/={1,2}$/.test(value)) {
    return null;
  }
  if (value.length % 4 === 1) {
    return null;
  }

  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const decoded = Buffer.from(padded, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedDecoded = decoded.toString("base64").replace(/=+$/, "");
  return normalizedDecoded === normalizedInput ? decoded : null;
}

function parseTurnAttachmentFromUnknown(value: unknown): {
  attachment?: TurnAttachment;
  error?: string;
} {
  if (value === undefined) {
    return {};
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "attachment must be an object" };
  }

  const raw = value as Record<string, unknown>;
  const dataBase64 = parseOptionalTrimmedString(raw.dataBase64);
  if (!dataBase64) {
    return { error: "attachment.dataBase64 must be a non-empty string" };
  }

  const contentType = parseOptionalTrimmedString(raw.contentType);
  if (!contentType) {
    return { error: "attachment.contentType must be a non-empty string" };
  }

  const fileNameProvided = Object.prototype.hasOwnProperty.call(raw, "fileName");
  const fileName = parseOptionalTrimmedString(raw.fileName);
  if (fileNameProvided && !fileName) {
    return { error: "attachment.fileName must be a non-empty string when provided" };
  }

  return {
    attachment: {
      dataBase64,
      contentType,
      ...(fileName ? { fileName } : {}),
    },
  };
}

const TURN_QUICK_REPLY_MAX_ITEMS = 8;
const TURN_QUICK_REPLY_MAX_LABEL_CHARS = 64;
const TURN_QUICK_REPLY_MAX_TEXT_CHARS = 280;
const TURN_QUICK_REPLY_MAX_ID_CHARS = 64;
const TURN_AUTO_RESUME_QUICK_REPLY_ID = "__auto_resume_voice__";
const TURN_AUTO_RESUME_QUICK_REPLY_LABEL = "Resume";
const TURN_AUTO_RESUME_QUICK_REPLY_TEXT =
  "Resume the conversation where you left off and continue the current task with the user over voice using the agent-voice-adapter-cli skill.";
const TURN_QUICK_REPLY_CONTEXT_TTL_MS = 15 * 60 * 1000;

function createAutoResumeQuickReply(): TurnQuickReply {
  return {
    id: TURN_AUTO_RESUME_QUICK_REPLY_ID,
    label: TURN_AUTO_RESUME_QUICK_REPLY_LABEL,
    text: TURN_AUTO_RESUME_QUICK_REPLY_TEXT,
    defaultResume: true,
  };
}

function formatDeferredNoWaitQuickReplyMessage(params: {
  assistantText: string;
  quickReplyText: string;
}): string {
  const assistantText = params.assistantText.trim();
  const quickReplyText = params.quickReplyText.trim();
  if (!assistantText) {
    return quickReplyText;
  }
  return [
    "User is responding to a previous assistant message.",
    "Assistant message:",
    assistantText,
    "User response:",
    quickReplyText,
  ].join("\n");
}

function parseTurnQuickRepliesFromUnknown(value: unknown): {
  quickReplies?: TurnQuickReply[];
  error?: string;
} {
  if (value === null || value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    return { error: "quickReplies must be an array when provided" };
  }
  if (value.length < 1) {
    return { error: "quickReplies must include at least one item when provided" };
  }
  if (value.length > TURN_QUICK_REPLY_MAX_ITEMS) {
    return { error: `quickReplies supports at most ${TURN_QUICK_REPLY_MAX_ITEMS} items` };
  }

  const parsed: TurnQuickReply[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const rawItem = value[index];
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return { error: `quickReplies[${index}] must be an object` };
    }
    const record = rawItem as Record<string, unknown>;
    const label =
      typeof record.label === "string" && record.label.trim().length > 0 ? record.label.trim() : "";
    if (!label) {
      return { error: `quickReplies[${index}].label must be a non-empty string` };
    }
    if (label.length > TURN_QUICK_REPLY_MAX_LABEL_CHARS) {
      return {
        error: `quickReplies[${index}].label must be at most ${TURN_QUICK_REPLY_MAX_LABEL_CHARS} characters`,
      };
    }

    const text =
      typeof record.text === "string" && record.text.trim().length > 0 ? record.text.trim() : "";
    if (!text) {
      return { error: `quickReplies[${index}].text must be a non-empty string` };
    }
    if (text.length > TURN_QUICK_REPLY_MAX_TEXT_CHARS) {
      return {
        error: `quickReplies[${index}].text must be at most ${TURN_QUICK_REPLY_MAX_TEXT_CHARS} characters`,
      };
    }

    let id: string | undefined;
    if (Object.prototype.hasOwnProperty.call(record, "id")) {
      if (typeof record.id !== "string" || record.id.trim().length < 1) {
        return {
          error: `quickReplies[${index}].id must be a non-empty string when provided`,
        };
      }
      id = record.id.trim();
      if (id.length > TURN_QUICK_REPLY_MAX_ID_CHARS) {
        return {
          error: `quickReplies[${index}].id must be at most ${TURN_QUICK_REPLY_MAX_ID_CHARS} characters`,
        };
      }
      if (seenIds.has(id)) {
        return { error: `quickReplies[${index}].id duplicates an earlier id` };
      }
      seenIds.add(id);
    }

    parsed.push({
      ...(id ? { id } : {}),
      label,
      text,
    });
  }

  return {
    quickReplies: parsed,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const RECOGNITION_STREAM_MAX_BYTES = 16 * 1024 * 1024;
const RECOGNITION_STREAM_MAX_START_WAIT_MS = 30_000;
const RECOGNITION_STREAM_MAX_SPEECH_MS = 60_000;
const DEFAULT_RECOGNITION_STREAM_END_SILENCE_MS = 1_200;
const RECOGNITION_STREAM_RMS_THRESHOLD = 0.012;
const RECOGNITION_STREAM_MIN_SPEECH_MS = 120;
const REQUEST_DISCONNECTED_ERROR = "canceled";
const REQUEST_STOP_TTS_ERROR = "stop_tts";
const TURN_OWNER_SOCKET_CLOSED_ERROR = "Turn owner socket closed before completion";
const PLAYBACK_TERMINAL_ACK_TIMEOUT_MS = 45_000;

function normalizeTurnListenCancelReason(
  cancelReason: string | undefined,
): TurnListenCancelReason | undefined {
  if (typeof cancelReason !== "string") {
    return undefined;
  }

  const normalized = cancelReason.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "request_disconnected" || normalized === REQUEST_DISCONNECTED_ERROR) {
    return "request_disconnected";
  }
  if (
    normalized === "owner_socket_closed" ||
    normalized === TURN_OWNER_SOCKET_CLOSED_ERROR.toLowerCase()
  ) {
    return "owner_socket_closed";
  }
  if (normalized === "client_end") {
    return "client_end";
  }
  if (normalized === "stop_tts" || normalized === REQUEST_STOP_TTS_ERROR) {
    return "stop_tts";
  }
  if (normalized === "unknown") {
    return "unknown";
  }

  return undefined;
}

function resolveTurnListenCancellationMetadata(payload: {
  success: boolean;
  canceled?: boolean;
  cancelReason?: string;
  error?: string;
}): { canceled?: true; cancelReason?: TurnListenCancelReason } {
  if (payload.success) {
    return {};
  }

  const normalizedReason =
    normalizeTurnListenCancelReason(payload.cancelReason) ??
    normalizeTurnListenCancelReason(payload.error);
  const hasExplicitCancelReason =
    typeof payload.cancelReason === "string" && payload.cancelReason.trim().length > 0;
  const hasCancelMarker =
    payload.canceled === true || hasExplicitCancelReason || normalizedReason != null;
  if (!hasCancelMarker) {
    return {};
  }

  return {
    canceled: true,
    ...(normalizedReason ? { cancelReason: normalizedReason } : {}),
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}

function isNoUsableSpeechError(error: unknown): boolean {
  const normalized = normalizeErrorMessage(error).trim().toLowerCase();
  return normalized.includes("no usable speech detected");
}

function computeRmsPcm16le(bytes: Buffer): number {
  if (bytes.length < 2) {
    return 0;
  }

  const sampleCount = Math.floor(bytes.length / 2);
  let sumSquares = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = bytes.readInt16LE(index * 2) / 32768;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

function encodePcm16Wav(pcmBytes: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + pcmBytes.length);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcmBytes.length, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcmBytes.length, 40);
  pcmBytes.copy(buffer, 44);
  return buffer;
}

export async function startServer(config: AppConfig): Promise<http.Server> {
  const app = express();
  const httpServer = http.createServer(app);
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: config.wsPath,
  });

  const clients = new Map<WebSocket, ClientState>();
  const clientDebugIds = new Map<WebSocket, string>();
  const clientIds = new Map<WebSocket, string>();
  const socketsByClientId = new Map<string, WebSocket>();
  let clientDebugCounter = 0;
  let activeClientSocket: WebSocket | null = null;
  const activeDirectTtsByClientId = new Map<string, DirectMediaTtsContext>();
  const activeDirectSttByClientId = new Map<string, DirectMediaSttContext>();
  const activeDirectSttByRequestId = new Map<string, DirectMediaSttContext>();
  const recentlyFinishedDirectSttByRequestId = new Map<
    string,
    { socket: WebSocket; cleanupTimer: NodeJS.Timeout }
  >();
  const state: ServerState = {
    queue: [],
    processing: false,
  };

  httpServer.on("close", () => {
    for (const context of activeDirectTtsByClientId.values()) {
      context.abortController.abort("server_closed");
    }
    activeDirectTtsByClientId.clear();
    activeDirectSttByClientId.clear();
    activeDirectSttByRequestId.clear();
    shutdownKokoroDaemonProcesses();
    shutdownParakeetDaemonProcesses();
  });

  const outputSampleRate = config.tts.outputSampleRate;
  const runtimeSettings: RuntimeServerSettings = {
    asrListenStartTimeoutMs: parsePositiveIntFromUnknown(
      config.asr.recognitionStartTimeoutMs,
      RECOGNITION_STREAM_MAX_START_WAIT_MS,
    ),
    asrListenCompletionTimeoutMs: parsePositiveIntFromUnknown(
      config.asr.recognitionCompletionTimeoutMs,
      RECOGNITION_STREAM_MAX_SPEECH_MS,
    ),
    asrRecognitionEndSilenceMs: parsePositiveIntFromUnknown(
      config.asr.recognitionEndSilenceMs,
      DEFAULT_RECOGNITION_STREAM_END_SILENCE_MS,
    ),
    queueAdvanceDelayMs: parseNonNegativeIntFromUnknown(config.asr.queueAdvanceDelayMs, 0),
    prependLinkedSessionLabelForTts: parseBooleanFromUnknown(
      config.sessionDispatch?.prependLinkedSessionLabelForTts,
      false,
    ),
  };
  const asrProvider = createAsrProvider(config, {
    log: (...args: unknown[]) => {
      logInfo("[agent-voice-adapter:asr]", ...args);
    },
  });
  const sessionDispatchService = createSessionDispatchService(config);
  const linkedSessionLabelCache = new Map<string, { label?: string; expiresAtMs: number }>();
  const LINKED_SESSION_LABEL_CACHE_TTL_MS = 60_000;
  const resolveLinkedSessionLabelForTts = async (
    sessionId: string,
  ): Promise<string | undefined> => {
    if (!sessionDispatchService.isConfigured) {
      return undefined;
    }
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) {
      return undefined;
    }
    const now = Date.now();
    const cached = linkedSessionLabelCache.get(normalizedSessionId);
    if (cached && cached.expiresAtMs > now) {
      return cached.label;
    }
    try {
      const session = await sessionDispatchService.resolveSession(normalizedSessionId);
      const label =
        session == null
          ? undefined
          : formatLinkedSessionPrefixLabel({
              workspace: session.workspace,
              resolvedTitle: session.resolvedTitle,
              sessionId: session.sessionId,
            });
      linkedSessionLabelCache.set(normalizedSessionId, {
        label,
        expiresAtMs: now + LINKED_SESSION_LABEL_CACHE_TTL_MS,
      });
      return label;
    } catch (error) {
      logError("[agent-voice-adapter] linked_session_label_lookup_failed", {
        sessionId: normalizedSessionId,
        error: normalizeErrorMessage(error),
      });
      linkedSessionLabelCache.set(normalizedSessionId, {
        label: undefined,
        expiresAtMs: now + 10_000,
      });
      return undefined;
    }
  };
  const turnContexts = new Map<string, TurnContext>();
  const getOrCreateTurnContext = (requestId: string): TurnContext => {
    const existing = turnContexts.get(requestId);
    if (existing) {
      return existing;
    }
    const created: TurnContext = {
      awaitingPlaybackTerminal: false,
      ttsActive: false,
      recognitionInFlight: false,
    };
    turnContexts.set(requestId, created);
    return created;
  };
  const clearTurnContextIfEmpty = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    if (
      context.ownerSocket ||
      context.cancellationController ||
      context.pendingWaitResolver ||
      context.pendingPlaybackTerminalResolver ||
      context.pendingPlaybackTerminalTimeoutHandle ||
      context.pendingPlaybackTerminalCancellationSignal ||
      context.pendingPlaybackTerminalCancellationAbortHandler ||
      context.cachedPlaybackTerminalResult ||
      context.awaitingPlaybackTerminal ||
      context.ttsActive ||
      context.recognitionWaitState ||
      context.cachedRecognitionResult ||
      context.cachedRecognitionCleanupTimer ||
      context.recognitionInFlight ||
      context.recognitionStreamSession ||
      context.recognitionTimingSettings ||
      context.quickReplyContext ||
      context.quickReplyContextCleanupTimer
    ) {
      return;
    }
    turnContexts.delete(requestId);
  };
  const setTurnQuickReplyContext = (
    requestId: string,
    quickReplyContext: TurnQuickReplyContext,
  ): void => {
    const context = getOrCreateTurnContext(requestId);
    if (context.quickReplyContextCleanupTimer) {
      clearTimeout(context.quickReplyContextCleanupTimer);
      context.quickReplyContextCleanupTimer = undefined;
    }
    context.quickReplyContext = quickReplyContext;
    const cleanupTimer = setTimeout(() => {
      clearTurnQuickReplyContext(requestId);
    }, TURN_QUICK_REPLY_CONTEXT_TTL_MS);
    cleanupTimer.unref?.();
    context.quickReplyContextCleanupTimer = cleanupTimer;
  };
  const getTurnQuickReplyContext = (requestId: string): TurnQuickReplyContext | undefined =>
    turnContexts.get(requestId)?.quickReplyContext;
  const clearTurnQuickReplyContext = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    if (context.quickReplyContextCleanupTimer) {
      clearTimeout(context.quickReplyContextCleanupTimer);
      context.quickReplyContextCleanupTimer = undefined;
    }
    context.quickReplyContext = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const getPendingWaitResolver = (
    requestId: string,
  ): ((result: WaitForRecognitionJobCompletion) => void) | undefined =>
    turnContexts.get(requestId)?.pendingWaitResolver;
  const setTurnRecognitionTimingSettings = (
    requestId: string,
    timing: RecognitionTimingSettings,
  ): void => {
    const context = getOrCreateTurnContext(requestId);
    context.recognitionTimingSettings = timing;
  };
  const getTurnRecognitionTimingSettings = (
    requestId: string,
  ): RecognitionTimingSettings | undefined =>
    turnContexts.get(requestId)?.recognitionTimingSettings;
  const clearTurnRecognitionTimingSettings = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    context.recognitionTimingSettings = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const clearPendingWaitResolver = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    context.pendingWaitResolver = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const setPendingWaitResolver = (
    requestId: string,
    resolver: (result: WaitForRecognitionJobCompletion) => void,
  ): void => {
    const context = getOrCreateTurnContext(requestId);
    context.pendingWaitResolver = resolver;
  };
  const hasPendingWaitResolver = (requestId: string): boolean =>
    getPendingWaitResolver(requestId) != null;
  const resolvePendingWaitCompletion = (
    requestId: string,
    completion: WaitForRecognitionJobCompletion,
  ): boolean => {
    const resolver = getPendingWaitResolver(requestId);
    if (!resolver) {
      return false;
    }
    clearTurnRecognitionTimingSettings(requestId);
    clearPendingWaitResolver(requestId);
    resolver(completion);
    return true;
  };
  const resolvePendingWaitSpeakError = (requestId: string, error: string): boolean =>
    resolvePendingWaitCompletion(requestId, {
      speak: {
        success: false,
        error,
      },
    });
  const setTurnOwnerSocket = (requestId: string, socket: WebSocket): void => {
    const context = getOrCreateTurnContext(requestId);
    context.ownerSocket = socket;
  };
  const getTurnOwnerSocket = (requestId: string): WebSocket | undefined =>
    turnContexts.get(requestId)?.ownerSocket;
  const clearTurnOwnerSocket = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    context.ownerSocket = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const setTurnCancellationController = (requestId: string, controller: AbortController): void => {
    const context = getOrCreateTurnContext(requestId);
    context.cancellationController = controller;
  };
  const getTurnCancellationController = (requestId: string): AbortController | undefined =>
    turnContexts.get(requestId)?.cancellationController;
  const clearTurnCancellationController = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    context.cancellationController = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const setTurnTtsActive = (requestId: string, active: boolean): void => {
    const context = getOrCreateTurnContext(requestId);
    context.ttsActive = active;
    if (!active) {
      clearTurnContextIfEmpty(requestId);
    }
  };
  const isTurnTtsActive = (requestId: string): boolean =>
    turnContexts.get(requestId)?.ttsActive === true;

  const clearPlaybackTerminalWaitStateResources = (context: TurnContext): void => {
    if (context.pendingPlaybackTerminalTimeoutHandle) {
      clearTimeout(context.pendingPlaybackTerminalTimeoutHandle);
      context.pendingPlaybackTerminalTimeoutHandle = undefined;
    }
    if (
      context.pendingPlaybackTerminalCancellationSignal &&
      context.pendingPlaybackTerminalCancellationAbortHandler
    ) {
      context.pendingPlaybackTerminalCancellationSignal.removeEventListener(
        "abort",
        context.pendingPlaybackTerminalCancellationAbortHandler,
      );
    }
    context.pendingPlaybackTerminalCancellationSignal = undefined;
    context.pendingPlaybackTerminalCancellationAbortHandler = undefined;
  };
  const clearPendingPlaybackTerminalWait = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    clearPlaybackTerminalWaitStateResources(context);
    context.pendingPlaybackTerminalResolver = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const setAwaitingPlaybackTerminal = (requestId: string, awaiting: boolean): void => {
    const context = awaiting ? getOrCreateTurnContext(requestId) : turnContexts.get(requestId);
    if (!context) {
      return;
    }
    context.awaitingPlaybackTerminal = awaiting;
    if (!awaiting) {
      context.cachedPlaybackTerminalResult = undefined;
      clearPendingPlaybackTerminalWait(requestId);
      clearTurnContextIfEmpty(requestId);
    }
  };
  const resolvePlaybackTerminal = (requestId: string, result: PlaybackTerminalResult): boolean => {
    const context = turnContexts.get(requestId);
    if (!context || !context.awaitingPlaybackTerminal) {
      return false;
    }
    const resolver = context.pendingPlaybackTerminalResolver;
    if (resolver) {
      clearPendingPlaybackTerminalWait(requestId);
      resolver(result);
      return true;
    }
    context.cachedPlaybackTerminalResult = result;
    return true;
  };
  const waitForPlaybackTerminal = (
    requestId: string,
    timeoutMs: number,
    cancellationSignal?: AbortSignal,
  ): Promise<PlaybackTerminalResult> => {
    const context = getOrCreateTurnContext(requestId);
    if (context.cachedPlaybackTerminalResult) {
      const cached = context.cachedPlaybackTerminalResult;
      context.cachedPlaybackTerminalResult = undefined;
      return Promise.resolve(cached);
    }
    if (cancellationSignal?.aborted) {
      const reason =
        typeof cancellationSignal.reason === "string" && cancellationSignal.reason.trim().length > 0
          ? cancellationSignal.reason
          : REQUEST_DISCONNECTED_ERROR;
      return Promise.resolve({
        status: "aborted",
        reason,
      });
    }

    return new Promise<PlaybackTerminalResult>((resolve) => {
      context.pendingPlaybackTerminalResolver = (result) => {
        resolve(result);
      };
      context.pendingPlaybackTerminalTimeoutHandle = setTimeout(() => {
        const timeoutResult: PlaybackTerminalResult = {
          status: "aborted",
          reason: `Playback terminal ack timed out after ${timeoutMs}ms`,
          timeoutFallbackUsed: true,
        };
        clearPendingPlaybackTerminalWait(requestId);
        resolve(timeoutResult);
      }, timeoutMs);
      context.pendingPlaybackTerminalTimeoutHandle.unref?.();

      if (cancellationSignal) {
        const handleCancellation = (): void => {
          const reason =
            typeof cancellationSignal.reason === "string" &&
            cancellationSignal.reason.trim().length > 0
              ? cancellationSignal.reason
              : REQUEST_DISCONNECTED_ERROR;
          const cancellationResult: PlaybackTerminalResult = {
            status: "aborted",
            reason,
          };
          clearPendingPlaybackTerminalWait(requestId);
          resolve(cancellationResult);
        };
        context.pendingPlaybackTerminalCancellationSignal = cancellationSignal;
        context.pendingPlaybackTerminalCancellationAbortHandler = handleCancellation;
        cancellationSignal.addEventListener("abort", handleCancellation, { once: true });
      }
    });
  };

  const getOrCreateRecognitionWaitState = (requestId: string): RecognitionWaitState => {
    const context = getOrCreateTurnContext(requestId);
    const existing = context.recognitionWaitState;
    if (existing) {
      return existing;
    }
    const created: RecognitionWaitState = {
      captureStarted: false,
      speechStarted: false,
    };
    context.recognitionWaitState = created;
    return created;
  };
  const getRecognitionWaitState = (requestId: string): RecognitionWaitState | undefined =>
    turnContexts.get(requestId)?.recognitionWaitState;
  const clearRecognitionWaitStateResources = (waitState: RecognitionWaitState): void => {
    if (waitState.startTimeoutHandle) {
      clearTimeout(waitState.startTimeoutHandle);
      waitState.startTimeoutHandle = undefined;
    }
    if (waitState.completionTimeoutHandle) {
      clearTimeout(waitState.completionTimeoutHandle);
      waitState.completionTimeoutHandle = undefined;
    }
    if (waitState.captureStartTimeoutHandle) {
      clearTimeout(waitState.captureStartTimeoutHandle);
      waitState.captureStartTimeoutHandle = undefined;
    }
    if (waitState.cancellationSignal && waitState.cancellationAbortHandler) {
      waitState.cancellationSignal.removeEventListener("abort", waitState.cancellationAbortHandler);
    }
    waitState.cancellationSignal = undefined;
    waitState.cancellationAbortHandler = undefined;
    waitState.captureStartNotifier = undefined;
    waitState.speechStartNotifier = undefined;
  };
  const clearRecognitionWaitState = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    const waitState = context.recognitionWaitState;
    if (waitState) {
      clearRecognitionWaitStateResources(waitState);
      context.recognitionWaitState = undefined;
    }
    clearTurnContextIfEmpty(requestId);
  };
  const hasRecognitionWaitState = (requestId: string): boolean =>
    turnContexts.get(requestId)?.recognitionWaitState != null;
  const getCachedRecognitionResult = (requestId: string): RecognitionResultPayload | undefined =>
    turnContexts.get(requestId)?.cachedRecognitionResult;
  const clearCachedRecognitionResult = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    if (context.cachedRecognitionCleanupTimer) {
      clearTimeout(context.cachedRecognitionCleanupTimer);
      context.cachedRecognitionCleanupTimer = undefined;
    }
    context.cachedRecognitionResult = undefined;
    clearTurnContextIfEmpty(requestId);
  };
  const isRecognitionInFlight = (requestId: string): boolean =>
    turnContexts.get(requestId)?.recognitionInFlight === true;
  const setRecognitionInFlight = (requestId: string, inFlight: boolean): void => {
    const context = getOrCreateTurnContext(requestId);
    context.recognitionInFlight = inFlight;
    if (!inFlight) {
      clearTurnContextIfEmpty(requestId);
    }
  };
  const getRecognitionStreamSession = (requestId: string): RecognitionStreamSession | undefined =>
    turnContexts.get(requestId)?.recognitionStreamSession;
  const setRecognitionStreamSession = (
    requestId: string,
    session: RecognitionStreamSession,
  ): void => {
    const context = getOrCreateTurnContext(requestId);
    context.recognitionStreamSession = session;
  };
  const clearRecognitionStreamSession = (requestId: string): void => {
    const context = turnContexts.get(requestId);
    if (!context) {
      return;
    }
    context.recognitionStreamSession = undefined;
    clearTurnContextIfEmpty(requestId);
  };

  const broadcast = (message: OutboundMessage): void => {
    for (const socket of clients.keys()) {
      sendJson(socket, message);
    }
  };

  const createStatusMessage = (): ServerStateMessage => ({
    type: "server_state",
    connectedClients: clients.size,
    acceptingTurnClients: getAcceptingClientCount(clients.values()),
    audioEnabledClients: getAudioEnabledAcceptingClientCount(clients.values()),
    listeningEnabledClients: getRecognitionEnabledAcceptingClientCount(clients.values()),
    directTtsCapableClients: getDirectTtsEnabledClientCount(clients.values()),
    directSttCapableClients: getDirectSttEnabledClientCount(clients.values()),
    activeDirectTtsRequests: activeDirectTtsByClientId.size,
    activeDirectSttRequests: activeDirectSttByClientId.size,
    activeClientConnected: activeClientSocket != null && clients.has(activeClientSocket),
    queueLength: state.queue.length,
    processing: state.processing,
  });

  const createPongMessage = (message: ClientPingInboundMessage): ServerPongMessage => {
    const sentAtMs =
      typeof message.sentAtMs === "number" && Number.isFinite(message.sentAtMs)
        ? Math.floor(message.sentAtMs)
        : undefined;
    return {
      type: "server_pong",
      ...(typeof sentAtMs === "number" ? { echoedSentAtMs: sentAtMs } : {}),
      serverTimeMs: Date.now(),
    };
  };

  const broadcastStatus = (): void => {
    broadcast(createStatusMessage());
  };

  const describeClient = (socket: WebSocket): string => {
    return clientDebugIds.get(socket) ?? "client:unknown";
  };

  const getClientIdForSocket = (socket: WebSocket): string | undefined => clientIds.get(socket);

  const createClientIdentityMessage = (socket: WebSocket): ClientIdentityMessage => ({
    type: "client_identity",
    clientId: getClientIdForSocket(socket) ?? "",
  });

  const createClientActivationStateMessage = (socket: WebSocket): ClientActivationStateMessage => ({
    type: "client_activation_state",
    active: activeClientSocket === socket,
    activeClientConnected: activeClientSocket != null && clients.has(activeClientSocket),
    connectedClients: clients.size,
  });

  const sendClientActivationState = (socket: WebSocket): void => {
    sendJson(socket, createClientActivationStateMessage(socket));
  };

  const sendClientIdentity = (socket: WebSocket): void => {
    sendJson(socket, createClientIdentityMessage(socket));
  };

  const broadcastActivationState = (): void => {
    for (const socket of clients.keys()) {
      sendClientActivationState(socket);
    }
  };

  const setActiveClientSocket = (socket: WebSocket | null, reason: string): void => {
    const nextSocket = socket != null && clients.has(socket) ? socket : null;
    const previous = activeClientSocket;
    if (previous === nextSocket) {
      return;
    }
    activeClientSocket = nextSocket;
    logInfo("[agent-voice-adapter] active_client_changed", {
      reason,
      previous: previous ? describeClient(previous) : null,
      next: nextSocket ? describeClient(nextSocket) : null,
      connectedClients: clients.size,
    });
    broadcastStatus();
    broadcastActivationState();
    void processSpeakQueue();
  };

  const getEligibleSocketsForJob = (job: SpeakJob): WebSocket[] => {
    if (activeClientSocket != null) {
      const activeState = clients.get(activeClientSocket);
      if (!activeState?.acceptingRequests) {
        return [];
      }
      if (!getVoiceClientCapabilities(activeState).turnModeEnabled) {
        return [];
      }
      if (activeState.inTurn) {
        return [];
      }
      if (job.waitForRecognition && !activeState.recognitionEnabled) {
        return [];
      }
      return [activeClientSocket];
    }

    const eligibleSockets: WebSocket[] = [];
    for (const [candidateSocket, candidateState] of clients.entries()) {
      if (!candidateState.acceptingRequests) {
        continue;
      }
      if (!getVoiceClientCapabilities(candidateState).turnModeEnabled) {
        continue;
      }
      if (candidateState.inTurn) {
        continue;
      }
      if (job.waitForRecognition && !candidateState.recognitionEnabled) {
        continue;
      }
      eligibleSockets.push(candidateSocket);
    }
    return eligibleSockets;
  };

  const getTargetDirectClient = (
    clientId: string,
  ): { socket: WebSocket; state: ClientState } | null => {
    const socket = socketsByClientId.get(clientId);
    if (!socket) {
      return null;
    }
    const state = clients.get(socket);
    if (!state) {
      return null;
    }
    return { socket, state };
  };

  const createDirectClientStatus = () =>
    Array.from(clients.entries()).map(([socket, clientState]) => {
      const clientId = getClientIdForSocket(socket) ?? "";
      const capabilities = getVoiceClientCapabilities(clientState);
      return {
        clientId,
        turnModeEnabled: capabilities.turnModeEnabled,
        acceptingTurns: clientState.acceptingRequests,
        speechEnabled: clientState.speechEnabled,
        listeningEnabled: clientState.recognitionEnabled,
        directTtsEnabled: capabilities.directTtsEnabled,
        directSttEnabled: capabilities.directSttEnabled,
        inTurn: Boolean(clientState.inTurn),
        activeDirectTtsRequestId: activeDirectTtsByClientId.get(clientId)?.requestId ?? null,
        activeDirectSttRequestId: activeDirectSttByClientId.get(clientId)?.requestId ?? null,
      };
    });

  const clearDirectTtsContext = (clientId: string): void => {
    if (activeDirectTtsByClientId.delete(clientId)) {
      broadcastStatus();
    }
  };

  const rememberFinishedDirectSttRequest = (requestId: string, socket: WebSocket): void => {
    const existing = recentlyFinishedDirectSttByRequestId.get(requestId);
    if (existing) {
      clearTimeout(existing.cleanupTimer);
    }
    const cleanupTimer = setTimeout(() => {
      recentlyFinishedDirectSttByRequestId.delete(requestId);
    }, 30_000);
    cleanupTimer.unref?.();
    recentlyFinishedDirectSttByRequestId.set(requestId, { socket, cleanupTimer });
  };

  const wasRecentlyFinishedDirectSttRequest = (requestId: string, socket: WebSocket): boolean => {
    const recent = recentlyFinishedDirectSttByRequestId.get(requestId);
    return recent != null && recent.socket === socket;
  };

  const startDirectTtsRequest = async (params: {
    context: DirectMediaTtsContext;
    text: string;
  }): Promise<void> => {
    const { context, text } = params;
    let client: StreamingTtsClient | null = null;
    let encounteredError: unknown = null;
    let resolvedSampleRate = context.outputSampleRate;

    sendJson(context.socket, {
      type: "media_tts_start",
      clientId: context.clientId,
      requestId: context.requestId,
      providerId: context.providerId,
      modelId: context.modelId,
      voiceId: context.voiceId,
      textChangedBySanitizer: context.textChangedBySanitizer,
      outputSampleRate: resolvedSampleRate,
    });

    try {
      client = createStreamingTtsClient(config, {
        voiceId: context.voiceId,
        modelId: context.modelId,
        abortSignal: context.abortController.signal,
        log: (...args: unknown[]) => {
          logInfo("[agent-voice-adapter:direct_tts]", ...args);
        },
        onOutputSampleRate: (sampleRate: number) => {
          if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
            return;
          }
          resolvedSampleRate = Math.floor(sampleRate);
        },
        onAudioChunk: (pcmBytes: Uint8Array) => {
          sendJson(context.socket, {
            type: "media_tts_audio_chunk",
            clientId: context.clientId,
            requestId: context.requestId,
            sampleRate: resolvedSampleRate,
            encoding: "pcm_s16le",
            chunkBase64: Buffer.from(pcmBytes).toString("base64"),
          });
        },
        onError: (error: unknown) => {
          encounteredError = error;
          void client?.cancel();
        },
      });

      await client.sendText(text);
      await client.finish();

      if (encounteredError) {
        throw encounteredError;
      }

      sendJson(context.socket, {
        type: "media_tts_end",
        clientId: context.clientId,
        requestId: context.requestId,
        status: "completed",
        providerId: context.providerId,
        modelId: context.modelId,
        voiceId: context.voiceId,
      });
    } catch (error) {
      const abortReason =
        context.abortController.signal.aborted &&
        typeof context.abortController.signal.reason === "string"
          ? context.abortController.signal.reason
          : null;
      const status: DirectMediaTtsStatus =
        abortReason === "client_stop"
          ? "stopped"
          : abortReason === "client_disconnect" || abortReason === "server_closed"
            ? "canceled"
            : "failed";
      sendJson(context.socket, {
        type: "media_tts_end",
        clientId: context.clientId,
        requestId: context.requestId,
        status,
        providerId: context.providerId,
        modelId: context.modelId,
        voiceId: context.voiceId,
        ...(status === "failed" ? { error: normalizeErrorMessage(error) } : {}),
      });
    } finally {
      await client?.cancel();
      clearDirectTtsContext(context.clientId);
    }
  };

  const completeDirectSttRequest = (
    context: DirectMediaSttContext,
    result: MediaSttResultMessage,
  ): void => {
    if (context.completed) {
      return;
    }
    context.completed = true;
    activeDirectSttByClientId.delete(context.clientId);
    if (activeDirectSttByRequestId.get(context.requestId) === context) {
      activeDirectSttByRequestId.delete(context.requestId);
    }
    rememberFinishedDirectSttRequest(context.requestId, context.socket);
    logInfo("[agent-voice-adapter:direct_stt]", "result", {
      clientId: context.clientId,
      requestId: result.requestId,
      inputMode: result.inputMode,
      success: result.success,
      canceled: result.canceled,
      cancelReason: result.cancelReason,
      error: result.error,
      textLength: typeof result.text === "string" ? result.text.length : 0,
      textPreview:
        typeof result.text === "string" && result.text.length > 0
          ? result.text.slice(0, 80)
          : undefined,
      providerId: result.providerId,
      modelId: result.modelId,
      durationMs: result.durationMs,
    });
    sendJson(context.socket, result);
    context.resultResolver?.(result);
    context.resultResolver = undefined;
    broadcastStatus();
  };

  const emitDirectSttStopped = (
    context: DirectMediaSttContext,
    reason: DirectMediaSttStopReason,
  ): void => {
    sendJson(context.socket, {
      type: "media_stt_stopped",
      clientId: context.clientId,
      requestId: context.requestId,
      inputMode: context.inputMode,
      reason,
    });
  };

  const cancelDirectSttContext = (
    context: DirectMediaSttContext,
    reason: DirectMediaSttCancelReason,
    stopReason: DirectMediaSttStopReason,
  ): void => {
    if (context.completed) {
      return;
    }
    if (!context.finalizing) {
      context.finalizing = true;
      emitDirectSttStopped(context, stopReason);
    }
    completeDirectSttRequest(context, {
      type: "media_stt_result",
      clientId: context.clientId,
      requestId: context.requestId,
      inputMode: context.inputMode,
      success: false,
      error: "canceled",
      canceled: true,
      cancelReason: reason,
      providerId: config.asr.provider,
      modelId: context.modelId || config.asr.defaultModelId || "unknown",
      durationMs: 0,
    });
  };

  const sendDirectSttImmediateFailure = (params: {
    socket: WebSocket;
    clientId: string;
    requestId: string;
    inputMode: DirectMediaSttInputMode;
    modelId?: string;
    error: string;
    retryable?: boolean;
  }): void => {
    sendJson(params.socket, {
      type: "media_stt_result",
      clientId: params.clientId,
      requestId: params.requestId,
      inputMode: params.inputMode,
      success: false,
      error: params.error,
      retryable: params.retryable,
      providerId: config.asr.provider,
      modelId: params.modelId || config.asr.defaultModelId || "unknown",
      durationMs: 0,
    });
  };

  const sendDirectSttSocketFailure = (params: {
    socket: WebSocket;
    requestId: unknown;
    modelId?: string;
    error: string;
    retryable?: boolean;
  }): void => {
    const clientId = getClientIdForSocket(params.socket);
    const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
    if (!clientId || !requestId) {
      return;
    }
    sendDirectSttImmediateFailure({
      socket: params.socket,
      clientId,
      requestId,
      inputMode: "stream",
      modelId: params.modelId,
      error: params.error,
      retryable: params.retryable,
    });
  };

  const failDirectSttContext = (
    context: DirectMediaSttContext,
    error: string,
    retryable = false,
  ): void => {
    if (context.completed || context.finalizing) {
      return;
    }
    context.finalizing = true;
    completeDirectSttRequest(context, {
      type: "media_stt_result",
      clientId: context.clientId,
      requestId: context.requestId,
      inputMode: context.inputMode,
      success: false,
      error,
      retryable,
      providerId: config.asr.provider,
      modelId: context.modelId || config.asr.defaultModelId || "unknown",
      durationMs: 0,
    });
  };

  const cacheRecognitionResult = (payload: RecognitionResultPayload): void => {
    const context = getOrCreateTurnContext(payload.requestId);
    if (context.cachedRecognitionCleanupTimer) {
      clearTimeout(context.cachedRecognitionCleanupTimer);
      context.cachedRecognitionCleanupTimer = undefined;
    }
    context.cachedRecognitionResult = payload;
    const cleanupTimer = setTimeout(
      () => {
        clearCachedRecognitionResult(payload.requestId);
      },
      5 * 60 * 1000,
    );
    cleanupTimer.unref?.();
    context.cachedRecognitionCleanupTimer = cleanupTimer;
  };

  const resolvePendingRecognition = (payload: RecognitionResultPayload): void => {
    cacheRecognitionResult(payload);
    clearTurnQuickReplyContext(payload.requestId);
    clearTurnRecognitionTimingSettings(payload.requestId);
    const waitState = getRecognitionWaitState(payload.requestId);
    clearRecognitionWaitState(payload.requestId);
    const resolver = waitState?.resolver;
    if (!resolver) {
      return;
    }

    resolver(payload);
  };

  const broadcastTurnListenResult = (payload: RecognitionResultPayload): void => {
    const cancellationMetadata = resolveTurnListenCancellationMetadata(payload);
    broadcast({
      type: "turn_listen_result",
      turnId: payload.requestId,
      success: payload.success,
      text: payload.text,
      error: payload.error,
      canceled: cancellationMetadata.canceled,
      cancelReason: cancellationMetadata.cancelReason,
      retryable: payload.retryable,
      timeoutFallbackUsed: payload.timeoutFallbackUsed,
      providerId: payload.providerId,
      modelId: payload.modelId,
      durationMs: payload.durationMs,
    });
  };

  const shouldTrackRecognitionWait = (requestId: string): boolean =>
    hasPendingWaitResolver(requestId) || hasRecognitionWaitState(requestId);

  const notifyRecognitionCaptureStarted = (requestId: string): void => {
    const waitState = getRecognitionWaitState(requestId);
    const notify = waitState?.captureStartNotifier;
    if (notify) {
      waitState.captureStartNotifier = undefined;
      notify();
      return;
    }

    if (hasPendingWaitResolver(requestId) || waitState) {
      const activeState = waitState ?? getOrCreateRecognitionWaitState(requestId);
      activeState.captureStarted = true;
    }
  };

  const notifyRecognitionSpeechStarted = (requestId: string): void => {
    const waitState = getRecognitionWaitState(requestId);
    const notify = waitState?.speechStartNotifier;
    if (notify) {
      waitState.speechStartNotifier = undefined;
      notify();
      return;
    }

    if (hasPendingWaitResolver(requestId) || waitState) {
      const activeState = waitState ?? getOrCreateRecognitionWaitState(requestId);
      activeState.speechStarted = true;
    }
  };

  const runRecognitionFromAudioBytes = async (params: {
    requestId: string;
    audioBytes: Buffer;
    mimeType?: string;
    requestedModelId?: string;
  }): Promise<void> => {
    if (isRecognitionInFlight(params.requestId) || getCachedRecognitionResult(params.requestId)) {
      return;
    }

    if (!params.audioBytes.length) {
      const payload: RecognitionResultPayload = {
        requestId: params.requestId,
        success: false,
        error: "Recognition audio payload is empty",
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    if (params.audioBytes.byteLength > RECOGNITION_STREAM_MAX_BYTES) {
      const payload: RecognitionResultPayload = {
        requestId: params.requestId,
        success: false,
        error: "Recognition audio payload is too large",
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    if (!asrProvider) {
      const payload: RecognitionResultPayload = {
        requestId: params.requestId,
        success: false,
        error: "No ASR provider is configured on the server",
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    const modelId = params.requestedModelId || config.asr.defaultModelId || "unknown";
    notifyRecognitionCaptureStarted(params.requestId);
    notifyRecognitionSpeechStarted(params.requestId);
    setRecognitionInFlight(params.requestId, true);
    broadcast({
      type: "turn_listen_start",
      turnId: params.requestId,
      providerId: config.asr.provider,
      modelId,
    });

    try {
      const result = await asrProvider.transcribeAudio({
        audioBytes: params.audioBytes,
        mimeType: params.mimeType,
        modelId: params.requestedModelId,
      });

      if (getCachedRecognitionResult(params.requestId)) {
        return;
      }

      const normalizedText = typeof result.text === "string" ? result.text.trim() : "";
      if (shouldTrackRecognitionWait(params.requestId) && normalizedText.length === 0) {
        const payload: RecognitionResultPayload = {
          requestId: params.requestId,
          success: false,
          error: "empty_transcript",
          retryable: true,
          providerId: result.providerId,
          modelId: result.modelId,
          durationMs: result.durationMs,
        };

        broadcastTurnListenResult(payload);
        return;
      }

      const payload: RecognitionResultPayload = {
        requestId: params.requestId,
        success: true,
        text: normalizedText,
        providerId: result.providerId,
        modelId: result.modelId,
        durationMs: result.durationMs,
      };

      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
    } catch (error) {
      if (getCachedRecognitionResult(params.requestId)) {
        return;
      }

      const errorMessage = normalizeErrorMessage(error);
      if (shouldTrackRecognitionWait(params.requestId) && isNoUsableSpeechError(errorMessage)) {
        const payload: RecognitionResultPayload = {
          requestId: params.requestId,
          success: false,
          error: "no_usable_speech",
          retryable: true,
          providerId: config.asr.provider,
          modelId,
          durationMs: 0,
        };

        broadcastTurnListenResult(payload);
        return;
      }

      const payload: RecognitionResultPayload = {
        requestId: params.requestId,
        success: false,
        error: errorMessage,
        providerId: config.asr.provider,
        modelId,
        durationMs: 0,
      };

      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
    } finally {
      setRecognitionInFlight(params.requestId, false);
    }
  };

  const finishRecognitionStreamSession = async (
    requestId: string,
    reason: TurnListenStopMessage["reason"],
  ): Promise<void> => {
    const session = getRecognitionStreamSession(requestId);
    if (!session || session.finalizing) {
      return;
    }

    session.finalizing = true;
    clearRecognitionStreamSession(requestId);

    sendJson(session.socket, {
      type: "turn_listen_stop",
      turnId: requestId,
      reason,
    });

    const speechWindowMs =
      session.speechStartedAtMs === null
        ? 0
        : Math.max(0, session.lastSpeechAtMs - session.speechStartedAtMs);
    if (!session.sawSpeech || speechWindowMs < RECOGNITION_STREAM_MIN_SPEECH_MS) {
      if (shouldTrackRecognitionWait(requestId)) {
        const payload: RecognitionResultPayload = {
          requestId,
          success: false,
          error: "no_usable_speech",
          retryable: true,
          providerId: config.asr.provider,
          modelId: session.modelId || config.asr.defaultModelId || "unknown",
          durationMs: 0,
        };
        broadcastTurnListenResult(payload);
        return;
      }

      const payload: RecognitionResultPayload = {
        requestId,
        success: false,
        error: "No usable speech detected in captured stream",
        providerId: config.asr.provider,
        modelId: session.modelId || config.asr.defaultModelId || "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    const pcmBytes = Buffer.concat(session.chunks);
    const wavBytes = encodePcm16Wav(pcmBytes, session.sampleRate, session.channels);

    await runRecognitionFromAudioBytes({
      requestId,
      audioBytes: wavBytes,
      mimeType: "audio/wav",
      requestedModelId: session.modelId,
    });
  };

  const tryResolveCompletionTimeoutWithCapturedSpeech = async (
    requestId: string,
  ): Promise<RecognitionResultPayload | null> => {
    const session = getRecognitionStreamSession(requestId);
    if (!session || session.finalizing) {
      return null;
    }

    session.finalizing = true;
    clearRecognitionStreamSession(requestId);
    sendJson(session.socket, {
      type: "turn_listen_stop",
      turnId: requestId,
      reason: "max_duration",
    });

    const speechWindowMs =
      session.speechStartedAtMs === null
        ? 0
        : Math.max(0, session.lastSpeechAtMs - session.speechStartedAtMs);
    if (!session.sawSpeech || speechWindowMs < RECOGNITION_STREAM_MIN_SPEECH_MS) {
      return null;
    }

    if (!asrProvider) {
      return null;
    }

    const pcmBytes = Buffer.concat(session.chunks);
    if (pcmBytes.byteLength <= 0) {
      return null;
    }

    const wavBytes = encodePcm16Wav(pcmBytes, session.sampleRate, session.channels);
    const modelId = session.modelId || config.asr.defaultModelId || "unknown";

    try {
      const result = await asrProvider.transcribeAudio({
        audioBytes: wavBytes,
        mimeType: "audio/wav",
        modelId: session.modelId,
      });
      const normalizedText = typeof result.text === "string" ? result.text.trim() : "";
      if (normalizedText.length === 0) {
        return null;
      }

      return {
        requestId,
        success: true,
        text: normalizedText,
        timeoutFallbackUsed: true,
        providerId: result.providerId,
        modelId: result.modelId,
        durationMs: result.durationMs,
      };
    } catch (error) {
      const errorMessage = normalizeErrorMessage(error);
      if (isNoUsableSpeechError(errorMessage)) {
        return null;
      }

      return {
        requestId,
        success: false,
        error: errorMessage,
        timeoutFallbackUsed: true,
        providerId: config.asr.provider,
        modelId,
        durationMs: 0,
      };
    }
  };

  const runDirectSttFromAudioBytes = async (
    context: DirectMediaSttContext,
    params: {
      audioBytes: Buffer;
      mimeType?: string;
    },
  ): Promise<void> => {
    if (context.completed) {
      return;
    }

    if (!params.audioBytes.length) {
      completeDirectSttRequest(context, {
        type: "media_stt_result",
        clientId: context.clientId,
        requestId: context.requestId,
        inputMode: context.inputMode,
        success: false,
        error: "Recognition audio payload is empty",
        providerId: config.asr.provider,
        modelId: context.modelId || config.asr.defaultModelId || "unknown",
        durationMs: 0,
      });
      return;
    }

    if (params.audioBytes.byteLength > RECOGNITION_STREAM_MAX_BYTES) {
      completeDirectSttRequest(context, {
        type: "media_stt_result",
        clientId: context.clientId,
        requestId: context.requestId,
        inputMode: context.inputMode,
        success: false,
        error: "Recognition audio payload is too large",
        providerId: config.asr.provider,
        modelId: context.modelId || config.asr.defaultModelId || "unknown",
        durationMs: 0,
      });
      return;
    }

    if (!asrProvider) {
      completeDirectSttRequest(context, {
        type: "media_stt_result",
        clientId: context.clientId,
        requestId: context.requestId,
        inputMode: context.inputMode,
        success: false,
        error: "No ASR provider is configured on the server",
        providerId: config.asr.provider,
        modelId: context.modelId || config.asr.defaultModelId || "unknown",
        durationMs: 0,
      });
      return;
    }

    const resolvedModelId = context.modelId || config.asr.defaultModelId || "unknown";
    sendJson(context.socket, {
      type: "media_stt_started",
      clientId: context.clientId,
      requestId: context.requestId,
      inputMode: context.inputMode,
      providerId: config.asr.provider,
      modelId: resolvedModelId,
    });

    try {
      const result = await asrProvider.transcribeAudio({
        audioBytes: params.audioBytes,
        mimeType: params.mimeType,
        modelId: context.modelId,
      });

      if (context.completed) {
        return;
      }

      const normalizedText = typeof result.text === "string" ? result.text.trim() : "";
      if (normalizedText.length === 0) {
        completeDirectSttRequest(context, {
          type: "media_stt_result",
          clientId: context.clientId,
          requestId: context.requestId,
          inputMode: context.inputMode,
          success: false,
          error: "empty_transcript",
          retryable: true,
          providerId: result.providerId,
          modelId: result.modelId,
          durationMs: result.durationMs,
        });
        return;
      }

      completeDirectSttRequest(context, {
        type: "media_stt_result",
        clientId: context.clientId,
        requestId: context.requestId,
        inputMode: context.inputMode,
        success: true,
        text: normalizedText,
        providerId: result.providerId,
        modelId: result.modelId,
        durationMs: result.durationMs,
      });
    } catch (error) {
      if (context.completed) {
        return;
      }

      const errorMessage = normalizeErrorMessage(error);
      if (isNoUsableSpeechError(errorMessage)) {
        completeDirectSttRequest(context, {
          type: "media_stt_result",
          clientId: context.clientId,
          requestId: context.requestId,
          inputMode: context.inputMode,
          success: false,
          error: "no_usable_speech",
          retryable: true,
          providerId: config.asr.provider,
          modelId: resolvedModelId,
          durationMs: 0,
        });
        return;
      }

      completeDirectSttRequest(context, {
        type: "media_stt_result",
        clientId: context.clientId,
        requestId: context.requestId,
        inputMode: context.inputMode,
        success: false,
        error: errorMessage,
        providerId: config.asr.provider,
        modelId: resolvedModelId,
        durationMs: 0,
      });
    }
  };

  const finishDirectSttStream = async (
    requestId: string,
    reason: DirectMediaSttStopReason,
  ): Promise<void> => {
    const context = activeDirectSttByRequestId.get(requestId);
    if (!context || context.completed || context.finalizing) {
      return;
    }

    context.finalizing = true;
    emitDirectSttStopped(context, reason);

    const pcmChunks = context.chunks;
    context.chunks = [];
    context.totalBytes = 0;
    const pcmBytes = Buffer.concat(pcmChunks);
    if (pcmBytes.byteLength <= 0) {
      completeDirectSttRequest(context, {
        type: "media_stt_result",
        clientId: context.clientId,
        requestId: context.requestId,
        inputMode: context.inputMode,
        success: false,
        error: "no_usable_speech",
        retryable: true,
        providerId: config.asr.provider,
        modelId: context.modelId || config.asr.defaultModelId || "unknown",
        durationMs: 0,
      });
      return;
    }

    const wavBytes = encodePcm16Wav(pcmBytes, context.sampleRate, context.channels);

    await runDirectSttFromAudioBytes(context, {
      audioBytes: wavBytes,
      mimeType: "audio/wav",
    });
  };

  const processRecognitionStreamStart = (
    socket: WebSocket,
    message: TurnListenStreamStartInboundMessage,
  ): void => {
    const requestId = typeof message.turnId === "string" ? message.turnId.trim() : "";
    if (!requestId) {
      return;
    }
    const expectedOwnerSocket = getTurnOwnerSocket(requestId);
    if (expectedOwnerSocket && expectedOwnerSocket !== socket) {
      return;
    }

    if (!asrProvider) {
      const payload: RecognitionResultPayload = {
        requestId,
        success: false,
        error: "No ASR provider is configured on the server",
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    if (isRecognitionInFlight(requestId) || getCachedRecognitionResult(requestId)) {
      return;
    }

    const existing = getRecognitionStreamSession(requestId);
    if (existing && !existing.finalizing) {
      return;
    }

    const sampleRate = parsePositiveIntFromUnknown(message.sampleRate, 48_000);
    const channels = parsePositiveIntFromUnknown(message.channels, 1);
    const timing = getTurnRecognitionTimingSettings(requestId) ?? {
      startTimeoutMs: runtimeSettings.asrListenStartTimeoutMs,
      completionTimeoutMs: runtimeSettings.asrListenCompletionTimeoutMs,
      endSilenceMs: runtimeSettings.asrRecognitionEndSilenceMs,
    };
    const encoding = typeof message.encoding === "string" ? message.encoding.trim() : "pcm_s16le";
    if (encoding !== "pcm_s16le") {
      const payload: RecognitionResultPayload = {
        requestId,
        success: false,
        error: `Unsupported recognition stream encoding: ${encoding}`,
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    setRecognitionStreamSession(requestId, {
      requestId,
      socket,
      modelId:
        typeof message.modelId === "string" && message.modelId.trim().length > 0
          ? message.modelId.trim()
          : undefined,
      timing,
      sampleRate,
      channels: Math.max(1, Math.min(2, channels)),
      startedAtMs: Date.now(),
      sawSpeech: false,
      speechStartedAtMs: null,
      lastSpeechAtMs: 0,
      totalBytes: 0,
      chunks: [],
      finalizing: false,
    });
    notifyRecognitionCaptureStarted(requestId);
  };

  const processRecognitionStreamChunk = async (
    socket: WebSocket,
    message: TurnListenStreamChunkInboundMessage,
  ): Promise<void> => {
    const requestId = typeof message.turnId === "string" ? message.turnId.trim() : "";
    if (!requestId) {
      return;
    }

    const session = getRecognitionStreamSession(requestId);
    if (!session || session.finalizing) {
      return;
    }
    if (session.socket !== socket) {
      return;
    }

    const chunkBase64 = typeof message.chunkBase64 === "string" ? message.chunkBase64 : "";
    if (!chunkBase64) {
      return;
    }

    let chunk: Buffer;
    try {
      chunk = Buffer.from(chunkBase64, "base64");
    } catch {
      return;
    }

    if (!chunk.length) {
      return;
    }

    const usableLength = chunk.length - (chunk.length % 2);
    if (usableLength <= 0) {
      return;
    }

    const usableChunk = usableLength === chunk.length ? chunk : chunk.subarray(0, usableLength);
    session.chunks.push(usableChunk);
    session.totalBytes += usableChunk.byteLength;

    const now = Date.now();
    const rms = computeRmsPcm16le(usableChunk);
    if (rms >= RECOGNITION_STREAM_RMS_THRESHOLD) {
      const wasSpeechActive = session.sawSpeech;
      session.sawSpeech = true;
      session.lastSpeechAtMs = now;
      if (session.speechStartedAtMs === null) {
        session.speechStartedAtMs = now;
      }
      if (!wasSpeechActive) {
        notifyRecognitionSpeechStarted(requestId);
      }
    }

    if (session.totalBytes > RECOGNITION_STREAM_MAX_BYTES) {
      await finishRecognitionStreamSession(requestId, "max_bytes");
      return;
    }

    if (!session.sawSpeech && now - session.startedAtMs >= session.timing.startTimeoutMs) {
      await finishRecognitionStreamSession(requestId, "max_duration");
      return;
    }

    if (
      session.sawSpeech &&
      session.speechStartedAtMs !== null &&
      now - session.speechStartedAtMs >= session.timing.completionTimeoutMs
    ) {
      await finishRecognitionStreamSession(requestId, "max_duration");
      return;
    }

    if (
      session.sawSpeech &&
      session.lastSpeechAtMs > 0 &&
      now - session.lastSpeechAtMs >= session.timing.endSilenceMs
    ) {
      await finishRecognitionStreamSession(requestId, "silence");
    }
  };

  const processRecognitionStreamEnd = async (
    socket: WebSocket,
    message: TurnListenStreamEndInboundMessage,
  ): Promise<void> => {
    const requestId = typeof message.turnId === "string" ? message.turnId.trim() : "";
    if (!requestId) {
      return;
    }
    const session = getRecognitionStreamSession(requestId);
    if (session && session.socket !== socket) {
      return;
    }
    await finishRecognitionStreamSession(requestId, "client_end");
  };

  const processRecognitionRequest = async (
    socket: WebSocket,
    message: TurnListenBlobInboundMessage,
  ): Promise<void> => {
    const requestId = typeof message.turnId === "string" ? message.turnId.trim() : "";
    if (!requestId) {
      return;
    }
    const expectedOwnerSocket = getTurnOwnerSocket(requestId);
    if (expectedOwnerSocket && expectedOwnerSocket !== socket) {
      return;
    }

    const audioBase64 = typeof message.audioBase64 === "string" ? message.audioBase64 : "";
    if (!audioBase64) {
      const payload: RecognitionResultPayload = {
        requestId,
        success: false,
        error: "Recognition request missing audio payload",
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    let audioBytes: Buffer;
    try {
      audioBytes = Buffer.from(audioBase64, "base64");
    } catch {
      const payload: RecognitionResultPayload = {
        requestId,
        success: false,
        error: "Recognition audio payload is not valid base64",
        providerId: config.asr.provider,
        modelId: config.asr.defaultModelId ?? "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
      return;
    }

    const requestedModelId = typeof message.modelId === "string" ? message.modelId.trim() : "";
    notifyRecognitionCaptureStarted(requestId);
    await runRecognitionFromAudioBytes({
      requestId,
      audioBytes,
      mimeType: typeof message.mimeType === "string" ? message.mimeType : undefined,
      requestedModelId: requestedModelId || undefined,
    });
  };

  const processMediaSttStart = (socket: WebSocket, message: MediaSttStartInboundMessage): void => {
    const client = clients.get(socket);
    const clientId = getClientIdForSocket(socket) ?? "";
    const requestId = typeof message.requestId === "string" ? message.requestId.trim() : "";
    const requestedModelId =
      typeof message.modelId === "string" && message.modelId.trim().length > 0
        ? message.modelId.trim()
        : undefined;

    if (!requestId || !clientId) {
      return;
    }

    if (!client || !getVoiceClientCapabilities(client).directSttEnabled) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "Client does not advertise direct STT support",
      });
      return;
    }

    if (!asrProvider) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "Direct STT requires ASR_PROVIDER to be configured",
      });
      return;
    }

    if (activeDirectSttByClientId.has(clientId)) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "Client already has an active direct STT request",
      });
      return;
    }

    if (activeDirectSttByRequestId.has(requestId)) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "Direct STT requestId is already active",
      });
      return;
    }

    const encoding = typeof message.encoding === "string" ? message.encoding.trim() : "pcm_s16le";
    if (encoding !== "pcm_s16le") {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: `Unsupported direct STT stream encoding: ${encoding}`,
      });
      return;
    }

    const startTimeoutMs = parseOptionalPositiveIntOverride(message.startTimeoutMs);
    if (message.startTimeoutMs !== undefined && startTimeoutMs === undefined) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "startTimeoutMs must be a positive integer",
      });
      return;
    }
    const completionTimeoutMs = parseOptionalPositiveIntOverride(message.completionTimeoutMs);
    if (message.completionTimeoutMs !== undefined && completionTimeoutMs === undefined) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "completionTimeoutMs must be a positive integer",
      });
      return;
    }
    const endSilenceMs = parseOptionalPositiveIntOverride(message.endSilenceMs);
    if (message.endSilenceMs !== undefined && endSilenceMs === undefined) {
      sendDirectSttImmediateFailure({
        socket,
        clientId,
        requestId,
        inputMode: "stream",
        modelId: requestedModelId,
        error: "endSilenceMs must be a positive integer",
      });
      return;
    }

    const context: DirectMediaSttContext = {
      clientId,
      socket,
      requestId,
      inputMode: "stream",
      modelId: requestedModelId,
      timing: {
        startTimeoutMs: startTimeoutMs ?? runtimeSettings.asrListenStartTimeoutMs,
        completionTimeoutMs: completionTimeoutMs ?? runtimeSettings.asrListenCompletionTimeoutMs,
        endSilenceMs: endSilenceMs ?? runtimeSettings.asrRecognitionEndSilenceMs,
      },
      sampleRate: parsePositiveIntFromUnknown(message.sampleRate, 48_000),
      channels: Math.max(1, Math.min(2, parsePositiveIntFromUnknown(message.channels, 1))),
      startedAtMs: Date.now(),
      sawSpeech: false,
      speechStartedAtMs: null,
      lastSpeechAtMs: 0,
      totalBytes: 0,
      chunks: [],
      finalizing: false,
      completed: false,
    };
    activeDirectSttByClientId.set(clientId, context);
    activeDirectSttByRequestId.set(requestId, context);
    broadcastStatus();
  };

  const processMediaSttChunk = async (
    socket: WebSocket,
    message: MediaSttChunkInboundMessage,
  ): Promise<void> => {
    const requestId = typeof message.requestId === "string" ? message.requestId.trim() : "";
    if (!requestId) {
      return;
    }

    const context = activeDirectSttByRequestId.get(requestId);
    if (!context) {
      if (wasRecentlyFinishedDirectSttRequest(requestId, socket)) {
        return;
      }
      sendDirectSttSocketFailure({
        socket,
        requestId,
        error: "Direct STT request not found",
      });
      return;
    }
    if (context.socket !== socket) {
      sendDirectSttSocketFailure({
        socket,
        requestId,
        error: "Direct STT request is owned by a different socket",
      });
      return;
    }
    if (context.completed || context.finalizing) {
      return;
    }

    const chunkBase64 = typeof message.chunkBase64 === "string" ? message.chunkBase64 : "";
    if (!chunkBase64) {
      failDirectSttContext(context, "chunkBase64 is required");
      return;
    }

    const chunk = decodeBase64Strict(chunkBase64);
    if (!chunk) {
      failDirectSttContext(context, "chunkBase64 is not valid base64");
      return;
    }

    if (!chunk.length) {
      failDirectSttContext(context, "chunkBase64 decodes to empty audio");
      return;
    }

    const usableLength = chunk.length - (chunk.length % 2);
    if (usableLength <= 0) {
      failDirectSttContext(context, "Direct STT chunk must contain at least one 16-bit PCM sample");
      return;
    }

    const usableChunk = usableLength === chunk.length ? chunk : chunk.subarray(0, usableLength);
    context.chunks.push(usableChunk);
    context.totalBytes += usableChunk.byteLength;

    const now = Date.now();
    const rms = computeRmsPcm16le(usableChunk);
    if (rms >= RECOGNITION_STREAM_RMS_THRESHOLD) {
      context.sawSpeech = true;
      context.lastSpeechAtMs = now;
      if (context.speechStartedAtMs === null) {
        context.speechStartedAtMs = now;
      }
    }

    if (context.totalBytes > RECOGNITION_STREAM_MAX_BYTES) {
      await finishDirectSttStream(requestId, "max_bytes");
      return;
    }

    if (!context.sawSpeech && now - context.startedAtMs >= context.timing.startTimeoutMs) {
      await finishDirectSttStream(requestId, "max_duration");
      return;
    }

    if (
      context.sawSpeech &&
      context.speechStartedAtMs !== null &&
      now - context.speechStartedAtMs >= context.timing.completionTimeoutMs
    ) {
      await finishDirectSttStream(requestId, "max_duration");
      return;
    }

    if (
      context.sawSpeech &&
      context.lastSpeechAtMs > 0 &&
      now - context.lastSpeechAtMs >= context.timing.endSilenceMs
    ) {
      await finishDirectSttStream(requestId, "silence");
    }
  };

  const processMediaSttEnd = async (socket: WebSocket, message: MediaSttEndInboundMessage) => {
    const requestId = typeof message.requestId === "string" ? message.requestId.trim() : "";
    if (!requestId) {
      return;
    }
    const context = activeDirectSttByRequestId.get(requestId);
    if (!context) {
      if (wasRecentlyFinishedDirectSttRequest(requestId, socket)) {
        return;
      }
      sendDirectSttSocketFailure({
        socket,
        requestId,
        error: "Direct STT request not found",
      });
      return;
    }
    if (context.socket !== socket) {
      sendDirectSttSocketFailure({
        socket,
        requestId,
        error: "Direct STT request is owned by a different socket",
      });
      return;
    }
    if (context.completed || context.finalizing) {
      return;
    }
    await finishDirectSttStream(requestId, "client_end");
  };

  const processMediaSttCancel = (socket: WebSocket, requestIdRaw: unknown): void => {
    const requestId = typeof requestIdRaw === "string" ? requestIdRaw.trim() : "";
    if (!requestId) {
      return;
    }
    const context = activeDirectSttByRequestId.get(requestId);
    if (!context) {
      if (wasRecentlyFinishedDirectSttRequest(requestId, socket)) {
        return;
      }
      sendDirectSttSocketFailure({
        socket,
        requestId,
        error: "Direct STT request not found",
      });
      return;
    }
    if (context.socket !== socket) {
      sendDirectSttSocketFailure({
        socket,
        requestId,
        error: "Direct STT request is owned by a different socket",
      });
      return;
    }
    if (context.completed || context.finalizing) {
      return;
    }
    cancelDirectSttContext(context, "client_cancel", "client_cancel");
  };

  const getDirectSttHttpStatusCode = (result: MediaSttResultMessage): number => {
    if (result.success) {
      return 200;
    }
    if (result.canceled) {
      return 409;
    }
    if (typeof result.error === "string" && result.error.includes("timed out")) {
      return 504;
    }
    return 502;
  };

  const cleanupRecognitionSessionsForSocket = (socket: WebSocket): void => {
    for (const [requestId, context] of turnContexts.entries()) {
      const session = context.recognitionStreamSession;
      if (!session) {
        continue;
      }
      if (session.socket !== socket || session.finalizing) {
        continue;
      }
      session.finalizing = true;
      clearRecognitionStreamSession(requestId);
      const payload: RecognitionResultPayload = {
        requestId,
        success: false,
        error: "Recognition stream socket closed before completion",
        providerId: config.asr.provider,
        modelId: session.modelId || config.asr.defaultModelId || "unknown",
        durationMs: 0,
      };
      broadcastTurnListenResult(payload);
      resolvePendingRecognition(payload);
    }
  };

  const cancelOwnedTurnsForSocket = (socket: WebSocket): void => {
    const ownedRequestIds: string[] = [];
    for (const [requestId, context] of turnContexts.entries()) {
      if (context.ownerSocket === socket) {
        ownedRequestIds.push(requestId);
      }
    }

    for (const requestId of ownedRequestIds) {
      cancelSpeakRequest(requestId, TURN_OWNER_SOCKET_CLOSED_ERROR);
    }
  };

  const cancelDirectRequestsForSocket = (socket: WebSocket): void => {
    const clientId = getClientIdForSocket(socket);
    if (!clientId) {
      return;
    }

    const directTtsContext = activeDirectTtsByClientId.get(clientId);
    if (directTtsContext && directTtsContext.socket === socket) {
      directTtsContext.abortController.abort("client_disconnect");
      clearDirectTtsContext(clientId);
    }

    const directSttContext = activeDirectSttByClientId.get(clientId);
    if (directSttContext && directSttContext.socket === socket) {
      cancelDirectSttContext(directSttContext, "client_disconnect", "socket_closed");
    }
  };

  const teardownDisconnectedSocket = (
    socket: WebSocket,
    disconnectReason: {
      noRemainingReason: string;
    },
  ): void => {
    cancelDirectRequestsForSocket(socket);
    cleanupRecognitionSessionsForSocket(socket);
    cancelOwnedTurnsForSocket(socket);
    const clientId = getClientIdForSocket(socket);
    if (clientId) {
      socketsByClientId.delete(clientId);
    }
    clients.delete(socket);
    clientDebugIds.delete(socket);
    clientIds.delete(socket);
    if (activeClientSocket !== socket) {
      return;
    }
    setActiveClientSocket(null, disconnectReason.noRemainingReason);
  };

  const hasActiveRecognitionTracking = (requestId: string): boolean =>
    hasRecognitionWaitState(requestId) ||
    isRecognitionInFlight(requestId) ||
    getRecognitionStreamSession(requestId) != null;

  const processTurnListenQuickReply = (
    socket: WebSocket,
    message: TurnListenQuickReplyInboundMessage,
  ): void => {
    const requestId = typeof message.turnId === "string" ? message.turnId.trim() : "";
    if (!requestId) {
      return;
    }
    const quickReplyText = typeof message.text === "string" ? message.text.trim() : "";
    if (!quickReplyText) {
      return;
    }
    const quickReplyId =
      typeof message.quickReplyId === "string" && message.quickReplyId.trim().length > 0
        ? message.quickReplyId.trim()
        : undefined;

    const ownerSocket = getTurnOwnerSocket(requestId);
    if (ownerSocket && ownerSocket !== socket) {
      logInfo("[agent-voice-adapter] turn_listen_quick_reply_ignored_non_owner", {
        requestId,
        quickReplyId: quickReplyId ?? null,
        owner: describeClient(ownerSocket),
        sender: describeClient(socket),
      });
      return;
    }

    if (getCachedRecognitionResult(requestId)) {
      return;
    }

    const quickReplyContext = getTurnQuickReplyContext(requestId);
    let matchedQuickReply: TurnQuickReply | undefined;
    if (quickReplyContext?.quickReplies.length) {
      matchedQuickReply = quickReplyContext.quickReplies.find((entry) => {
        if (quickReplyId && entry.id) {
          return entry.id === quickReplyId;
        }
        return entry.text === quickReplyText || entry.label === quickReplyText;
      });
      if (!matchedQuickReply) {
        logInfo("[agent-voice-adapter] turn_listen_quick_reply_ignored_unknown_option", {
          requestId,
          quickReplyId: quickReplyId ?? null,
          sender: describeClient(socket),
        });
        return;
      }
    }
    const resolvedQuickReplyText = matchedQuickReply?.text ?? quickReplyText;

    const hasActiveListenFlow =
      hasPendingWaitResolver(requestId) || hasActiveRecognitionTracking(requestId);
    const hasActiveTurnFlow = hasCancelableTurnRequest(requestId);
    const hasDeferredNoWaitContext = quickReplyContext?.waitForRecognition === false;
    if (!hasActiveListenFlow && !hasActiveTurnFlow && !hasDeferredNoWaitContext) {
      logInfo("[agent-voice-adapter] turn_listen_quick_reply_ignored_no_active_turn", {
        requestId,
        quickReplyId: quickReplyId ?? null,
        sender: describeClient(socket),
      });
      return;
    }

    const session = getRecognitionStreamSession(requestId);
    if (session && !session.finalizing) {
      session.finalizing = true;
      clearRecognitionStreamSession(requestId);
      sendJson(session.socket, {
        type: "turn_listen_stop",
        turnId: requestId,
        reason: "client_end",
      });
    }

    // Quick replies should behave like an immediate local "stop TTS + answer".
    // If playback is still active, abort upstream TTS generation now.
    const cancellationController = getTurnCancellationController(requestId);
    if (
      isTurnTtsActive(requestId) &&
      cancellationController &&
      !cancellationController.signal.aborted
    ) {
      cancellationController.abort(REQUEST_STOP_TTS_ERROR);
    }

    setRecognitionInFlight(requestId, false);
    clearTurnQuickReplyContext(requestId);

    const payload: RecognitionResultPayload = {
      requestId,
      success: true,
      text: resolvedQuickReplyText,
      providerId: "quick_reply",
      modelId: "quick_reply",
      durationMs: 0,
    };

    const isDeferredNoWaitTap = !hasActiveListenFlow && hasDeferredNoWaitContext;
    if (
      isDeferredNoWaitTap &&
      quickReplyContext?.sessionId &&
      sessionDispatchService.isConfigured
    ) {
      const contextualMessage = formatDeferredNoWaitQuickReplyMessage({
        assistantText: quickReplyContext.assistantText,
        quickReplyText: resolvedQuickReplyText,
      });
      void sessionDispatchService
        .sendMessage({
          sessionId: quickReplyContext.sessionId,
          mode: "custom",
          customMessage: contextualMessage,
        })
        .then(() => {
          logInfo("[agent-voice-adapter] turn_listen_quick_reply_dispatched", {
            requestId,
            sessionId: quickReplyContext.sessionId,
            quickReplyId: quickReplyId ?? null,
          });
        })
        .catch((error) => {
          logError("[agent-voice-adapter] turn_listen_quick_reply_dispatch_failed", {
            requestId,
            sessionId: quickReplyContext.sessionId,
            error: normalizeErrorMessage(error),
          });
        });
    }

    logInfo("[agent-voice-adapter] turn_listen_quick_reply_applied", {
      requestId,
      quickReplyId: quickReplyId ?? null,
      sender: describeClient(socket),
      deferredNoWaitTap: isDeferredNoWaitTap,
    });
    broadcastTurnListenResult(payload);
    if (hasActiveListenFlow) {
      resolvePendingRecognition(payload);
    } else {
      cacheRecognitionResult(payload);
    }
  };

  const cancelRecognitionForRequest = (requestId: string, reason: string): void => {
    if (getCachedRecognitionResult(requestId)) {
      clearRecognitionWaitState(requestId);
      return;
    }

    const session = getRecognitionStreamSession(requestId);
    if (session && !session.finalizing) {
      session.finalizing = true;
      clearRecognitionStreamSession(requestId);
      sendJson(session.socket, {
        type: "turn_listen_stop",
        turnId: requestId,
        reason: "client_end",
      });
    }

    const payload: RecognitionResultPayload = {
      requestId,
      success: false,
      error: reason,
      ...resolveTurnListenCancellationMetadata({
        success: false,
        error: reason,
      }),
      providerId: config.asr.provider,
      modelId: session?.modelId || config.asr.defaultModelId || "unknown",
      durationMs: 0,
    };
    broadcastTurnListenResult(payload);
    resolvePendingRecognition(payload);
  };

  const cancelSpeakRequest = (requestId: string, reason: string): void => {
    clearTurnOwnerSocket(requestId);
    clearTurnQuickReplyContext(requestId);
    const cancellationController = getTurnCancellationController(requestId);
    if (cancellationController && !cancellationController.signal.aborted) {
      cancellationController.abort(reason);
    }

    const removedQueuedJob = removeByRequestId(state.queue, requestId);
    if (removedQueuedJob) {
      resolvePendingWaitSpeakError(requestId, reason);
      clearRecognitionWaitState(requestId);
      clearTurnCancellationController(requestId);
      broadcastStatus();
      void processSpeakQueue();
      return;
    }

    if (hasActiveRecognitionTracking(requestId)) {
      cancelRecognitionForRequest(requestId, reason);
    }
  };

  const hasCancelableTurnRequest = (requestId: string): boolean =>
    state.queue.some((entry) => entry.requestId === requestId) ||
    getTurnCancellationController(requestId) != null ||
    hasPendingWaitResolver(requestId) ||
    hasActiveRecognitionTracking(requestId);

  const waitForRecognitionResult = async (
    requestId: string,
    startTimeoutMs: number,
    completionTimeoutMs: number,
    cancellationSignal?: AbortSignal,
  ): Promise<RecognitionResultPayload> => {
    const cached = getCachedRecognitionResult(requestId);
    if (cached) {
      return cached;
    }

    if (cancellationSignal?.aborted) {
      const cancellationReason =
        typeof cancellationSignal.reason === "string" && cancellationSignal.reason.trim().length > 0
          ? cancellationSignal.reason
          : REQUEST_DISCONNECTED_ERROR;
      cancelRecognitionForRequest(requestId, cancellationReason);
      return (
        getCachedRecognitionResult(requestId) ?? {
          requestId,
          success: false,
          error: cancellationReason,
          ...resolveTurnListenCancellationMetadata({
            success: false,
            error: cancellationReason,
          }),
          providerId: config.asr.provider,
          modelId: config.asr.defaultModelId ?? "unknown",
          durationMs: 0,
        }
      );
    }

    return new Promise<RecognitionResultPayload>((resolve) => {
      const waitState = getOrCreateRecognitionWaitState(requestId);
      clearRecognitionWaitStateResources(waitState);
      let settled = false;
      const captureStartTimeoutMs = Math.max(startTimeoutMs, completionTimeoutMs);

      const clearCaptureStartTimeout = (): void => {
        if (!waitState.captureStartTimeoutHandle) {
          return;
        }
        clearTimeout(waitState.captureStartTimeoutHandle);
        waitState.captureStartTimeoutHandle = undefined;
      };

      const handleCancellation = (): void => {
        const cancellationReason =
          typeof cancellationSignal?.reason === "string" &&
          cancellationSignal.reason.trim().length > 0
            ? cancellationSignal.reason
            : REQUEST_DISCONNECTED_ERROR;
        cancelRecognitionForRequest(requestId, cancellationReason);
      };

      const cleanupWaitState = (): void => {
        clearRecognitionWaitState(requestId);
      };

      const settle = (payload: RecognitionResultPayload): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupWaitState();
        resolve(payload);
      };

      const armStartTimeout = (): void => {
        clearCaptureStartTimeout();
        if (settled || waitState.startTimeoutHandle) {
          return;
        }

        waitState.startTimeoutHandle = setTimeout(() => {
          settle({
            requestId,
            success: false,
            error: `Recognition start timed out after ${startTimeoutMs}ms`,
            providerId: config.asr.provider,
            modelId: config.asr.defaultModelId ?? "unknown",
            durationMs: 0,
          });
        }, startTimeoutMs);
        waitState.startTimeoutHandle.unref?.();
      };

      const armCompletionTimeout = (): void => {
        if (settled || waitState.completionTimeoutHandle) {
          return;
        }

        if (!waitState.startTimeoutHandle) {
          armStartTimeout();
        }
        if (waitState.startTimeoutHandle) {
          clearTimeout(waitState.startTimeoutHandle);
          waitState.startTimeoutHandle = undefined;
        }
        waitState.completionTimeoutHandle = setTimeout(() => {
          void (async () => {
            try {
              const timeoutFallback =
                await tryResolveCompletionTimeoutWithCapturedSpeech(requestId);
              if (settled) {
                return;
              }

              const payload =
                timeoutFallback ??
                ({
                  requestId,
                  success: false,
                  error: `Recognition completion timed out after ${completionTimeoutMs}ms`,
                  providerId: config.asr.provider,
                  modelId: config.asr.defaultModelId ?? "unknown",
                  durationMs: 0,
                } satisfies RecognitionResultPayload);
              cacheRecognitionResult(payload);
              broadcastTurnListenResult(payload);
              settle(payload);
            } catch (error) {
              const payload: RecognitionResultPayload = {
                requestId,
                success: false,
                error: normalizeErrorMessage(error),
                providerId: config.asr.provider,
                modelId: config.asr.defaultModelId ?? "unknown",
                durationMs: 0,
              };
              cacheRecognitionResult(payload);
              broadcastTurnListenResult(payload);
              settle(payload);
            }
          })();
        }, completionTimeoutMs);
        waitState.completionTimeoutHandle.unref?.();
      };

      waitState.captureStartNotifier = armStartTimeout;
      waitState.speechStartNotifier = armCompletionTimeout;
      waitState.resolver = (payload) => {
        settle(payload);
      };

      waitState.cancellationSignal = cancellationSignal;
      waitState.cancellationAbortHandler = handleCancellation;
      cancellationSignal?.addEventListener("abort", handleCancellation, { once: true });

      waitState.captureStartTimeoutHandle = setTimeout(() => {
        settle({
          requestId,
          success: false,
          error: `Recognition capture start timed out after ${captureStartTimeoutMs}ms`,
          providerId: config.asr.provider,
          modelId: config.asr.defaultModelId ?? "unknown",
          durationMs: 0,
        });
      }, captureStartTimeoutMs);
      waitState.captureStartTimeoutHandle.unref?.();

      if (waitState.captureStarted) {
        waitState.captureStarted = false;
        armStartTimeout();
      }
      if (waitState.speechStarted) {
        waitState.speechStarted = false;
        armCompletionTimeout();
      }
    });
  };

  const processSpeakQueue = async (): Promise<void> => {
    if (state.processing) {
      return;
    }

    state.processing = true;
    broadcastStatus();

    try {
      while (state.queue.length > 0) {
        const nextJob = state.queue[0];
        if (!nextJob) {
          break;
        }

        if (nextJob.cancellationSignal?.aborted) {
          dequeueNext(state.queue);
          const cancellationReason =
            typeof nextJob.cancellationSignal.reason === "string" &&
            nextJob.cancellationSignal.reason.trim().length > 0
              ? nextJob.cancellationSignal.reason
              : REQUEST_DISCONNECTED_ERROR;

          if (nextJob.waitForRecognition) {
            resolvePendingWaitSpeakError(nextJob.requestId, cancellationReason);
          }
          clearTurnCancellationController(nextJob.requestId);

          broadcastStatus();
          continue;
        }

        const eligibleSockets = getEligibleSocketsForJob(nextJob);
        if (eligibleSockets.length < 1) {
          logInfo("[agent-voice-adapter] dispatch_blocked_no_eligible_client", {
            requestId: nextJob.requestId,
            waitForRecognition: nextJob.waitForRecognition,
            queueLength: state.queue.length,
            activeClient: activeClientSocket ? describeClient(activeClientSocket) : null,
            clients: Array.from(clients.entries()).map(([candidateSocket, candidateState]) => ({
              client: describeClient(candidateSocket),
              acceptingRequests: candidateState.acceptingRequests,
              speechEnabled: candidateState.speechEnabled,
              recognitionEnabled: candidateState.recognitionEnabled,
              inTurn: Boolean(candidateState.inTurn),
            })),
          });
          break;
        }

        const listeningEligibleSockets = eligibleSockets.filter(
          (candidateSocket) => clients.get(candidateSocket)?.recognitionEnabled,
        );
        const targetSocket =
          (listeningEligibleSockets.length === 1 ? listeningEligibleSockets[0] : undefined) ??
          eligibleSockets.find((candidateSocket) => {
            const candidateState = clients.get(candidateSocket);
            return Boolean(candidateState?.speechEnabled && candidateState.recognitionEnabled);
          }) ??
          eligibleSockets.find((candidateSocket) => clients.get(candidateSocket)?.speechEnabled) ??
          eligibleSockets.find(
            (candidateSocket) => clients.get(candidateSocket)?.recognitionEnabled,
          ) ??
          eligibleSockets[0] ??
          null;
        if (!targetSocket) {
          break;
        }

        dequeueNext(state.queue);
        logInfo("[agent-voice-adapter] dispatch_target_selected", {
          requestId: nextJob.requestId,
          waitForRecognition: nextJob.waitForRecognition,
          target: describeClient(targetSocket),
          eligible: eligibleSockets.map((candidateSocket) => {
            const candidateState = clients.get(candidateSocket);
            return {
              client: describeClient(candidateSocket),
              speechEnabled: Boolean(candidateState?.speechEnabled),
              recognitionEnabled: Boolean(candidateState?.recognitionEnabled),
              acceptingRequests: Boolean(candidateState?.acceptingRequests),
              inTurn: Boolean(candidateState?.inTurn),
            };
          }),
        });
        setTurnOwnerSocket(nextJob.requestId, targetSocket);
        if (nextJob.waitForRecognition) {
          setTurnRecognitionTimingSettings(nextJob.requestId, {
            startTimeoutMs: nextJob.recognitionStartTimeoutMs,
            completionTimeoutMs: nextJob.recognitionCompletionTimeoutMs,
            endSilenceMs: nextJob.recognitionEndSilenceMs,
          });
        }

        try {
          const targetState = clients.get(targetSocket);
          const shouldGenerateAudio = Boolean(
            targetState?.acceptingRequests && targetState.speechEnabled,
          );
          const shouldAwaitPlaybackTerminal = !nextJob.waitForRecognition && shouldGenerateAudio;
          const linkedSessionLabel =
            typeof nextJob.sessionId === "string" && nextJob.sessionId.trim().length > 0
              ? await resolveLinkedSessionLabelForTts(nextJob.sessionId)
              : undefined;
          const prefixedText = applyLinkedSessionPrefixToTurnText({
            originalText: nextJob.originalText,
            sanitizedText: nextJob.sanitizedText,
            sessionLabel: linkedSessionLabel,
            prependEnabled: runtimeSettings.prependLinkedSessionLabelForTts,
          });
          const hasLinkedSessionLabel =
            typeof linkedSessionLabel === "string" && linkedSessionLabel.trim().length > 0;
          const effectiveJob =
            prefixedText.prefixed || hasLinkedSessionLabel
              ? {
                  ...nextJob,
                  originalText: prefixedText.originalText,
                  sanitizedText: prefixedText.sanitizedText,
                  ...(hasLinkedSessionLabel ? { sessionTitle: linkedSessionLabel } : {}),
                }
              : nextJob;

          const sendTurnMessage = (message: OutboundMessage): void => {
            sendJson(targetSocket, message);
          };

          setTurnTtsActive(nextJob.requestId, true);
          if (shouldAwaitPlaybackTerminal) {
            setAwaitingPlaybackTerminal(nextJob.requestId, true);
          }
          const result = await processSpeakJob(
            effectiveJob,
            sendTurnMessage,
            broadcast,
            config,
            outputSampleRate,
            shouldGenerateAudio,
            nextJob.cancellationSignal,
          );
          if (nextJob.waitForRecognition || !shouldAwaitPlaybackTerminal || !result.success) {
            setTurnTtsActive(nextJob.requestId, false);
          }

          if (nextJob.waitForRecognition) {
            let waitCompletion: WaitForRecognitionJobCompletion = { speak: result };

            if (result.success) {
              const recognitionResult = await waitForRecognitionResult(
                nextJob.requestId,
                nextJob.recognitionStartTimeoutMs,
                nextJob.recognitionCompletionTimeoutMs,
                nextJob.cancellationSignal,
              );
              waitCompletion = {
                speak: result,
                recognition: recognitionResult,
              };
            }

            resolvePendingWaitCompletion(nextJob.requestId, waitCompletion);

            if (
              result.success &&
              state.queue.length > 0 &&
              runtimeSettings.queueAdvanceDelayMs > 0
            ) {
              await sleep(runtimeSettings.queueAdvanceDelayMs);
            }
          } else if (result.success && shouldAwaitPlaybackTerminal) {
            const playbackTerminal = await waitForPlaybackTerminal(
              nextJob.requestId,
              PLAYBACK_TERMINAL_ACK_TIMEOUT_MS,
              nextJob.cancellationSignal,
            );
            logInfo("[agent-voice-adapter] queue_playback_terminal", {
              requestId: nextJob.requestId,
              status: playbackTerminal.status,
              reason: playbackTerminal.reason ?? null,
              timeoutFallbackUsed: playbackTerminal.timeoutFallbackUsed ?? false,
            });
            setTurnTtsActive(nextJob.requestId, false);
          }
        } finally {
          setAwaitingPlaybackTerminal(nextJob.requestId, false);
          setTurnTtsActive(nextJob.requestId, false);
          clearTurnRecognitionTimingSettings(nextJob.requestId);
          clearTurnOwnerSocket(nextJob.requestId);
          clearTurnCancellationController(nextJob.requestId);
        }

        broadcastStatus();
      }
    } finally {
      state.processing = false;
      broadcastStatus();
    }
  };

  const runWebsocketAsyncTask = (
    requestId: string | null,
    operation: string,
    task: () => Promise<void>,
  ): void => {
    runWebsocketAsyncTaskSafely({
      requestId,
      operation,
      task,
      onRequestError: (failedRequestId, renderedError) => {
        cancelRecognitionForRequest(failedRequestId, renderedError);
      },
    });
  };
  const processTurnPlaybackTerminal = (
    socket: WebSocket,
    message: {
      turnId?: unknown;
      status?: unknown;
      reason?: unknown;
    },
  ): void => {
    const requestId = typeof message.turnId === "string" ? message.turnId.trim() : "";
    if (!requestId) {
      return;
    }
    const ownerSocket = getTurnOwnerSocket(requestId);
    if (ownerSocket !== socket) {
      logInfo("[agent-voice-adapter] playback_terminal_ignored_non_owner", {
        requestId,
        owner: ownerSocket ? describeClient(ownerSocket) : null,
        sender: describeClient(socket),
      });
      return;
    }
    const rawStatus = typeof message.status === "string" ? message.status.trim().toLowerCase() : "";
    if (rawStatus !== "done" && rawStatus !== "aborted") {
      return;
    }
    const reason =
      typeof message.reason === "string" && message.reason.trim().length > 0
        ? message.reason.trim()
        : undefined;
    const resolved = resolvePlaybackTerminal(requestId, {
      status: rawStatus,
      reason,
    });
    logInfo("[agent-voice-adapter] playback_terminal_received", {
      requestId,
      status: rawStatus,
      reason: reason ?? null,
      resolved,
      client: describeClient(socket),
    });
  };

  wsServer.on("connection", (socket, request) => {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    const remotePort = request.socket.remotePort ?? "unknown";
    const clientDebugId = `client-${++clientDebugCounter}@${remoteAddress}:${remotePort}`;
    const clientId = randomUUID();
    clientDebugIds.set(socket, clientDebugId);
    clientIds.set(socket, clientId);
    socketsByClientId.set(clientId, socket);
    clients.set(socket, {
      acceptingRequests: true,
      speechEnabled: true,
      recognitionEnabled: false,
      inTurn: false,
      turnModeEnabled: true,
      directTtsEnabled: false,
      directSttEnabled: false,
    });
    logInfo("[agent-voice-adapter] websocket_client_connected", {
      client: clientDebugId,
      clientId,
    });
    broadcastStatus();
    broadcastActivationState();
    void processSpeakQueue();

    socket.on("message", (raw) => {
      const parsed = parseInboundClientMessage(raw);
      if (!parsed || typeof parsed.type !== "string") {
        return;
      }

      if (isClientStateUpdateMessage(parsed)) {
        const client = clients.get(socket);
        if (!client) {
          return;
        }
        let changed = false;

        if (typeof parsed.acceptingTurns === "boolean") {
          if (client.acceptingRequests !== parsed.acceptingTurns) {
            client.acceptingRequests = parsed.acceptingTurns;
            changed = true;
          }
        }

        if (typeof parsed.speechEnabled === "boolean") {
          if (client.speechEnabled !== parsed.speechEnabled) {
            client.speechEnabled = parsed.speechEnabled;
            changed = true;
          }
        }

        if (typeof parsed.listeningEnabled === "boolean") {
          if (client.recognitionEnabled !== parsed.listeningEnabled) {
            client.recognitionEnabled = parsed.listeningEnabled;
            changed = true;
          }
        }

        if (typeof parsed.inTurn === "boolean") {
          if (Boolean(client.inTurn) !== parsed.inTurn) {
            client.inTurn = parsed.inTurn;
            changed = true;
          }
        }

        if (typeof parsed.turnModeEnabled === "boolean") {
          if (getVoiceClientCapabilities(client).turnModeEnabled !== parsed.turnModeEnabled) {
            client.turnModeEnabled = parsed.turnModeEnabled;
            changed = true;
          }
        }

        if (typeof parsed.directTtsEnabled === "boolean") {
          if (getVoiceClientCapabilities(client).directTtsEnabled !== parsed.directTtsEnabled) {
            client.directTtsEnabled = parsed.directTtsEnabled;
            changed = true;
          }
        }

        if (typeof parsed.directSttEnabled === "boolean") {
          if (getVoiceClientCapabilities(client).directSttEnabled !== parsed.directSttEnabled) {
            client.directSttEnabled = parsed.directSttEnabled;
            changed = true;
          }
        }

        if (!changed) {
          return;
        }

        const capabilities = getVoiceClientCapabilities(client);

        logInfo("[agent-voice-adapter] websocket_client_state_update", {
          client: describeClient(socket),
          clientId: getClientIdForSocket(socket) ?? null,
          acceptingRequests: client.acceptingRequests,
          speechEnabled: client.speechEnabled,
          recognitionEnabled: client.recognitionEnabled,
          inTurn: Boolean(client.inTurn),
          turnModeEnabled: capabilities.turnModeEnabled,
          directTtsEnabled: capabilities.directTtsEnabled,
          directSttEnabled: capabilities.directSttEnabled,
        });

        broadcastStatus();
        void processSpeakQueue();
        return;
      }

      if (isClientPingMessage(parsed)) {
        sendJson(socket, createPongMessage(parsed));
        return;
      }

      if (isClientActivateMessage(parsed)) {
        setActiveClientSocket(socket, "client_activate_message");
        return;
      }

      if (isClientDeactivateMessage(parsed)) {
        if (activeClientSocket === socket) {
          setActiveClientSocket(null, "client_deactivate_message");
        }
        return;
      }

      if (isTurnPlaybackTerminalMessage(parsed)) {
        processTurnPlaybackTerminal(socket, parsed);
        return;
      }

      if (isTurnListenQuickReplyMessage(parsed)) {
        processTurnListenQuickReply(socket, parsed);
        return;
      }

      if (isTurnListenBlobMessage(parsed)) {
        const requestId = typeof parsed.turnId === "string" ? parsed.turnId.trim() : null;
        runWebsocketAsyncTask(requestId, "turn_listen_blob", () =>
          processRecognitionRequest(socket, parsed),
        );
        return;
      }

      if (isTurnListenStreamStartMessage(parsed)) {
        processRecognitionStreamStart(socket, parsed);
        return;
      }

      if (isTurnListenStreamChunkMessage(parsed)) {
        const requestId = typeof parsed.turnId === "string" ? parsed.turnId.trim() : null;
        runWebsocketAsyncTask(requestId, "turn_listen_stream_chunk", () =>
          processRecognitionStreamChunk(socket, parsed),
        );
        return;
      }

      if (isTurnListenStreamEndMessage(parsed)) {
        const requestId = typeof parsed.turnId === "string" ? parsed.turnId.trim() : null;
        runWebsocketAsyncTask(requestId, "turn_listen_stream_end", () =>
          processRecognitionStreamEnd(socket, parsed),
        );
        return;
      }

      if (isMediaSttStartMessage(parsed)) {
        processMediaSttStart(socket, parsed);
        return;
      }

      if (isMediaSttChunkMessage(parsed)) {
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId.trim() : null;
        runWebsocketAsyncTask(requestId, "media_stt_chunk", () =>
          processMediaSttChunk(socket, parsed),
        );
        return;
      }

      if (isMediaSttEndMessage(parsed)) {
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId.trim() : null;
        runWebsocketAsyncTask(requestId, "media_stt_end", () => processMediaSttEnd(socket, parsed));
        return;
      }

      if (isMediaSttCancelMessage(parsed)) {
        processMediaSttCancel(socket, parsed.requestId);
      }
    });

    socket.on("close", () => {
      const debugClient = describeClient(socket);
      teardownDisconnectedSocket(socket, {
        noRemainingReason: "active_client_disconnected",
      });
      logInfo("[agent-voice-adapter] websocket_client_closed", {
        client: debugClient,
      });
      broadcastStatus();
      broadcastActivationState();
      void processSpeakQueue();
    });

    socket.on("error", (error) => {
      const debugClient = describeClient(socket);
      logError("[agent-voice-adapter] websocket client error", error);
      teardownDisconnectedSocket(socket, {
        noRemainingReason: "active_client_error",
      });
      logInfo("[agent-voice-adapter] websocket_client_closed_on_error", {
        client: debugClient,
      });
      broadcastStatus();
      broadcastActivationState();
      void processSpeakQueue();
    });

    sendJson(socket, createStatusMessage());
    sendClientIdentity(socket);
    sendClientActivationState(socket);
  });

  app.use(express.json({ limit: config.http?.jsonBodyLimit ?? "1mb" }));
  app.use(express.static(path.resolve(__dirname, "../../public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => {
    const { type: _messageType, ...status } = createStatusMessage();
    res.json({
      ...status,
      directClients: createDirectClientStatus(),
      wsPath: config.wsPath,
      outputSampleRate: config.tts.outputSampleRate,
      provider: config.tts.provider,
      defaultModel: config.tts.defaultModelId,
      defaultVoice: config.tts.defaultVoiceId,
      asrProvider: config.asr.provider,
      asrDefaultModel: config.asr.defaultModelId,
      asrListenStartTimeoutMs: runtimeSettings.asrListenStartTimeoutMs,
      asrListenCompletionTimeoutMs: runtimeSettings.asrListenCompletionTimeoutMs,
      asrRecognitionEndSilenceMs: runtimeSettings.asrRecognitionEndSilenceMs,
      queueAdvanceDelayMs: runtimeSettings.queueAdvanceDelayMs,
      prependLinkedSessionLabelForTts: runtimeSettings.prependLinkedSessionLabelForTts,
      sessionDispatchProvider: sessionDispatchService.providerId,
      sessionDispatchConfigured: sessionDispatchService.isConfigured,
    });
  });

  app.get("/api/server-settings", (_req, res) => {
    res.json({
      asrListenStartTimeoutMs: runtimeSettings.asrListenStartTimeoutMs,
      asrListenCompletionTimeoutMs: runtimeSettings.asrListenCompletionTimeoutMs,
      asrRecognitionEndSilenceMs: runtimeSettings.asrRecognitionEndSilenceMs,
      queueAdvanceDelayMs: runtimeSettings.queueAdvanceDelayMs,
      prependLinkedSessionLabelForTts: runtimeSettings.prependLinkedSessionLabelForTts,
    });
  });

  app.patch("/api/server-settings", (req, res) => {
    const updates = req.body ?? {};
    const nextSettings: RuntimeServerSettings = { ...runtimeSettings };
    const failures: string[] = [];

    if ("asrListenStartTimeoutMs" in updates) {
      const parsed = parsePositiveIntFromUnknown(updates.asrListenStartTimeoutMs, Number.NaN);
      if (Number.isNaN(parsed)) {
        failures.push("asrListenStartTimeoutMs must be a positive integer");
      } else {
        nextSettings.asrListenStartTimeoutMs = parsed;
      }
    }

    if ("asrListenCompletionTimeoutMs" in updates) {
      const parsed = parsePositiveIntFromUnknown(updates.asrListenCompletionTimeoutMs, Number.NaN);
      if (Number.isNaN(parsed)) {
        failures.push("asrListenCompletionTimeoutMs must be a positive integer");
      } else {
        nextSettings.asrListenCompletionTimeoutMs = parsed;
      }
    }

    if ("asrRecognitionEndSilenceMs" in updates) {
      const parsed = parsePositiveIntFromUnknown(updates.asrRecognitionEndSilenceMs, Number.NaN);
      if (Number.isNaN(parsed)) {
        failures.push("asrRecognitionEndSilenceMs must be a positive integer");
      } else {
        nextSettings.asrRecognitionEndSilenceMs = parsed;
      }
    }

    if ("queueAdvanceDelayMs" in updates) {
      const parsed = parseNonNegativeIntFromUnknown(updates.queueAdvanceDelayMs, Number.NaN);
      if (Number.isNaN(parsed)) {
        failures.push("queueAdvanceDelayMs must be a non-negative integer");
      } else {
        nextSettings.queueAdvanceDelayMs = parsed;
      }
    }

    if ("prependLinkedSessionLabelForTts" in updates) {
      if (typeof updates.prependLinkedSessionLabelForTts !== "boolean") {
        failures.push("prependLinkedSessionLabelForTts must be a boolean");
      } else {
        nextSettings.prependLinkedSessionLabelForTts = updates.prependLinkedSessionLabelForTts;
      }
    }

    if (failures.length > 0) {
      res.status(400).json({
        error: "Invalid server settings update",
        details: failures,
      });
      return;
    }

    runtimeSettings.asrListenStartTimeoutMs = nextSettings.asrListenStartTimeoutMs;
    runtimeSettings.asrListenCompletionTimeoutMs = nextSettings.asrListenCompletionTimeoutMs;
    runtimeSettings.asrRecognitionEndSilenceMs = nextSettings.asrRecognitionEndSilenceMs;
    runtimeSettings.queueAdvanceDelayMs = nextSettings.queueAdvanceDelayMs;
    runtimeSettings.prependLinkedSessionLabelForTts = nextSettings.prependLinkedSessionLabelForTts;

    res.json({
      asrListenStartTimeoutMs: runtimeSettings.asrListenStartTimeoutMs,
      asrListenCompletionTimeoutMs: runtimeSettings.asrListenCompletionTimeoutMs,
      asrRecognitionEndSilenceMs: runtimeSettings.asrRecognitionEndSilenceMs,
      queueAdvanceDelayMs: runtimeSettings.queueAdvanceDelayMs,
      prependLinkedSessionLabelForTts: runtimeSettings.prependLinkedSessionLabelForTts,
    });
  });

  app.get("/api/session-dispatch/sessions", async (_req, res) => {
    if (!sessionDispatchService.isConfigured) {
      res.status(503).json({ error: "Session dispatch provider is not configured" });
      return;
    }

    try {
      const sessions = await sessionDispatchService.listSessions();
      res.json({
        providerId: sessionDispatchService.providerId,
        sessions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("[agent-voice-adapter] session dispatch list failed", message);
      res.status(502).json({
        error: message || "Failed to list sessions",
      });
    }
  });

  app.post("/api/session-dispatch/send", async (req, res) => {
    if (!sessionDispatchService.isConfigured) {
      res.status(503).json({ error: "Session dispatch provider is not configured" });
      return;
    }

    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const mode = req.body?.mode === "custom" ? "custom" : "canned";
    const customMessage = typeof req.body?.message === "string" ? req.body.message : undefined;

    try {
      const result = await sessionDispatchService.sendMessage({
        sessionId,
        mode,
        customMessage,
      });
      res.json({
        ok: true,
        providerId: sessionDispatchService.providerId,
        sessionId,
        mode,
        bytes: result.sentMessage.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isValidationError =
        message.includes("Invalid sessionId") || message.includes("Custom message is required");
      res.status(isValidationError ? 400 : 502).json({
        error: message || "Failed to send session dispatch message",
      });
    }
  });

  app.post("/api/turn/cancel", (req, res) => {
    const turnId = typeof req.body?.turnId === "string" ? req.body.turnId.trim() : "";
    if (!turnId) {
      res.status(400).json({ error: "turnId is required" });
      return;
    }

    if (!hasCancelableTurnRequest(turnId)) {
      res.status(404).json({ error: "Turn not found or already completed", turnId });
      return;
    }

    cancelSpeakRequest(turnId, REQUEST_DISCONNECTED_ERROR);
    res.json({
      ok: true,
      turnId,
      canceled: true,
    });
  });

  app.post("/api/turn/stop-tts", (req, res) => {
    const turnId = typeof req.body?.turnId === "string" ? req.body.turnId.trim() : "";
    if (!turnId) {
      res.status(400).json({ error: "turnId is required" });
      return;
    }

    if (!isTurnTtsActive(turnId)) {
      if (hasCancelableTurnRequest(turnId)) {
        logInfo("[agent-voice-adapter] stop_tts_noop", {
          turnId,
          reason: "turn_not_in_active_tts_playback",
        });
        res.json({
          ok: true,
          turnId,
          stoppedTts: false,
          noop: true,
          reason: "turn_not_in_active_tts_playback",
        });
        return;
      }
      res.status(404).json({ error: "Turn is not in active TTS playback", turnId });
      return;
    }

    const cancellationController = getTurnCancellationController(turnId);
    if (!cancellationController || cancellationController.signal.aborted) {
      res.status(404).json({ error: "Turn is not cancelable", turnId });
      return;
    }

    cancellationController.abort(REQUEST_STOP_TTS_ERROR);
    res.json({
      ok: true,
      turnId,
      stoppedTts: true,
    });
  });

  app.post("/api/media/tts", (req, res) => {
    const clientId = parseOptionalTrimmedString(req.body?.clientId);
    const requestId = parseOptionalTrimmedString(req.body?.requestId);
    const text = req.body?.text;
    const model = parseOptionalTrimmedString(req.body?.model);
    const voice = parseOptionalTrimmedString(req.body?.voice);

    if (!clientId) {
      res.status(400).json({ error: "clientId is required" });
      return;
    }
    if (!requestId) {
      res.status(400).json({ error: "requestId is required" });
      return;
    }
    if (typeof text !== "string") {
      res.status(400).json({ error: "text must be a string" });
      return;
    }

    const target = getTargetDirectClient(clientId);
    if (!target) {
      res.status(404).json({ error: "Direct-media client not found", clientId });
      return;
    }
    if (!getVoiceClientCapabilities(target.state).directTtsEnabled) {
      res.status(409).json({
        error: "Target client does not advertise direct TTS support",
        clientId,
      });
      return;
    }
    if (activeDirectTtsByClientId.has(clientId)) {
      res.status(409).json({
        error: "Target client already has an active direct TTS request",
        clientId,
      });
      return;
    }

    const sanitization = sanitizeTtsText(text, config.sanitizer);
    if (!sanitization.sanitizedText) {
      res.status(400).json({ error: "Text is empty after sanitization" });
      return;
    }

    const context: DirectMediaTtsContext = {
      clientId,
      socket: target.socket,
      requestId,
      providerId: config.tts.provider,
      modelId: model ?? config.tts.defaultModelId,
      voiceId: voice ?? config.tts.defaultVoiceId,
      textChangedBySanitizer: sanitization.changed,
      abortController: new AbortController(),
      outputSampleRate,
    };
    activeDirectTtsByClientId.set(clientId, context);
    broadcastStatus();
    void startDirectTtsRequest({
      context,
      text: sanitization.sanitizedText,
    });

    res.status(202).json({
      accepted: true,
      clientId,
      requestId,
      providerId: context.providerId,
      modelId: context.modelId,
      voiceId: context.voiceId,
      textChangedBySanitizer: sanitization.changed,
    });
  });

  app.post("/api/media/tts/stop", (req, res) => {
    const clientId = parseOptionalTrimmedString(req.body?.clientId);
    const requestId = parseOptionalTrimmedString(req.body?.requestId);
    if (!clientId) {
      res.status(400).json({ error: "clientId is required" });
      return;
    }
    if (!requestId) {
      res.status(400).json({ error: "requestId is required" });
      return;
    }

    const context = activeDirectTtsByClientId.get(clientId);
    if (!context || context.requestId !== requestId) {
      res.status(404).json({ error: "Direct TTS request not found", clientId, requestId });
      return;
    }

    context.abortController.abort("client_stop");
    res.json({
      ok: true,
      clientId,
      requestId,
      stopped: true,
    });
  });

  app.post("/api/media/stt", async (req, res) => {
    if (!asrProvider) {
      res.status(400).json({ error: "Direct STT requires ASR_PROVIDER to be configured" });
      return;
    }

    const clientId = parseOptionalTrimmedString(req.body?.clientId);
    const requestId = parseOptionalTrimmedString(req.body?.requestId);
    const audioBase64 = parseOptionalTrimmedString(req.body?.audioBase64);
    const mimeType = parseOptionalTrimmedString(req.body?.mimeType);
    const modelId = parseOptionalTrimmedString(req.body?.modelId);

    if (!clientId) {
      res.status(400).json({ error: "clientId is required" });
      return;
    }
    if (!requestId) {
      res.status(400).json({ error: "requestId is required" });
      return;
    }
    if (!audioBase64) {
      res.status(400).json({ error: "audioBase64 is required" });
      return;
    }

    const target = getTargetDirectClient(clientId);
    if (!target) {
      res.status(404).json({ error: "Direct-media client not found", clientId });
      return;
    }
    if (!getVoiceClientCapabilities(target.state).directSttEnabled) {
      res.status(409).json({
        error: "Target client does not advertise direct STT support",
        clientId,
      });
      return;
    }
    if (activeDirectSttByClientId.has(clientId)) {
      res.status(409).json({
        error: "Target client already has an active direct STT request",
        clientId,
      });
      return;
    }
    if (activeDirectSttByRequestId.has(requestId)) {
      res.status(409).json({
        error: "Direct STT requestId is already active",
        clientId,
        requestId,
      });
      return;
    }

    const audioBytes = decodeBase64Strict(audioBase64);
    if (!audioBytes) {
      res.status(400).json({ error: "audioBase64 is not valid base64" });
      return;
    }

    const context: DirectMediaSttContext = {
      clientId,
      socket: target.socket,
      requestId,
      inputMode: "blob",
      modelId,
      timing: {
        startTimeoutMs: runtimeSettings.asrListenStartTimeoutMs,
        completionTimeoutMs: runtimeSettings.asrListenCompletionTimeoutMs,
        endSilenceMs: runtimeSettings.asrRecognitionEndSilenceMs,
      },
      sampleRate: 0,
      channels: 1,
      startedAtMs: Date.now(),
      sawSpeech: true,
      speechStartedAtMs: Date.now(),
      lastSpeechAtMs: Date.now(),
      totalBytes: audioBytes.byteLength,
      chunks: [],
      finalizing: false,
      completed: false,
    };
    activeDirectSttByClientId.set(clientId, context);
    activeDirectSttByRequestId.set(requestId, context);
    broadcastStatus();

    const resultPromise = new Promise<MediaSttResultMessage>((resolve) => {
      context.resultResolver = resolve;
    });
    const handleRequestDisconnect = (): void => {
      cancelDirectSttContext(context, "request_disconnected", "client_cancel");
    };
    req.on("aborted", handleRequestDisconnect);
    res.on("close", handleRequestDisconnect);

    void runDirectSttFromAudioBytes(context, {
      audioBytes,
      mimeType: mimeType ?? undefined,
    });

    const result = await resultPromise;
    req.off("aborted", handleRequestDisconnect);
    res.off("close", handleRequestDisconnect);

    if (res.writableEnded || res.destroyed) {
      return;
    }

    if (!result.success) {
      res.status(getDirectSttHttpStatusCode(result)).json({
        accepted: false,
        clientId,
        requestId,
        success: false,
        text: result.text,
        error: result.error,
        canceled: result.canceled,
        cancelReason: result.cancelReason,
        retryable: result.retryable,
        providerId: result.providerId,
        modelId: result.modelId,
        durationMs: result.durationMs,
      });
      return;
    }

    res.status(200).json({
      accepted: true,
      clientId,
      requestId,
      success: true,
      text: result.text,
      providerId: result.providerId,
      modelId: result.modelId,
      durationMs: result.durationMs,
    });
  });

  app.post("/api/media/stt/cancel", (req, res) => {
    const clientId = parseOptionalTrimmedString(req.body?.clientId);
    const requestId = parseOptionalTrimmedString(req.body?.requestId);
    if (!clientId) {
      res.status(400).json({ error: "clientId is required" });
      return;
    }
    if (!requestId) {
      res.status(400).json({ error: "requestId is required" });
      return;
    }

    const context = activeDirectSttByClientId.get(clientId);
    if (!context || context.requestId !== requestId) {
      res.status(404).json({ error: "Direct STT request not found", clientId, requestId });
      return;
    }

    cancelDirectSttContext(context, "client_cancel", "client_cancel");
    res.json({
      ok: true,
      clientId,
      requestId,
      canceled: true,
    });
  });

  app.post("/api/wake-intent", async (req, res) => {
    const resolved = await resolveWakeIntentRequest({
      text: req.body?.text,
      remoteAddress: req.socket.remoteAddress,
      providedSecret: req.header("x-wake-intent-secret") ?? undefined,
      accessPolicy: config.wakeIntent,
      logger: {
        info: (event, details) => {
          logInfo(`[agent-voice-adapter] ${String(event)}`, details);
        },
        error: (event, details) => {
          logError(`[agent-voice-adapter] ${String(event)}`, details);
        },
      },
    });
    res.status(resolved.status).json(resolved.body);
  });

  app.post("/api/turn", async (req, res) => {
    const text = req.body?.text;
    const model = req.body?.model;
    const voice = req.body?.voice;
    const listen = req.body?.listen === true;
    const debugTts = req.body?.debugTts === true;
    const listenModel = req.body?.listenModel;
    const sessionId =
      typeof req.body?.sessionId === "string" && req.body.sessionId.trim().length > 0
        ? req.body.sessionId.trim()
        : undefined;
    const parsedAttachment = parseTurnAttachmentFromUnknown(req.body?.attachment);
    if (parsedAttachment.error) {
      res.status(400).json({
        error: parsedAttachment.error,
      });
      return;
    }
    const parsedQuickReplies = parseTurnQuickRepliesFromUnknown(req.body?.quickReplies);
    if (parsedQuickReplies.error) {
      res.status(400).json({
        error: parsedQuickReplies.error,
      });
      return;
    }
    const effectiveQuickReplies =
      parsedQuickReplies.quickReplies ?? (listen ? undefined : [createAutoResumeQuickReply()]);
    if (typeof text !== "string") {
      res.status(400).json({
        error:
          'Expected JSON payload: { "text": string, "model"?: string, "voice"?: string, "listen"?: boolean }',
      });
      return;
    }

    const recognitionStartTimeoutOverride = parseOptionalPositiveIntOverride(
      req.body?.listenStartTimeoutMs,
    );
    if (
      req.body?.listenStartTimeoutMs !== undefined &&
      recognitionStartTimeoutOverride === undefined
    ) {
      res.status(400).json({ error: "listenStartTimeoutMs must be a positive integer" });
      return;
    }
    const rawCompletionTimeoutOverride =
      req.body?.listenCompletionTimeoutMs ?? req.body?.listenTimeoutMs;
    const recognitionCompletionTimeoutOverride = parseOptionalPositiveIntOverride(
      rawCompletionTimeoutOverride,
    );
    if (
      rawCompletionTimeoutOverride !== undefined &&
      recognitionCompletionTimeoutOverride === undefined
    ) {
      res.status(400).json({ error: "listenCompletionTimeoutMs must be a positive integer" });
      return;
    }
    const recognitionEndSilenceOverride = parseOptionalPositiveIntOverride(req.body?.endSilenceMs);
    if (req.body?.endSilenceMs !== undefined && recognitionEndSilenceOverride === undefined) {
      res.status(400).json({ error: "endSilenceMs must be a positive integer" });
      return;
    }

    if (listen && config.asr.provider === "none") {
      res.status(400).json({
        error: "listen=true requires ASR_PROVIDER to be configured",
      });
      return;
    }

    const activeState = activeClientSocket ? clients.get(activeClientSocket) : undefined;
    const hasMultipleConnectedClients = clients.size > 1;

    if (activeClientSocket == null && hasMultipleConnectedClients) {
      res.status(409).json({
        error:
          "Multiple websocket clients are connected; activate one client before submitting turns",
      });
      return;
    }

    if (activeClientSocket != null) {
      if (!activeState?.acceptingRequests) {
        res.status(409).json({
          error: "The active websocket client is not accepting turns",
        });
        return;
      }
      if (!getVoiceClientCapabilities(activeState).turnModeEnabled) {
        res.status(409).json({
          error: "The active websocket client does not accept turn-mode traffic",
        });
        return;
      }
      if (listen && !activeState.recognitionEnabled) {
        res.status(409).json({
          error: "The active websocket client does not have listening enabled",
        });
        return;
      }
    } else {
      if (getAcceptingClientCount(clients.values()) === 0) {
        res.status(409).json({ error: "No websocket clients connected to the widget" });
        return;
      }

      if (listen && getRecognitionEnabledAcceptingClientCount(clients.values()) === 0) {
        res.status(409).json({
          error: "No listening-enabled websocket clients connected to the widget",
        });
        return;
      }
    }

    const sanitization = sanitizeTtsText(text, config.sanitizer);
    if (!sanitization.sanitizedText) {
      res.status(400).json({ error: "Text is empty after sanitization" });
      return;
    }

    const modelId =
      typeof model === "string" && model.trim().length > 0
        ? model.trim()
        : config.tts.defaultModelId;
    const voiceId =
      typeof voice === "string" && voice.trim().length > 0
        ? voice.trim()
        : config.tts.defaultVoiceId;
    const recognitionModelId =
      typeof listenModel === "string" && listenModel.trim().length > 0
        ? listenModel.trim()
        : undefined;
    const recognitionStartTimeoutMs =
      recognitionStartTimeoutOverride ?? runtimeSettings.asrListenStartTimeoutMs;
    const recognitionCompletionTimeoutMs =
      recognitionCompletionTimeoutOverride ?? runtimeSettings.asrListenCompletionTimeoutMs;
    const recognitionEndSilenceMs =
      recognitionEndSilenceOverride ?? runtimeSettings.asrRecognitionEndSilenceMs;

    const requestId = randomUUID();
    const cancellationController = new AbortController();
    setTurnCancellationController(requestId, cancellationController);

    const job: SpeakJob = {
      requestId,
      createdAt: new Date().toISOString(),
      originalText: sanitization.originalText,
      sanitizedText: sanitization.sanitizedText,
      attachment: parsedAttachment.attachment,
      quickReplies: effectiveQuickReplies,
      sessionId,
      textChangedBySanitizer: sanitization.changed,
      providerId: config.tts.provider,
      modelId,
      voiceId,
      waitForRecognition: listen,
      recognitionModelId,
      recognitionStartTimeoutMs,
      recognitionCompletionTimeoutMs,
      recognitionEndSilenceMs,
      cancellationSignal: cancellationController.signal,
    };
    if (effectiveQuickReplies && effectiveQuickReplies.length > 0) {
      setTurnQuickReplyContext(job.requestId, {
        assistantText: sanitization.originalText,
        sessionId,
        waitForRecognition: listen,
        quickReplies: effectiveQuickReplies,
      });
    }
    const ttsDebugInfo: TurnTtsDebugInfo | undefined = debugTts
      ? {
          providerId: job.providerId,
          modelId: job.modelId,
          voiceId: job.voiceId,
          outputSampleRate: outputSampleRate,
          listenRequested: listen,
          requestTextChars: sanitization.originalText.length,
          sanitizedTextChars: sanitization.sanitizedText.length,
          ...(config.tts.provider === "kokoro_local" && config.kokoroLocal
            ? {
                kokoroConfig: {
                  langCode: config.kokoroLocal.langCode,
                  speed: config.kokoroLocal.speed,
                  device: config.kokoroLocal.device,
                  maxTextCharsPerChunk: config.kokoroLocal.maxTextCharsPerChunk,
                  gapMsBetweenChunks: config.kokoroLocal.gapMsBetweenChunks,
                },
              }
            : {}),
        }
      : undefined;

    let waitResultPromise: Promise<WaitForRecognitionJobCompletion> | null = null;
    if (listen) {
      waitResultPromise = new Promise<WaitForRecognitionJobCompletion>((resolve) => {
        setPendingWaitResolver(job.requestId, resolve);
      });
    }

    const handleRequestDisconnect = (): void => {
      cancelSpeakRequest(job.requestId, REQUEST_DISCONNECTED_ERROR);
    };
    const handleRequestClose = (): void => {
      if (!req.aborted) {
        return;
      }
      handleRequestDisconnect();
    };
    const detachRequestDisconnectListeners = (): void => {
      req.off("aborted", handleRequestDisconnect);
      req.off("close", handleRequestClose);
      res.off("close", handleRequestDisconnect);
    };

    if (listen) {
      req.on("aborted", handleRequestDisconnect);
      req.on("close", handleRequestClose);
      res.on("close", handleRequestDisconnect);
    }

    state.queue.push(job);
    broadcastStatus();
    void processSpeakQueue();

    if (!listen) {
      res.status(202).json({
        accepted: true,
        turnId: job.requestId,
        queueLength: state.queue.length,
        textChangedBySanitizer: sanitization.changed,
        providerId: job.providerId,
        modelId,
        voiceId,
        ...(ttsDebugInfo ? { ttsDebug: ttsDebugInfo } : {}),
      });
      return;
    }

    if (!waitResultPromise) {
      detachRequestDisconnectListeners();
      res.status(500).json({
        accepted: false,
        turnId: job.requestId,
        providerId: job.providerId,
        modelId,
        voiceId,
        stage: "listen",
        error: "listen resolver was not initialized",
        ...(ttsDebugInfo ? { ttsDebug: ttsDebugInfo } : {}),
      });
      return;
    }

    const waitResult = await waitResultPromise;
    detachRequestDisconnectListeners();

    if (res.writableEnded || res.destroyed) {
      return;
    }

    if (!waitResult.speak.success) {
      res.status(502).json({
        accepted: false,
        turnId: job.requestId,
        providerId: job.providerId,
        modelId,
        voiceId,
        stage: "tts",
        error: waitResult.speak.error ?? "Speech generation failed",
        ...(ttsDebugInfo ? { ttsDebug: ttsDebugInfo } : {}),
      });
      return;
    }

    const recognitionResult = waitResult.recognition;
    if (!recognitionResult) {
      res.status(502).json({
        accepted: false,
        turnId: job.requestId,
        providerId: job.providerId,
        modelId,
        voiceId,
        stage: "listen",
        listen: {
          turnId: job.requestId,
          success: false,
          error: "Listen result was not captured",
          providerId: config.asr.provider,
          modelId: job.recognitionModelId ?? config.asr.defaultModelId ?? "unknown",
          durationMs: 0,
        },
        ...(ttsDebugInfo ? { ttsDebug: ttsDebugInfo } : {}),
      });
      return;
    }

    if (!recognitionResult.success) {
      const statusCode = recognitionResult.error?.includes("timed out") ? 504 : 502;
      res.status(statusCode).json({
        accepted: false,
        turnId: job.requestId,
        providerId: job.providerId,
        modelId,
        voiceId,
        stage: "listen",
        listen: {
          turnId: recognitionResult.requestId,
          success: recognitionResult.success,
          text: recognitionResult.text,
          error: recognitionResult.error,
          canceled: recognitionResult.canceled,
          cancelReason: recognitionResult.cancelReason,
          retryable: recognitionResult.retryable,
          timeoutFallbackUsed: recognitionResult.timeoutFallbackUsed,
          providerId: recognitionResult.providerId,
          modelId: recognitionResult.modelId,
          durationMs: recognitionResult.durationMs,
        },
        ...(ttsDebugInfo ? { ttsDebug: ttsDebugInfo } : {}),
      });
      return;
    }

    res.status(200).json({
      accepted: true,
      turnId: job.requestId,
      queueLength: state.queue.length,
      textChangedBySanitizer: sanitization.changed,
      providerId: job.providerId,
      modelId,
      voiceId,
      listen: {
        turnId: recognitionResult.requestId,
        success: recognitionResult.success,
        text: recognitionResult.text,
        error: recognitionResult.error,
        canceled: recognitionResult.canceled,
        cancelReason: recognitionResult.cancelReason,
        retryable: recognitionResult.retryable,
        timeoutFallbackUsed: recognitionResult.timeoutFallbackUsed,
        providerId: recognitionResult.providerId,
        modelId: recognitionResult.modelId,
        durationMs: recognitionResult.durationMs,
      },
      ...(ttsDebugInfo ? { ttsDebug: ttsDebugInfo } : {}),
    });
  });

  return new Promise((resolve, reject) => {
    const handleListenError = (error: Error): void => {
      httpServer.removeListener("error", handleListenError);
      reject(error);
    };

    httpServer.once("error", handleListenError);
    try {
      httpServer.listen(config.port, config.listenHost, () => {
        httpServer.removeListener("error", handleListenError);
        logInfo(`[agent-voice-adapter] listening on http://localhost:${config.port}`);
        resolve(httpServer);
      });
    } catch (error) {
      httpServer.removeListener("error", handleListenError);
      reject(error);
    }
  });
}

async function processSpeakJob(
  job: SpeakJob,
  sendToTarget: (message: OutboundMessage) => void,
  broadcastToAll: (message: OutboundMessage) => void,
  config: AppConfig,
  outputSampleRate: number,
  shouldGenerateAudio: boolean,
  cancellationSignal?: AbortSignal,
): Promise<SpeakCompletionResult> {
  const abortController = new AbortController();
  let encounteredError: unknown = null;
  let client: StreamingTtsClient | null = null;
  const handleCancellation = (): void => {
    abortController.abort();
    void client?.cancel();
  };

  if (cancellationSignal?.aborted) {
    const cancellationReason =
      typeof cancellationSignal.reason === "string" && cancellationSignal.reason.trim().length > 0
        ? cancellationSignal.reason
        : REQUEST_DISCONNECTED_ERROR;
    if (cancellationReason === REQUEST_STOP_TTS_ERROR) {
      broadcastToAll({
        type: "turn_tts_end",
        turnId: job.requestId,
        success: true,
      });
      return { success: true };
    }
    return {
      success: false,
      error: cancellationReason,
    };
  }

  if (cancellationSignal) {
    cancellationSignal.addEventListener("abort", handleCancellation, { once: true });
  }

  const jobStartedAt = performance.now();
  const queuedAtMs = Date.parse(job.createdAt);
  const queueDelayMs = Number.isFinite(queuedAtMs) ? Math.max(0, Date.now() - queuedAtMs) : 0;
  let firstChunkAt: number | null = null;
  let chunkCount = 0;
  let chunkBytes = 0;
  let resolvedOutputSampleRate = outputSampleRate;

  broadcastToAll({
    type: "turn_start",
    turnId: job.requestId,
    createdAt: job.createdAt,
    ...(job.attachment ? { attachment: job.attachment } : {}),
    ...(job.quickReplies ? { quickReplies: job.quickReplies } : {}),
    ...(job.sessionId ? { sessionId: job.sessionId } : {}),
    ...(job.sessionTitle ? { sessionTitle: job.sessionTitle } : {}),
    originalText: job.originalText,
    sanitizedText: job.sanitizedText,
    textChangedBySanitizer: job.textChangedBySanitizer,
    originalLength: job.originalText.length,
    sanitizedLength: job.sanitizedText.length,
    providerId: job.providerId,
    modelId: job.modelId,
    voiceId: job.voiceId,
    listenRequested: job.waitForRecognition,
    listenModelId: job.recognitionModelId ?? null,
  });

  if (!shouldGenerateAudio) {
    broadcastToAll({
      type: "turn_tts_end",
      turnId: job.requestId,
      success: true,
    });
    return { success: true };
  }

  try {
    logInfo("[agent-voice-adapter] speak_job_started", {
      requestId: job.requestId,
      providerId: job.providerId,
      modelId: job.modelId,
      voiceId: job.voiceId,
      textLength: job.sanitizedText.length,
      queueDelayMs,
      waitForRecognition: job.waitForRecognition,
    });

    client = createStreamingTtsClient(config, {
      voiceId: job.voiceId,
      modelId: job.modelId,
      abortSignal: abortController.signal,
      log: (...args: unknown[]) => {
        logInfo(`[agent-voice-adapter:${job.providerId}]`, ...args);
      },
      onOutputSampleRate: (sampleRate: number) => {
        if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
          return;
        }
        resolvedOutputSampleRate = Math.floor(sampleRate);
        logInfo("[agent-voice-adapter] speak_job_output_sample_rate", {
          requestId: job.requestId,
          providerId: job.providerId,
          sampleRate: resolvedOutputSampleRate,
        });
      },
      onAudioChunk: (pcmBytes: Uint8Array) => {
        const now = performance.now();
        if (firstChunkAt === null) {
          firstChunkAt = now;
          logInfo("[agent-voice-adapter] speak_job_first_chunk", {
            requestId: job.requestId,
            providerId: job.providerId,
            firstChunkMs: Math.round(now - jobStartedAt),
          });
        }
        chunkCount += 1;
        chunkBytes += pcmBytes.byteLength;

        sendToTarget({
          type: "turn_audio_chunk",
          turnId: job.requestId,
          sampleRate: resolvedOutputSampleRate,
          encoding: "pcm_s16le",
          chunkBase64: Buffer.from(pcmBytes).toString("base64"),
        });
      },
      onError: (error: unknown) => {
        encounteredError = error;
        logError(`[agent-voice-adapter] ${job.providerId} streaming error`, error);
        void client?.cancel();
      },
    });

    await client.sendText(job.sanitizedText);
    await client.finish();

    if (encounteredError) {
      throw encounteredError;
    }

    broadcastToAll({
      type: "turn_tts_end",
      turnId: job.requestId,
      success: true,
    });
    logInfo("[agent-voice-adapter] speak_job_finished", {
      requestId: job.requestId,
      providerId: job.providerId,
      totalMs: Math.round(performance.now() - jobStartedAt),
      firstChunkMs: firstChunkAt === null ? null : Math.round(firstChunkAt - jobStartedAt),
      chunkCount,
      chunkBytes,
      outputSampleRate: resolvedOutputSampleRate,
      queueDelayMs,
      waitForRecognition: job.waitForRecognition,
    });

    return { success: true };
  } catch (error) {
    const cancellationReason =
      cancellationSignal?.aborted === true
        ? typeof cancellationSignal.reason === "string" &&
          cancellationSignal.reason.trim().length > 0
          ? cancellationSignal.reason
          : REQUEST_DISCONNECTED_ERROR
        : null;
    const renderedError = cancellationReason ?? String(error);
    const stoppedTts = cancellationReason === REQUEST_STOP_TTS_ERROR;

    if (stoppedTts) {
      logInfo("[agent-voice-adapter] speak_job_stopped", {
        requestId: job.requestId,
        providerId: job.providerId,
        totalMs: Math.round(performance.now() - jobStartedAt),
        firstChunkMs: firstChunkAt === null ? null : Math.round(firstChunkAt - jobStartedAt),
        chunkCount,
        chunkBytes,
        outputSampleRate: resolvedOutputSampleRate,
        queueDelayMs,
        waitForRecognition: job.waitForRecognition,
      });
      broadcastToAll({
        type: "turn_tts_end",
        turnId: job.requestId,
        success: true,
      });
      return { success: true };
    }

    logError("[agent-voice-adapter] speak_job_failed", {
      requestId: job.requestId,
      providerId: job.providerId,
      totalMs: Math.round(performance.now() - jobStartedAt),
      firstChunkMs: firstChunkAt === null ? null : Math.round(firstChunkAt - jobStartedAt),
      chunkCount,
      chunkBytes,
      outputSampleRate: resolvedOutputSampleRate,
      queueDelayMs,
      waitForRecognition: job.waitForRecognition,
      error: renderedError,
    });

    broadcastToAll({
      type: "turn_tts_end",
      turnId: job.requestId,
      success: false,
      error: renderedError,
    });

    return { success: false, error: renderedError };
  } finally {
    if (cancellationSignal) {
      cancellationSignal.removeEventListener("abort", handleCancellation);
    }
    abortController.abort();
    await client?.cancel();
  }
}
