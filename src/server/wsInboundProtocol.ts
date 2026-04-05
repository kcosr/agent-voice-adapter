import type { RawData } from "ws";

export interface ClientStateUpdateInboundMessage {
  type: "client_state_update";
  acceptingTurns?: unknown;
  speechEnabled?: unknown;
  listeningEnabled?: unknown;
  inTurn?: unknown;
  turnModeEnabled?: unknown;
  directTtsEnabled?: unknown;
  directSttEnabled?: unknown;
}

export interface TurnListenBlobInboundMessage {
  type: "turn_listen_blob";
  turnId?: unknown;
  audioBase64?: unknown;
  mimeType?: unknown;
  modelId?: unknown;
}

export interface TurnListenStreamStartInboundMessage {
  type: "turn_listen_stream_start";
  turnId?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  encoding?: unknown;
  modelId?: unknown;
}

export interface TurnListenStreamChunkInboundMessage {
  type: "turn_listen_stream_chunk";
  turnId?: unknown;
  chunkBase64?: unknown;
}

export interface TurnListenStreamEndInboundMessage {
  type: "turn_listen_stream_end";
  turnId?: unknown;
}

export interface MediaSttStartInboundMessage {
  type: "media_stt_start";
  requestId?: unknown;
  sampleRate?: unknown;
  channels?: unknown;
  encoding?: unknown;
  modelId?: unknown;
  startTimeoutMs?: unknown;
  completionTimeoutMs?: unknown;
  endSilenceMs?: unknown;
}

export interface MediaSttChunkInboundMessage {
  type: "media_stt_chunk";
  requestId?: unknown;
  chunkBase64?: unknown;
}

export interface MediaSttEndInboundMessage {
  type: "media_stt_end";
  requestId?: unknown;
}

export interface MediaSttCancelInboundMessage {
  type: "media_stt_cancel";
  requestId?: unknown;
}

export interface TurnListenQuickReplyInboundMessage {
  type: "turn_listen_quick_reply";
  turnId?: unknown;
  text?: unknown;
  quickReplyId?: unknown;
}

export interface TurnPlaybackTerminalInboundMessage {
  type: "turn_playback_terminal";
  turnId?: unknown;
  status?: unknown;
  reason?: unknown;
}

export interface ClientPingInboundMessage {
  type: "client_ping";
  sentAtMs?: unknown;
}

export interface ClientActivateInboundMessage {
  type: "client_activate";
}

export interface ClientDeactivateInboundMessage {
  type: "client_deactivate";
}

export interface UnknownInboundMessage {
  type?: unknown;
}

export type InboundMessage =
  | ClientStateUpdateInboundMessage
  | ClientPingInboundMessage
  | ClientActivateInboundMessage
  | ClientDeactivateInboundMessage
  | TurnListenBlobInboundMessage
  | TurnListenStreamStartInboundMessage
  | TurnListenStreamChunkInboundMessage
  | TurnListenStreamEndInboundMessage
  | MediaSttStartInboundMessage
  | MediaSttChunkInboundMessage
  | MediaSttEndInboundMessage
  | MediaSttCancelInboundMessage
  | TurnListenQuickReplyInboundMessage
  | TurnPlaybackTerminalInboundMessage
  | UnknownInboundMessage;

export function parseInboundClientMessage(raw: RawData): InboundMessage | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as InboundMessage;
  } catch {
    return null;
  }
}

export function isClientStateUpdateMessage(
  message: InboundMessage,
): message is ClientStateUpdateInboundMessage {
  return message.type === "client_state_update";
}

export function isTurnListenBlobMessage(
  message: InboundMessage,
): message is TurnListenBlobInboundMessage {
  return message.type === "turn_listen_blob";
}

export function isTurnListenStreamStartMessage(
  message: InboundMessage,
): message is TurnListenStreamStartInboundMessage {
  return message.type === "turn_listen_stream_start";
}

export function isTurnListenStreamChunkMessage(
  message: InboundMessage,
): message is TurnListenStreamChunkInboundMessage {
  return message.type === "turn_listen_stream_chunk";
}

export function isTurnListenStreamEndMessage(
  message: InboundMessage,
): message is TurnListenStreamEndInboundMessage {
  return message.type === "turn_listen_stream_end";
}

export function isMediaSttStartMessage(
  message: InboundMessage,
): message is MediaSttStartInboundMessage {
  return message.type === "media_stt_start";
}

export function isMediaSttChunkMessage(
  message: InboundMessage,
): message is MediaSttChunkInboundMessage {
  return message.type === "media_stt_chunk";
}

export function isMediaSttEndMessage(
  message: InboundMessage,
): message is MediaSttEndInboundMessage {
  return message.type === "media_stt_end";
}

export function isMediaSttCancelMessage(
  message: InboundMessage,
): message is MediaSttCancelInboundMessage {
  return message.type === "media_stt_cancel";
}

export function isTurnListenQuickReplyMessage(
  message: InboundMessage,
): message is TurnListenQuickReplyInboundMessage {
  return message.type === "turn_listen_quick_reply";
}

export function isTurnPlaybackTerminalMessage(
  message: InboundMessage,
): message is TurnPlaybackTerminalInboundMessage {
  return message.type === "turn_playback_terminal";
}

export function isClientPingMessage(message: InboundMessage): message is ClientPingInboundMessage {
  return message.type === "client_ping";
}

export function isClientActivateMessage(
  message: InboundMessage,
): message is ClientActivateInboundMessage {
  return message.type === "client_activate";
}

export function isClientDeactivateMessage(
  message: InboundMessage,
): message is ClientDeactivateInboundMessage {
  return message.type === "client_deactivate";
}
