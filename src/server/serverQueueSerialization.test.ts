import { spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import { type RawData, WebSocket } from "ws";

import type { AppConfig } from "./config";
import { startServer } from "./server";

const asrMockState = vi.hoisted(() => ({
  callCount: 0,
  scriptedTexts: [] as string[],
}));

const ttsMockState = vi.hoisted(() => ({
  sendDelayMs: 0,
  emittedChunkCount: 0,
}));

vi.mock("./asrProvider", () => {
  return {
    createAsrProvider: () => ({
      transcribeAudio: async () => {
        asrMockState.callCount += 1;
        const scriptedText = asrMockState.scriptedTexts.shift();
        return {
          text:
            typeof scriptedText === "string"
              ? scriptedText
              : `mock transcript ${asrMockState.callCount}`,
          providerId: "parakeet_local",
          modelId: "mock-asr-model",
          durationMs: 11,
        };
      },
    }),
  };
});

vi.mock("./ttsProvider", () => {
  return {
    createStreamingTtsClient: (
      _config: AppConfig,
      options: {
        abortSignal: AbortSignal;
        onAudioChunk?: (pcmBytes: Uint8Array) => void;
      },
    ) => {
      let canceled = false;

      return {
        async sendText() {
          const delayMs = Math.max(0, ttsMockState.sendDelayMs);
          if (delayMs > 0) {
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, delayMs);
              timeout.unref?.();
              options.abortSignal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timeout);
                  resolve();
                },
                { once: true },
              );
            });
          }

          if (canceled || options.abortSignal.aborted) {
            throw new Error("canceled");
          }

          for (let index = 0; index < ttsMockState.emittedChunkCount; index += 1) {
            if (canceled || options.abortSignal.aborted) {
              throw new Error("canceled");
            }
            options.onAudioChunk?.(new Uint8Array([index + 1, index + 2, index + 3, index + 4]));
          }
        },
        async finish() {},
        async cancel() {
          canceled = true;
        },
      };
    },
  };
});

const TEST_CONFIG: AppConfig = {
  port: 0,
  listenHost: "127.0.0.1",
  wsPath: "/ws",
  tts: {
    provider: "elevenlabs",
    outputSampleRate: 24000,
    defaultModelId: "eleven_multilingual_v2",
    defaultVoiceId: "test-voice-id",
  },
  elevenLabs: {
    apiKey: "test-key",
    voiceId: "test-voice-id",
    modelId: "eleven_multilingual_v2",
    baseUrl: "https://api.elevenlabs.io",
    outputFormat: "pcm_24000",
  },
  asr: {
    provider: "parakeet_local",
    defaultModelId: "nvidia/parakeet-ctc-0.6b",
    recognitionStartTimeoutMs: 30000,
    recognitionCompletionTimeoutMs: 60000,
    queueAdvanceDelayMs: 0,
  },
  wakeIntent: {
    allowRemote: false,
  },
  sanitizer: {
    stripBackticks: true,
    stripMarkdownArtifacts: true,
    stripUrlProtocol: true,
    collapseWhitespace: true,
    maxTextChars: 5000,
  },
};

function canBindLoopbackSocket(): boolean {
  const probeScript = `
const net = require("node:net");
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen(0, "127.0.0.1", () => {
  server.close(() => process.exit(0));
});
`;

  const result = spawnSync(process.execPath, ["-e", probeScript], {
    stdio: "ignore",
  });

  return result.status === 0;
}

const SHOULD_RUN_SOCKET_TESTS = canBindLoopbackSocket();

function createSpeechPcmChunkBase64(sampleCount = 2_400, amplitude = 12_000): string {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = index % 2 === 0 ? amplitude : -amplitude;
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer.toString("base64");
}

function rawDataToUtf8(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function waitForActivationState(
  socket: WebSocket,
  expectedActive: boolean,
): Promise<{ active: boolean; connectedClients: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for activation state"));
    }, 2_000);
    timeout.unref?.();

    const onMessage = (raw: RawData) => {
      const payload = JSON.parse(rawDataToUtf8(raw)) as {
        type?: string;
        active?: boolean;
        connectedClients?: number;
      };
      if (payload.type !== "client_activation_state" || payload.active !== expectedActive) {
        return;
      }

      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve({
        active: payload.active,
        connectedClients:
          typeof payload.connectedClients === "number" ? payload.connectedClients : -1,
      });
    };

    socket.on("message", onMessage);
  });
}

describe("listen queue behavior", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
    asrMockState.callCount = 0;
    asrMockState.scriptedTexts = [];
    ttsMockState.sendDelayMs = 0;
    ttsMockState.emittedChunkCount = 0;
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "ignores recognition stream chunk/end messages from non-owner websocket",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const wsOwner = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const wsOther = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            let closed = 0;
            const complete = () => {
              closed += 1;
              if (closed === 2) {
                resolve();
              }
            };
            wsOwner.once("close", complete);
            wsOther.once("close", complete);
            wsOwner.close();
            wsOther.close();
          }),
      );

      await Promise.all([once(wsOwner, "open"), once(wsOther, "open")]);
      wsOwner.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      wsOther.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      const ownerActivated = waitForActivationState(wsOwner, true);
      wsOwner.send(
        JSON.stringify({
          type: "client_activate",
        }),
      );
      await ownerActivated;

      let resolveTurnId: ((turnId: string) => void) | null = null;
      const turnIdPromise = new Promise<string>((resolve) => {
        resolveTurnId = resolve;
      });

      wsOwner.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
        };
        if (payload.type === "turn_tts_end" && payload.success && payload.turnId) {
          resolveTurnId?.(payload.turnId);
          resolveTurnId = null;
        }
      });

      const responsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "ownership test",
          listen: true,
          listenStartTimeoutMs: 800,
          listenCompletionTimeoutMs: 2_000,
        }),
      });

      const turnId = await turnIdPromise;
      const speechChunk = createSpeechPcmChunkBase64();
      wsOwner.send(
        JSON.stringify({
          type: "turn_listen_stream_start",
          turnId,
          sampleRate: 16_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Non-owner stream messages must be ignored.
      wsOther.send(
        JSON.stringify({
          type: "turn_listen_stream_end",
          turnId,
        }),
      );

      wsOwner.send(
        JSON.stringify({
          type: "turn_listen_stream_chunk",
          turnId,
          chunkBase64: speechChunk,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 180));
      wsOwner.send(
        JSON.stringify({
          type: "turn_listen_stream_chunk",
          turnId,
          chunkBase64: speechChunk,
        }),
      );
      wsOwner.send(
        JSON.stringify({
          type: "turn_listen_stream_end",
          turnId,
        }),
      );

      const response = await responsePromise;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        accepted: true,
        turnId,
        listen: {
          success: true,
          providerId: "parakeet_local",
          modelId: "mock-asr-model",
        },
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "routes listen turns to a single websocket owner",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            let closed = 0;
            const complete = () => {
              closed += 1;
              if (closed === 2) {
                resolve();
              }
            };
            wsA.once("close", complete);
            wsB.once("close", complete);
            wsA.close();
            wsB.close();
          }),
      );

      await Promise.all([once(wsA, "open"), once(wsB, "open")]);
      wsA.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      wsB.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      const ownerActivated = waitForActivationState(wsA, true);
      wsA.send(
        JSON.stringify({
          type: "client_activate",
        }),
      );
      await ownerActivated;

      let turnId: string | null = null;
      let turnReadyResolve: (() => void) | null = null;
      const turnReady = new Promise<void>((resolve) => {
        turnReadyResolve = resolve;
      });
      let startsForA = 0;
      let startsForB = 0;

      const onMessage = (label: "a" | "b") => (raw: RawData) => {
        const payload = JSON.parse(rawDataToUtf8(raw)) as {
          type: string;
          turnId?: string;
        };
        if (payload.type !== "turn_start" || !payload.turnId) {
          return;
        }
        if (label === "a") {
          startsForA += 1;
        } else {
          startsForB += 1;
        }
        if (!turnId) {
          turnId = payload.turnId;
          turnReadyResolve?.();
          turnReadyResolve = null;
        }
      };
      wsA.on("message", onMessage("a"));
      wsB.on("message", onMessage("b"));

      const responsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "single owner dispatch",
          listen: true,
          listenStartTimeoutMs: 800,
          listenCompletionTimeoutMs: 2_000,
        }),
      });

      await turnReady;
      if (!turnId) {
        throw new Error("expected a turn_start turnId");
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(startsForA).toBe(1);
      expect(startsForB).toBe(1);

      const ownerWs = wsA;
      const otherWs = wsB;
      const speechChunk = createSpeechPcmChunkBase64();

      // Non-owner stream messages should be rejected before they can create a session.
      otherWs.send(
        JSON.stringify({
          type: "turn_listen_stream_start",
          turnId,
          sampleRate: 16_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      otherWs.send(
        JSON.stringify({
          type: "turn_listen_stream_chunk",
          turnId,
          chunkBase64: speechChunk,
        }),
      );
      otherWs.send(
        JSON.stringify({
          type: "turn_listen_stream_end",
          turnId,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));

      ownerWs.send(
        JSON.stringify({
          type: "turn_listen_stream_start",
          turnId,
          sampleRate: 16_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      ownerWs.send(
        JSON.stringify({
          type: "turn_listen_stream_chunk",
          turnId,
          chunkBase64: speechChunk,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 180));
      ownerWs.send(
        JSON.stringify({
          type: "turn_listen_stream_chunk",
          turnId,
          chunkBase64: speechChunk,
        }),
      );
      ownerWs.send(
        JSON.stringify({
          type: "turn_listen_stream_end",
          turnId,
        }),
      );

      const response = await responsePromise;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        accepted: true,
        turnId,
        listen: {
          success: true,
          providerId: "parakeet_local",
          modelId: "mock-asr-model",
        },
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "accepts quick-reply listen result only from the owner websocket",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const wsOwner = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const wsOther = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            let closed = 0;
            const complete = () => {
              closed += 1;
              if (closed === 2) {
                resolve();
              }
            };
            wsOwner.once("close", complete);
            wsOther.once("close", complete);
            wsOwner.close();
            wsOther.close();
          }),
      );

      await Promise.all([once(wsOwner, "open"), once(wsOther, "open")]);
      wsOwner.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      wsOther.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      const ownerActivated = waitForActivationState(wsOwner, true);
      wsOwner.send(
        JSON.stringify({
          type: "client_activate",
        }),
      );
      await ownerActivated;

      let resolveTurnId: ((turnId: string) => void) | null = null;
      const turnIdPromise = new Promise<string>((resolve) => {
        resolveTurnId = resolve;
      });

      wsOwner.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
        };
        if (payload.type === "turn_start" && payload.turnId) {
          resolveTurnId?.(payload.turnId);
          resolveTurnId = null;
        }
      });

      const responsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "quick reply ownership",
          listen: true,
          quickReplies: [
            { id: "yes", label: "Yes", text: "Yes" },
            { id: "wait", label: "Wait", text: "Wait" },
          ],
          listenStartTimeoutMs: 800,
          listenCompletionTimeoutMs: 2_000,
        }),
      });

      const turnId = await turnIdPromise;

      // Non-owner quick replies must be ignored.
      wsOther.send(
        JSON.stringify({
          type: "turn_listen_quick_reply",
          turnId,
          text: "non-owner reply",
          quickReplyId: "wait",
        }),
      );
      wsOwner.send(
        JSON.stringify({
          type: "turn_listen_quick_reply",
          turnId,
          text: "owner reply",
          quickReplyId: "yes",
        }),
      );

      const response = await responsePromise;
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        accepted: true,
        turnId,
        listen: {
          success: true,
          text: "Yes",
          providerId: "quick_reply",
          modelId: "quick_reply",
        },
      });
      expect(asrMockState.callCount).toBe(0);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "broadcasts turn_start and turn_tts_end to all clients but keeps audio chunks on the owner websocket",
    async () => {
      ttsMockState.emittedChunkCount = 1;

      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const wsOwner = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const wsOther = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            let closed = 0;
            const complete = () => {
              closed += 1;
              if (closed === 2) {
                resolve();
              }
            };
            wsOwner.once("close", complete);
            wsOther.once("close", complete);
            wsOwner.close();
            wsOther.close();
          }),
      );

      await Promise.all([once(wsOwner, "open"), once(wsOther, "open")]);
      wsOwner.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: true,
          listeningEnabled: false,
        }),
      );
      wsOther.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: true,
          listeningEnabled: false,
        }),
      );
      const ownerActivated = waitForActivationState(wsOwner, true);
      wsOwner.send(
        JSON.stringify({
          type: "client_activate",
        }),
      );
      await ownerActivated;

      const ownerEvents: Array<{ type: string; turnId?: string; success?: boolean }> = [];
      const otherEvents: Array<{ type: string; turnId?: string; success?: boolean }> = [];

      const recordEvent =
        (events: Array<{ type: string; turnId?: string; success?: boolean }>) => (raw: RawData) => {
          const payload = JSON.parse(rawDataToUtf8(raw)) as {
            type?: string;
            turnId?: string;
            success?: boolean;
          };
          if (
            payload.type !== "turn_start" &&
            payload.type !== "turn_audio_chunk" &&
            payload.type !== "turn_tts_end"
          ) {
            return;
          }
          events.push({
            type: payload.type,
            ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
            ...(typeof payload.success === "boolean" ? { success: payload.success } : {}),
          });
          maybeResolve();
        };

      let resolveEvents: (() => void) | null = null;
      const eventsReady = new Promise<void>((resolve, reject) => {
        resolveEvents = resolve;
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for broadcast turn lifecycle"));
        }, 2_000);
        timeout.unref?.();

        const maybeFinish = () => {
          const ownerStart = ownerEvents.find((event) => event.type === "turn_start");
          const ownerChunk = ownerEvents.find((event) => event.type === "turn_audio_chunk");
          const ownerEnd = ownerEvents.find(
            (event) => event.type === "turn_tts_end" && event.success === true,
          );
          const otherStart = otherEvents.find((event) => event.type === "turn_start");
          const otherEnd = otherEvents.find(
            (event) => event.type === "turn_tts_end" && event.success === true,
          );
          if (!ownerStart || !ownerChunk || !ownerEnd || !otherStart || !otherEnd) {
            return;
          }
          clearTimeout(timeout);
          resolve();
        };

        resolveEvents = maybeFinish;
      });

      const maybeResolve = () => {
        resolveEvents?.();
      };

      wsOwner.on("message", recordEvent(ownerEvents));
      wsOther.on("message", recordEvent(otherEvents));

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "broadcast lifecycle no wait",
          listen: false,
        }),
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(typeof body.turnId).toBe("string");

      await eventsReady;

      expect(ownerEvents.filter((event) => event.type === "turn_start")).toHaveLength(1);
      expect(otherEvents.filter((event) => event.type === "turn_start")).toHaveLength(1);
      expect(
        ownerEvents.filter((event) => event.type === "turn_tts_end" && event.success === true),
      ).toHaveLength(1);
      expect(
        otherEvents.filter((event) => event.type === "turn_tts_end" && event.success === true),
      ).toHaveLength(1);
      expect(ownerEvents.filter((event) => event.type === "turn_audio_chunk")).toHaveLength(1);
      expect(otherEvents.filter((event) => event.type === "turn_audio_chunk")).toHaveLength(0);

      for (const event of ownerEvents.filter((candidate) => candidate.turnId)) {
        expect(event.turnId).toBe(body.turnId);
      }
      for (const event of otherEvents.filter((candidate) => candidate.turnId)) {
        expect(event.turnId).toBe(body.turnId);
      }
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "does not start the next queued speak job until the current listen is resolved",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      const events: Array<{
        type: string;
        turnId?: string;
        originalText?: string;
      }> = [];

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          originalText?: string;
          success?: boolean;
        };

        events.push({
          type: payload.type,
          turnId: payload.turnId,
          originalText: payload.originalText,
        });

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          ws.send(
            JSON.stringify({
              type: "turn_listen_blob",
              turnId: payload.turnId,
              mimeType: "audio/wav",
              audioBase64: Buffer.from("test-audio").toString("base64"),
            }),
          );
        }
      });

      const firstResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "first wait request",
          listen: true,
        }),
      });

      const secondResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "second wait request",
          listen: true,
        }),
      });

      const firstResponse = await firstResponsePromise;
      const secondResponse = await secondResponsePromise;

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const firstBody = await firstResponse.json();
      const secondBody = await secondResponse.json();

      expect(firstBody).toMatchObject({
        accepted: true,
        listen: {
          success: true,
        },
      });
      expect(secondBody).toMatchObject({
        accepted: true,
        listen: {
          success: true,
        },
      });

      const firstSpeakStartIndex = events.findIndex(
        (event) => event.type === "turn_start" && event.turnId === firstBody.turnId,
      );
      const firstRecognitionResultIndex = events.findIndex(
        (event) => event.type === "turn_listen_result" && event.turnId === firstBody.turnId,
      );
      const secondSpeakStartIndex = events.findIndex(
        (event) => event.type === "turn_start" && event.turnId === secondBody.turnId,
      );

      expect(firstSpeakStartIndex).toBeGreaterThanOrEqual(0);
      expect(firstRecognitionResultIndex).toBeGreaterThan(firstSpeakStartIndex);
      expect(secondSpeakStartIndex).toBeGreaterThan(firstRecognitionResultIndex);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "holds queued jobs while the client reports in-turn and resumes in order when cleared",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
          inTurn: true,
        }),
      );

      const turnStartTexts: string[] = [];
      let resolveTwoTurnStarts: (() => void) | null = null;
      const twoTurnStartsPromise = new Promise<void>((resolve) => {
        resolveTwoTurnStarts = resolve;
      });

      ws.on("message", (raw) => {
        const payload = JSON.parse(rawDataToUtf8(raw)) as {
          type?: string;
          originalText?: string;
        };
        if (payload.type !== "turn_start") {
          return;
        }
        turnStartTexts.push(payload.originalText ?? "");
        if (turnStartTexts.length >= 2) {
          resolveTwoTurnStarts?.();
          resolveTwoTurnStarts = null;
        }
      });

      const [firstQueuedResponse, secondQueuedResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/turn`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "blocked one",
            listen: false,
          }),
        }),
        fetch(`http://127.0.0.1:${port}/api/turn`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "blocked two",
            listen: false,
          }),
        }),
      ]);

      expect(firstQueuedResponse.status).toBe(202);
      expect(secondQueuedResponse.status).toBe(202);

      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(turnStartTexts).toHaveLength(0);

      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
          inTurn: false,
        }),
      );

      await Promise.race([
        twoTurnStartsPromise,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("timed out waiting for queued turn_start messages"));
          }, 5_000);
          timeout.unref?.();
        }),
      ]);

      expect(turnStartTexts.slice(0, 2)).toEqual(["blocked one", "blocked two"]);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "waits configured delay before starting the next queued request after listen completes",
    async () => {
      const configuredDelayMs = 300;
      const server = await startServer({
        ...TEST_CONFIG,
        asr: {
          ...TEST_CONFIG.asr,
          queueAdvanceDelayMs: configuredDelayMs,
        },
      });
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      const events: Array<{ type: string; turnId?: string; atMs: number }> = [];

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
        };

        events.push({
          type: payload.type,
          turnId: payload.turnId,
          atMs: Date.now(),
        });

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          ws.send(
            JSON.stringify({
              type: "turn_listen_blob",
              turnId: payload.turnId,
              mimeType: "audio/wav",
              audioBase64: Buffer.from("test-audio").toString("base64"),
            }),
          );
        }
      });

      const firstResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "first wait request",
          listen: true,
        }),
      });

      const secondResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "second wait request",
          listen: true,
        }),
      });

      const firstResponse = await firstResponsePromise;
      const secondResponse = await secondResponsePromise;

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const firstBody = await firstResponse.json();
      const secondBody = await secondResponse.json();

      const firstRecognitionResult = events.find(
        (event) => event.type === "turn_listen_result" && event.turnId === firstBody.turnId,
      );
      const secondSpeakStart = events.find(
        (event) => event.type === "turn_start" && event.turnId === secondBody.turnId,
      );

      if (!firstRecognitionResult || !secondSpeakStart) {
        throw new Error("expected first turn_listen_result and second turn_start events");
      }

      expect(secondSpeakStart.atMs - firstRecognitionResult.atMs).toBeGreaterThanOrEqual(
        configuredDelayMs - 40,
      );
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "does not advance queued no-wait turns until playback terminal ack is received",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: true,
          listeningEnabled: false,
        }),
      );

      const turnStartById = new Map<string, number>();
      const turnTtsEndById = new Set<string>();
      let secondTurnStartResolve: (() => void) | null = null;
      const secondTurnStarted = new Promise<void>((resolve) => {
        secondTurnStartResolve = resolve;
      });
      let secondTurnId: string | null = null;

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
        };
        if (payload.type === "turn_start" && payload.turnId) {
          turnStartById.set(payload.turnId, Date.now());
          if (secondTurnId && payload.turnId === secondTurnId) {
            secondTurnStartResolve?.();
            secondTurnStartResolve = null;
          }
          return;
        }
        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          turnTtsEndById.add(payload.turnId);
        }
      });

      const firstResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "first queued no-wait",
          listen: false,
        }),
      });

      const secondResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "second queued no-wait",
          listen: false,
        }),
      });

      const firstResponse = await firstResponsePromise;
      const secondResponse = await secondResponsePromise;
      expect(firstResponse.status).toBe(202);
      expect(secondResponse.status).toBe(202);

      const firstBody = await firstResponse.json();
      const secondBody = await secondResponse.json();
      secondTurnId = secondBody.turnId;

      await Promise.race([
        new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (turnStartById.has(firstBody.turnId) && turnTtsEndById.has(firstBody.turnId)) {
              clearInterval(interval);
              resolve();
            }
          }, 10);
          interval.unref?.();
        }),
        new Promise<void>((_, reject) => {
          setTimeout(
            () => reject(new Error("timed out waiting for first turn start+tts_end")),
            1500,
          );
        }),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(turnStartById.has(secondBody.turnId)).toBe(false);

      ws.send(
        JSON.stringify({
          type: "turn_playback_terminal",
          turnId: firstBody.turnId,
          status: "done",
        }),
      );

      await Promise.race([
        secondTurnStarted,
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for second turn_start")), 1500);
        }),
      ]);
      expect(turnStartById.has(secondBody.turnId)).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "starts listen start-timeout when capture begins, not when TTS finishes",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
        };

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "turn_listen_blob",
                turnId: payload.turnId,
                mimeType: "audio/wav",
                audioBase64: Buffer.from("test-audio").toString("base64"),
              }),
            );
          }, 40);
        }
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "timeout sequencing check",
          listen: true,
          listenStartTimeoutMs: 5,
          listenCompletionTimeoutMs: 1000,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: true,
        listen: {
          success: true,
        },
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "returns best-effort transcript from buffered speech when completion timeout is reached",
    async () => {
      asrMockState.scriptedTexts = ["best effort timeout transcript"];

      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      let activeTurnId: string | null = null;
      let sawListenStop = false;
      let sawTimeoutFallbackResult = false;
      const speechChunkBase64 = Buffer.alloc(4096, 0x7f).toString("base64");

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
          timeoutFallbackUsed?: boolean;
        };

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          activeTurnId = payload.turnId;
          ws.send(
            JSON.stringify({
              type: "turn_listen_stream_start",
              turnId: payload.turnId,
              sampleRate: 48_000,
              channels: 1,
              encoding: "pcm_s16le",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "turn_listen_stream_chunk",
              turnId: payload.turnId,
              chunkBase64: speechChunkBase64,
            }),
          );
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "turn_listen_stream_chunk",
                turnId: payload.turnId,
                chunkBase64: speechChunkBase64,
              }),
            );
          }, 160);
          return;
        }

        if (
          payload.type === "turn_listen_stop" &&
          payload.turnId &&
          payload.turnId === activeTurnId
        ) {
          sawListenStop = true;
        }

        if (payload.type === "turn_listen_result" && payload.timeoutFallbackUsed === true) {
          sawTimeoutFallbackResult = true;
        }
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "best effort timeout fallback",
          listen: true,
          listenStartTimeoutMs: 1_000,
          listenCompletionTimeoutMs: 260,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: true,
        listen: {
          success: true,
          text: "best effort timeout transcript",
          timeoutFallbackUsed: true,
        },
      });
      expect(sawListenStop).toBe(true);
      expect(sawTimeoutFallbackResult).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "honors per-request endSilenceMs for turn listen streams",
    async () => {
      asrMockState.scriptedTexts = ["end silence override transcript"];

      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      let activeTurnId: string | null = null;
      let stopReason: string | null = null;
      const speechChunk = createSpeechPcmChunkBase64();
      const silentChunk = createSpeechPcmChunkBase64(2_400, 0);

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
          reason?: string;
        };

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          activeTurnId = payload.turnId;
          ws.send(
            JSON.stringify({
              type: "turn_listen_stream_start",
              turnId: payload.turnId,
              sampleRate: 48_000,
              channels: 1,
              encoding: "pcm_s16le",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "turn_listen_stream_chunk",
              turnId: payload.turnId,
              chunkBase64: speechChunk,
            }),
          );
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "turn_listen_stream_chunk",
                turnId: payload.turnId,
                chunkBase64: speechChunk,
              }),
            );
          }, 130);
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "turn_listen_stream_chunk",
                turnId: payload.turnId,
                chunkBase64: silentChunk,
              }),
            );
          }, 200);
          return;
        }

        if (
          payload.type === "turn_listen_stop" &&
          payload.turnId &&
          payload.turnId === activeTurnId
        ) {
          stopReason = typeof payload.reason === "string" ? payload.reason : null;
        }
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "end silence override",
          listen: true,
          listenStartTimeoutMs: 1_000,
          listenCompletionTimeoutMs: 1_000,
          endSilenceMs: 40,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: true,
        listen: {
          success: true,
          text: "end silence override transcript",
        },
      });
      expect(stopReason).toBe("silence");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "fails listen requests when recognition capture never starts",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      const startedAt = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "capture never starts",
          listen: true,
          listenStartTimeoutMs: 5,
          listenCompletionTimeoutMs: 120,
        }),
      });

      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(1000);
      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: false,
        stage: "listen",
        listen: {
          success: false,
        },
      });
      expect(body.listen.error).toContain("timed out");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "cancels an in-flight owner turn when websocket closes during TTS",
    async () => {
      ttsMockState.sendDelayMs = 300;

      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: true,
          listeningEnabled: true,
        }),
      );

      const turnStartPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: RawData) => {
          const payload = JSON.parse(rawDataToUtf8(raw)) as {
            type: string;
            turnId?: string;
          };
          if (payload.type !== "turn_start" || typeof payload.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve(payload.turnId);
        };

        ws.on("message", onMessage);
      });

      const responsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "disconnect while tts active",
          listen: true,
          listenStartTimeoutMs: 60_000,
          listenCompletionTimeoutMs: 60_000,
        }),
      });

      const turnId = await turnStartPromise;
      ws.close();
      await once(ws, "close");

      const response = await Promise.race([
        responsePromise,
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for canceled response")), 3_000);
        }),
      ]);

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: false,
        turnId,
        stage: "tts",
        error: "Turn owner socket closed before completion",
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "cancels listen flow when HTTP client disconnects and allows the next queued job to proceed",
    async () => {
      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      let firstRequestId: string | null = null;
      let secondRequestId: string | null = null;
      let resolveFirstCancellation:
        | ((payload: {
            error?: string;
            success?: boolean;
            canceled?: boolean;
            cancelReason?: string;
          }) => void)
        | null = null;
      const firstCancellationPromise = new Promise<{
        error?: string;
        success?: boolean;
        canceled?: boolean;
        cancelReason?: string;
      }>((resolve) => {
        resolveFirstCancellation = resolve;
      });
      const firstRequestBody = JSON.stringify({
        text: "first request that will disconnect",
        listen: true,
        listenStartTimeoutMs: 60000,
        listenCompletionTimeoutMs: 60000,
      });
      let firstDisconnected = false;
      const firstResponsePromise = new Promise<void>((resolve, reject) => {
        const firstRequest = http.request(
          {
            hostname: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/turn",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(firstRequestBody),
            },
          },
          (response) => {
            response.resume();
            reject(new Error(`expected disconnect, got HTTP ${response.statusCode ?? "unknown"}`));
          },
        );

        firstRequest.on("error", () => {
          firstDisconnected = true;
          resolve();
        });

        firstRequest.write(firstRequestBody);
        firstRequest.end();

        ws.on("message", (raw) => {
          const payload = JSON.parse(raw.toString("utf8")) as {
            type: string;
            turnId?: string;
            success?: boolean;
          };

          if (
            payload.type === "turn_tts_end" &&
            payload.success &&
            payload.turnId &&
            payload.turnId === firstRequestId
          ) {
            firstRequest.destroy(new Error("client disconnected"));
          }
        });
      });

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
          error?: string;
          canceled?: boolean;
          cancelReason?: string;
        };

        if (payload.type === "turn_start" && payload.turnId) {
          if (!firstRequestId) {
            firstRequestId = payload.turnId;
          } else if (!secondRequestId && payload.turnId !== firstRequestId) {
            secondRequestId = payload.turnId;
          }
          return;
        }

        if (payload.type === "turn_tts_end" && payload.success && payload.turnId) {
          if (payload.turnId === secondRequestId) {
            ws.send(
              JSON.stringify({
                type: "turn_listen_blob",
                turnId: payload.turnId,
                mimeType: "audio/wav",
                audioBase64: Buffer.from("test-audio").toString("base64"),
              }),
            );
          }
          return;
        }

        if (
          payload.type === "turn_listen_result" &&
          payload.turnId &&
          payload.turnId === firstRequestId &&
          !payload.success
        ) {
          resolveFirstCancellation?.({
            success: payload.success,
            error: payload.error,
            canceled: payload.canceled,
            cancelReason: payload.cancelReason,
          });
        }
      });

      const secondResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "second request should continue",
          listen: true,
          listenStartTimeoutMs: 60000,
          listenCompletionTimeoutMs: 60000,
        }),
      });

      await Promise.race([
        firstResponsePromise,
        new Promise<void>((_, reject) => {
          setTimeout(
            () => reject(new Error("timed out waiting for first request disconnect")),
            3000,
          );
        }),
      ]);
      expect(firstDisconnected).toBe(true);

      const firstCancellation = await Promise.race([
        firstCancellationPromise,
        new Promise<{
          error?: string;
          success?: boolean;
          canceled?: boolean;
          cancelReason?: string;
        }>((_, reject) => {
          setTimeout(
            () => reject(new Error("timed out waiting for first cancellation result")),
            3000,
          );
        }),
      ]);
      expect(firstCancellation.success).toBe(false);
      expect(firstCancellation.error).toBe("canceled");
      expect(firstCancellation.canceled).toBe(true);
      expect(firstCancellation.cancelReason).toBe("request_disconnected");

      const secondResponse = await Promise.race([
        secondResponsePromise,
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for second response")), 3000);
        }),
      ]);
      expect(secondResponse.status).toBe(200);

      const secondBody = await secondResponse.json();
      expect(secondBody).toMatchObject({
        accepted: true,
        listen: {
          success: true,
        },
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "treats empty transcript as retryable for listen requests and resolves on retry",
    async () => {
      asrMockState.scriptedTexts = ["", "recognized after retry"];

      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      let turnId: string | null = null;
      let sawRetryableEmptyTranscript = false;

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
          error?: string;
          retryable?: boolean;
        };

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          turnId = payload.turnId;
          ws.send(
            JSON.stringify({
              type: "turn_listen_blob",
              turnId: payload.turnId,
              mimeType: "audio/wav",
              audioBase64: Buffer.from("first-empty-audio").toString("base64"),
            }),
          );
          return;
        }

        if (
          payload.type === "turn_listen_result" &&
          payload.turnId &&
          turnId &&
          payload.turnId === turnId &&
          payload.retryable === true &&
          payload.error === "empty_transcript"
        ) {
          sawRetryableEmptyTranscript = true;
          ws.send(
            JSON.stringify({
              type: "turn_listen_blob",
              turnId: payload.turnId,
              mimeType: "audio/wav",
              audioBase64: Buffer.from("second-retry-audio").toString("base64"),
            }),
          );
        }
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "retry empty transcript check",
          listen: true,
          listenStartTimeoutMs: 60000,
          listenCompletionTimeoutMs: 60000,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: true,
        listen: {
          success: true,
          text: "recognized after retry",
        },
      });
      expect(sawRetryableEmptyTranscript).toBe(true);
      expect(asrMockState.callCount).toBeGreaterThanOrEqual(2);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "treats no-usable-speech capture as retryable for listen requests and resolves on retry",
    async () => {
      asrMockState.scriptedTexts = ["recognized after no-usable-speech retry"];

      const server = await startServer(TEST_CONFIG);
      cleanup.push(
        () =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      );

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server to listen on an inet address");
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );

      let turnId: string | null = null;
      let sawRetryableNoUsableSpeech = false;

      ws.on("message", (raw) => {
        const payload = JSON.parse(raw.toString("utf8")) as {
          type: string;
          turnId?: string;
          success?: boolean;
          error?: string;
          retryable?: boolean;
        };

        if (payload.type === "turn_tts_end" && payload.turnId && payload.success) {
          turnId = payload.turnId;
          ws.send(
            JSON.stringify({
              type: "turn_listen_stream_start",
              turnId: payload.turnId,
              sampleRate: 48_000,
              channels: 1,
              encoding: "pcm_s16le",
            }),
          );
          ws.send(
            JSON.stringify({
              type: "turn_listen_stream_end",
              turnId: payload.turnId,
            }),
          );
          return;
        }

        if (
          payload.type === "turn_listen_result" &&
          payload.turnId &&
          turnId &&
          payload.turnId === turnId &&
          payload.retryable === true &&
          payload.error === "no_usable_speech"
        ) {
          sawRetryableNoUsableSpeech = true;
          ws.send(
            JSON.stringify({
              type: "turn_listen_blob",
              turnId: payload.turnId,
              mimeType: "audio/wav",
              audioBase64: Buffer.from("retry-after-no-usable-speech").toString("base64"),
            }),
          );
        }
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "retry no usable speech check",
          listen: true,
          listenStartTimeoutMs: 60000,
          listenCompletionTimeoutMs: 60000,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        accepted: true,
        listen: {
          success: true,
          text: "recognized after no-usable-speech retry",
        },
      });
      expect(sawRetryableNoUsableSpeech).toBe(true);
      expect(asrMockState.callCount).toBeGreaterThanOrEqual(1);
    },
  );
});
