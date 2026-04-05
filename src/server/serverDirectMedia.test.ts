import { spawnSync } from "node:child_process";
import { once } from "node:events";
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
  emittedChunkCount: 1,
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
                  canceled = true;
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
  parakeetLocal: {
    pythonBin: "python3",
    scriptPath: "scripts/parakeet_daemon.py",
    modelId: "nvidia/parakeet-ctc-0.6b",
    device: "auto",
    timeoutMs: 90000,
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

interface JsonMessageWaiter {
  predicate: (payload: Record<string, unknown>) => boolean;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface JsonSocketHarness {
  socket: WebSocket;
  waitForJsonMessage: (
    predicate: (payload: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
}

function createJsonSocketHarness(url: string): JsonSocketHarness {
  const socket = new WebSocket(url);
  const backlog: Array<Record<string, unknown>> = [];
  const waiters: JsonMessageWaiter[] = [];

  socket.on("message", (raw: RawData) => {
    const payload = JSON.parse(rawDataToUtf8(raw)) as Record<string, unknown>;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(payload));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(payload);
      return;
    }

    backlog.push(payload);
  });

  socket.once("close", () => {
    while (waiters.length > 0) {
      const waiter = waiters.pop();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("websocket closed while waiting for message"));
    }
  });

  const waitForJsonMessage = (
    predicate: (payload: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    const backlogIndex = backlog.findIndex((payload) => predicate(payload));
    if (backlogIndex >= 0) {
      const [payload] = backlog.splice(backlogIndex, 1);
      return Promise.resolve(payload);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) {
          waiters.splice(waiterIndex, 1);
        }
        reject(new Error("timed out waiting for websocket message"));
      }, 2_000);
      timeout.unref?.();

      waiters.push({
        predicate,
        resolve,
        reject,
        timeout,
      });
    });
  };

  return {
    socket,
    waitForJsonMessage,
  };
}

function createSpeechPcmChunkBase64(sampleCount = 4_800, amplitude = 12_000): string {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = index % 2 === 0 ? amplitude : -amplitude;
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer.toString("base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    if (socket.readyState === WebSocket.CLOSING) {
      return;
    }
    socket.close();
  });
}

async function patchServerSettings(
  port: number,
  updates: {
    asrListenStartTimeoutMs?: number;
    asrListenCompletionTimeoutMs?: number;
    asrRecognitionEndSilenceMs?: number;
  },
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/server-settings`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(updates),
  });
  await response.json();
  expect(response.status).toBe(200);
}

describe("direct media backend", () => {
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
    ttsMockState.emittedChunkCount = 1;
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "exposes client_identity and direct-media client status",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);

      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directTtsEnabled: true,
          directSttEnabled: true,
        }),
      );

      await sleep(20);

      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      const body = (await response.json()) as {
        directTtsCapableClients: number;
        directSttCapableClients: number;
        directClients: Array<Record<string, unknown>>;
      };

      expect(body.directTtsCapableClients).toBe(1);
      expect(body.directSttCapableClients).toBe(1);
      expect(
        body.directClients.some(
          (entry) =>
            entry.clientId === clientId &&
            entry.turnModeEnabled === false &&
            entry.directTtsEnabled === true &&
            entry.directSttEnabled === true,
        ),
      ).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "excludes direct-media-only clients from /api/turn routing",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      await harness.waitForJsonMessage((payload) => payload.type === "client_identity");
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: true,
          listeningEnabled: true,
          turnModeEnabled: false,
          directTtsEnabled: true,
          directSttEnabled: true,
        }),
      );

      await sleep(20);

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hello world" }),
      });
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(409);
      expect(body.error).toContain("No websocket clients connected");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "streams direct TTS to the explicitly targeted client",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directTtsEnabled: true,
        }),
      );

      const requestId = "media-tts-1";
      const startMessagePromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_tts_start" && payload.requestId === requestId,
      );
      const chunkMessagePromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_tts_audio_chunk" && payload.requestId === requestId,
      );
      const endMessagePromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_tts_end" && payload.requestId === requestId,
      );

      const response = await fetch(`http://127.0.0.1:${port}/api/media/tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId,
          text: "direct tts",
        }),
      });
      const body = (await response.json()) as { accepted: boolean; requestId: string };

      expect(response.status).toBe(202);
      expect(body.accepted).toBe(true);
      expect(body.requestId).toBe(requestId);

      const startMessage = await startMessagePromise;
      const chunkMessage = await chunkMessagePromise;
      const endMessage = await endMessagePromise;

      expect(startMessage.clientId).toBe(clientId);
      expect(chunkMessage.encoding).toBe("pcm_s16le");
      expect(endMessage.status).toBe("completed");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "rejects conflicting direct TTS requests for the same client",
    async () => {
      ttsMockState.sendDelayMs = 250;

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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directTtsEnabled: true,
        }),
      );

      const firstResponse = await fetch(`http://127.0.0.1:${port}/api/media/tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId: "media-tts-a",
          text: "first",
        }),
      });
      expect(firstResponse.status).toBe(202);

      const secondResponse = await fetch(`http://127.0.0.1:${port}/api/media/tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId: "media-tts-b",
          text: "second",
        }),
      });
      const secondBody = (await secondResponse.json()) as { error: string };

      expect(secondResponse.status).toBe(409);
      expect(secondBody.error).toContain("active direct TTS request");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "stops an active direct TTS request through /api/media/tts/stop",
    async () => {
      ttsMockState.sendDelayMs = 250;

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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directTtsEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-tts-stop";
      const startPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_tts_start" && payload.requestId === requestId,
      );
      const endPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_tts_end" && payload.requestId === requestId,
      );

      const startResponse = await fetch(`http://127.0.0.1:${port}/api/media/tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId,
          text: "interrupt me",
        }),
      });

      expect(startResponse.status).toBe(202);
      await startPromise;

      const stopResponse = await fetch(`http://127.0.0.1:${port}/api/media/tts/stop`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId,
        }),
      });
      const stopBody = (await stopResponse.json()) as {
        ok: boolean;
        stopped: boolean;
        requestId: string;
      };
      const endMessage = await endPromise;

      expect(stopResponse.status).toBe(200);
      expect(stopBody.ok).toBe(true);
      expect(stopBody.stopped).toBe(true);
      expect(stopBody.requestId).toBe(requestId);
      expect(endMessage.status).toBe("stopped");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("supports websocket-stream direct STT", async () => {
    asrMockState.scriptedTexts = ["stream transcript"];

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

    const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
    const ws = harness.socket;
    cleanup.push(
      () =>
        new Promise((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
        }),
    );

    await once(ws, "open");
    const identity = await harness.waitForJsonMessage(
      (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
    );
    const clientId = String(identity.clientId);
    ws.send(
      JSON.stringify({
        type: "client_state_update",
        acceptingTurns: false,
        turnModeEnabled: false,
        directSttEnabled: true,
      }),
    );

    const requestId = "media-stt-stream";
    const startedPromise = harness.waitForJsonMessage(
      (payload) => payload.type === "media_stt_started" && payload.requestId === requestId,
    );
    const resultPromise = harness.waitForJsonMessage(
      (payload) => payload.type === "media_stt_result" && payload.requestId === requestId,
    );

    ws.send(
      JSON.stringify({
        type: "media_stt_start",
        requestId,
        sampleRate: 48_000,
        channels: 1,
        encoding: "pcm_s16le",
      }),
    );
    ws.send(
      JSON.stringify({
        type: "media_stt_chunk",
        requestId,
        chunkBase64: createSpeechPcmChunkBase64(),
      }),
    );
    await sleep(140);
    ws.send(
      JSON.stringify({
        type: "media_stt_chunk",
        requestId,
        chunkBase64: createSpeechPcmChunkBase64(),
      }),
    );
    ws.send(
      JSON.stringify({
        type: "media_stt_end",
        requestId,
      }),
    );

    const started = await startedPromise;
    const result = await resultPromise;

    expect(started.clientId).toBe(clientId);
    expect(result.success).toBe(true);
    expect(result.text).toBe("stream transcript");
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "cancels an active direct STT stream through /api/media/stt/cancel",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-cancel";
      const stoppedPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_stopped" && payload.requestId === requestId,
      );
      const resultPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_result" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      await sleep(20);

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/media/stt/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId,
        }),
      });
      const cancelBody = (await cancelResponse.json()) as {
        ok: boolean;
        canceled: boolean;
        requestId: string;
      };
      const stopped = await stoppedPromise;
      const result = await resultPromise;

      expect(cancelResponse.status).toBe(200);
      expect(cancelBody.ok).toBe(true);
      expect(cancelBody.canceled).toBe(true);
      expect(cancelBody.requestId).toBe(requestId);
      expect(stopped.reason).toBe("client_cancel");
      expect(result.success).toBe(false);
      expect(result.canceled).toBe(true);
      expect(result.cancelReason).toBe("client_cancel");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "uses runtime direct STT timing defaults when request overrides are absent",
    async () => {
      asrMockState.scriptedTexts = ["runtime default transcript"];

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
      await patchServerSettings(port, {
        asrListenStartTimeoutMs: 1_000,
        asrListenCompletionTimeoutMs: 1_000,
        asrRecognitionEndSilenceMs: 1_000,
      });

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-runtime-defaults";
      const stoppedPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_stopped" && payload.requestId === requestId,
      );
      const resultPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_result" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      await sleep(70);
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(4_800, 0),
        }),
      );
      await sleep(20);
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(),
        }),
      );
      ws.send(
        JSON.stringify({
          type: "media_stt_end",
          requestId,
        }),
      );

      const stopped = await stoppedPromise;
      const result = await resultPromise;

      expect(stopped.reason).toBe("client_end");
      expect(result.success).toBe(true);
      expect(result.text).toBe("runtime default transcript");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "honors per-request direct STT startTimeoutMs override",
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
      await patchServerSettings(port, {
        asrListenStartTimeoutMs: 1_000,
        asrListenCompletionTimeoutMs: 1_000,
        asrRecognitionEndSilenceMs: 1_000,
      });

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-start-timeout-override";
      const stoppedPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_stopped" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
          startTimeoutMs: 40,
        }),
      );
      await sleep(70);
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(4_800, 0),
        }),
      );

      const stopped = await stoppedPromise;
      expect(stopped.reason).toBe("max_duration");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "honors per-request direct STT completionTimeoutMs override",
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
      await patchServerSettings(port, {
        asrListenStartTimeoutMs: 1_000,
        asrListenCompletionTimeoutMs: 1_000,
        asrRecognitionEndSilenceMs: 1_000,
      });

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-completion-timeout-override";
      const stoppedPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_stopped" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
          completionTimeoutMs: 60,
        }),
      );
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(),
        }),
      );
      await sleep(90);
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(4_800, 0),
        }),
      );

      const stopped = await stoppedPromise;
      expect(stopped.reason).toBe("max_duration");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "honors per-request direct STT endSilenceMs override",
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
      await patchServerSettings(port, {
        asrListenStartTimeoutMs: 1_000,
        asrListenCompletionTimeoutMs: 1_000,
        asrRecognitionEndSilenceMs: 1_000,
      });

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-end-silence-override";
      const stoppedPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_stopped" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
          endSilenceMs: 40,
        }),
      );
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(),
        }),
      );
      await sleep(70);
      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: createSpeechPcmChunkBase64(4_800, 0),
        }),
      );

      const stopped = await stoppedPromise;
      expect(stopped.reason).toBe("silence");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "rejects non-integer direct STT timing overrides on media_stt_start",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-invalid-timing";
      const resultPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_result" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
          startTimeoutMs: 0.5,
        }),
      );

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("startTimeoutMs must be a positive integer");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "rejects malformed websocket direct STT chunks as terminal failures",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-invalid-chunk";
      const resultPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_result" && payload.requestId === requestId,
      );

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      await sleep(20);

      ws.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId,
          chunkBase64: "%%%not-base64%%%",
        }),
      );

      const result = await resultPromise;
      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      const statusBody = (await statusResponse.json()) as {
        activeDirectSttRequests: number;
      };

      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("valid base64");
      expect(statusBody.activeDirectSttRequests).toBe(0);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "returns immediate failures for wrong-owner and unknown websocket direct STT operations",
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

      const ownerHarness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ownerWs = ownerHarness.socket;
      cleanup.push(() => closeWebSocket(ownerWs));

      const otherHarness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const otherWs = otherHarness.socket;
      cleanup.push(() => closeWebSocket(otherWs));

      await once(ownerWs, "open");
      await once(otherWs, "open");
      await ownerHarness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      await otherHarness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );

      ownerWs.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      otherWs.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const requestId = "media-stt-owner";
      ownerWs.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );
      await sleep(20);

      const unknownFailurePromise = otherHarness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_result" && payload.requestId === "missing-request",
      );
      otherWs.send(
        JSON.stringify({
          type: "media_stt_chunk",
          requestId: "missing-request",
          chunkBase64: createSpeechPcmChunkBase64(),
        }),
      );
      const unknownFailure = await unknownFailurePromise;
      expect(unknownFailure.success).toBe(false);
      expect(String(unknownFailure.error)).toContain("not found");

      const wrongOwnerEndPromise = otherHarness.waitForJsonMessage(
        (payload) =>
          payload.type === "media_stt_result" &&
          payload.requestId === requestId &&
          String(payload.error).includes("different socket"),
      );
      otherWs.send(
        JSON.stringify({
          type: "media_stt_end",
          requestId,
        }),
      );
      const wrongOwnerEndFailure = await wrongOwnerEndPromise;
      expect(wrongOwnerEndFailure.success).toBe(false);

      const wrongOwnerCancelPromise = otherHarness.waitForJsonMessage(
        (payload) =>
          payload.type === "media_stt_result" &&
          payload.requestId === requestId &&
          String(payload.error).includes("different socket"),
      );
      otherWs.send(
        JSON.stringify({
          type: "media_stt_cancel",
          requestId,
        }),
      );
      const wrongOwnerCancelFailure = await wrongOwnerCancelPromise;
      expect(wrongOwnerCancelFailure.success).toBe(false);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "supports HTTP blob direct STT and mirrors websocket events",
    async () => {
      asrMockState.scriptedTexts = ["blob transcript"];

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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(
        () =>
          new Promise((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
          }),
      );

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );

      const requestId = "media-stt-blob";
      const startedPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_started" && payload.requestId === requestId,
      );
      const resultPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_stt_result" && payload.requestId === requestId,
      );

      const response = await fetch(`http://127.0.0.1:${port}/api/media/stt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId,
          audioBase64: Buffer.from("blob-audio").toString("base64"),
          mimeType: "audio/wav",
        }),
      });
      const body = (await response.json()) as { accepted: boolean; text: string };

      const started = await startedPromise;
      const result = await resultPromise;

      expect(response.status).toBe(200);
      expect(body.accepted).toBe(true);
      expect(body.text).toBe("blob transcript");
      expect(started.clientId).toBe(clientId);
      expect(result.text).toBe("blob transcript");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "rejects invalid HTTP blob direct STT base64 input",
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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const response = await fetch(`http://127.0.0.1:${port}/api/media/stt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId: "media-stt-invalid-http",
          audioBase64: "%%%not-base64%%%",
          mimeType: "audio/wav",
        }),
      });
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain("valid base64");
      expect(asrMockState.callCount).toBe(0);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "cleans up active direct-media requests when the target client disconnects",
    async () => {
      ttsMockState.sendDelayMs = 250;

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

      const harness = createJsonSocketHarness(`ws://127.0.0.1:${port}/ws`);
      const ws = harness.socket;
      cleanup.push(() => closeWebSocket(ws));

      await once(ws, "open");
      const identity = await harness.waitForJsonMessage(
        (payload) => payload.type === "client_identity" && typeof payload.clientId === "string",
      );
      const clientId = String(identity.clientId);
      ws.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: false,
          turnModeEnabled: false,
          directTtsEnabled: true,
          directSttEnabled: true,
        }),
      );
      await sleep(20);

      const ttsRequestId = "media-tts-disconnect";
      const sttRequestId = "media-stt-disconnect";
      const ttsStartPromise = harness.waitForJsonMessage(
        (payload) => payload.type === "media_tts_start" && payload.requestId === ttsRequestId,
      );

      const ttsResponse = await fetch(`http://127.0.0.1:${port}/api/media/tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          requestId: ttsRequestId,
          text: "disconnect me",
        }),
      });
      expect(ttsResponse.status).toBe(202);

      ws.send(
        JSON.stringify({
          type: "media_stt_start",
          requestId: sttRequestId,
          sampleRate: 48_000,
          channels: 1,
          encoding: "pcm_s16le",
        }),
      );

      await ttsStartPromise;
      await sleep(20);

      const activeStatusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      const activeStatusBody = (await activeStatusResponse.json()) as {
        activeDirectTtsRequests: number;
        activeDirectSttRequests: number;
      };
      expect(activeStatusBody.activeDirectTtsRequests).toBe(1);
      expect(activeStatusBody.activeDirectSttRequests).toBe(1);

      await closeWebSocket(ws);
      await sleep(50);

      const finalStatusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      const finalStatusBody = (await finalStatusResponse.json()) as {
        directClients: Array<Record<string, unknown>>;
        activeDirectTtsRequests: number;
        activeDirectSttRequests: number;
      };

      expect(finalStatusBody.activeDirectTtsRequests).toBe(0);
      expect(finalStatusBody.activeDirectSttRequests).toBe(0);
      expect(finalStatusBody.directClients).toHaveLength(0);
    },
  );
});
