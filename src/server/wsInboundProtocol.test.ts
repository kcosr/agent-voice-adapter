import { describe, expect, test } from "vitest";

import {
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

describe("wsInboundProtocol", () => {
  test("parses valid JSON messages", () => {
    const parsed = parseInboundClientMessage(
      Buffer.from(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          inTurn: false,
        }),
      ),
    );

    expect(parsed).toEqual({
      type: "client_state_update",
      acceptingTurns: true,
      inTurn: false,
    });
  });

  test("returns null for invalid JSON", () => {
    expect(parseInboundClientMessage(Buffer.from("{"))).toBeNull();
  });

  test("recognizes inbound message types", () => {
    const clientState = parseInboundClientMessage(Buffer.from('{"type":"client_state_update"}'));
    const request = parseInboundClientMessage(Buffer.from('{"type":"turn_listen_blob"}'));
    const streamStart = parseInboundClientMessage(
      Buffer.from('{"type":"turn_listen_stream_start"}'),
    );
    const streamChunk = parseInboundClientMessage(
      Buffer.from('{"type":"turn_listen_stream_chunk"}'),
    );
    const streamEnd = parseInboundClientMessage(Buffer.from('{"type":"turn_listen_stream_end"}'));
    const mediaSttStart = parseInboundClientMessage(Buffer.from('{"type":"media_stt_start"}'));
    const mediaSttChunk = parseInboundClientMessage(Buffer.from('{"type":"media_stt_chunk"}'));
    const mediaSttEnd = parseInboundClientMessage(Buffer.from('{"type":"media_stt_end"}'));
    const mediaSttCancel = parseInboundClientMessage(Buffer.from('{"type":"media_stt_cancel"}'));
    const quickReply = parseInboundClientMessage(Buffer.from('{"type":"turn_listen_quick_reply"}'));
    const playbackTerminal = parseInboundClientMessage(
      Buffer.from('{"type":"turn_playback_terminal","status":"done"}'),
    );
    const clientPing = parseInboundClientMessage(Buffer.from('{"type":"client_ping"}'));
    const clientActivate = parseInboundClientMessage(Buffer.from('{"type":"client_activate"}'));
    const clientDeactivate = parseInboundClientMessage(Buffer.from('{"type":"client_deactivate"}'));

    expect(clientState && isClientStateUpdateMessage(clientState)).toBe(true);
    expect(clientPing && isClientPingMessage(clientPing)).toBe(true);
    expect(clientActivate && isClientActivateMessage(clientActivate)).toBe(true);
    expect(clientDeactivate && isClientDeactivateMessage(clientDeactivate)).toBe(true);
    expect(request && isTurnListenBlobMessage(request)).toBe(true);
    expect(streamStart && isTurnListenStreamStartMessage(streamStart)).toBe(true);
    expect(streamChunk && isTurnListenStreamChunkMessage(streamChunk)).toBe(true);
    expect(streamEnd && isTurnListenStreamEndMessage(streamEnd)).toBe(true);
    expect(mediaSttStart && isMediaSttStartMessage(mediaSttStart)).toBe(true);
    expect(mediaSttChunk && isMediaSttChunkMessage(mediaSttChunk)).toBe(true);
    expect(mediaSttEnd && isMediaSttEndMessage(mediaSttEnd)).toBe(true);
    expect(mediaSttCancel && isMediaSttCancelMessage(mediaSttCancel)).toBe(true);
    expect(quickReply && isTurnListenQuickReplyMessage(quickReply)).toBe(true);
    expect(playbackTerminal && isTurnPlaybackTerminalMessage(playbackTerminal)).toBe(true);
  });
});
