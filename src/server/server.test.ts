import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import type { AppConfig } from "./config";
import { startServer } from "./server";

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
    provider: "none",
    defaultModelId: null,
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
    stripEmoji: true,
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

function parseJsonMessage(raw: unknown): Record<string, unknown> | null {
  const text =
    typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function waitForActivationState(
  socket: WebSocket,
  predicate: (message: {
    active: boolean;
    activeClientConnected: boolean;
    connectedClients: number;
  }) => boolean,
): Promise<{
  active: boolean;
  activeClientConnected: boolean;
  connectedClients: number;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for activation state"));
    }, 2_000);
    timeout.unref?.();

    const onMessage = (raw: unknown) => {
      const parsed = parseJsonMessage(raw);
      if (
        !parsed ||
        parsed.type !== "client_activation_state" ||
        typeof parsed.active !== "boolean"
      ) {
        return;
      }

      const state = {
        active: parsed.active,
        activeClientConnected: parsed.activeClientConnected === true,
        connectedClients:
          typeof parsed.connectedClients === "number" ? parsed.connectedClients : -1,
      };
      if (!predicate(state)) {
        return;
      }

      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(state);
    };

    socket.on("message", onMessage);
  });
}

describe("POST /api/turn", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "does not auto-activate the first connected client",
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

      const activationStatePromise = waitForActivationState(
        ws,
        (state) => state.active === false && state.activeClientConnected === false,
      );

      await once(ws, "open");

      const activationState = await activationStatePromise;
      expect(activationState.active).toBe(false);
      expect(activationState.activeClientConnected).toBe(false);
      expect(activationState.connectedClients).toBe(1);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "clears the active client when the active socket disconnects",
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
            if (wsA.readyState === WebSocket.CLOSED) {
              closed += 1;
            }
            if (wsB.readyState === WebSocket.CLOSED) {
              closed += 1;
            }
            if (closed === 2) {
              resolve();
              return;
            }
            const onClosed = () => {
              closed += 1;
              if (closed === 2) {
                resolve();
              }
            };
            wsA.once("close", onClosed);
            wsB.once("close", onClosed);
            wsA.close();
            wsB.close();
          }),
      );

      await Promise.all([once(wsA, "open"), once(wsB, "open")]);

      const wsAActivePromise = waitForActivationState(wsA, (state) => state.active === true);
      wsA.send(JSON.stringify({ type: "client_activate" }));
      const wsAActive = await wsAActivePromise;
      expect(wsAActive.active).toBe(true);

      const wsBAfterDisconnectPromise = waitForActivationState(
        wsB,
        (state) =>
          state.active === false &&
          state.activeClientConnected === false &&
          state.connectedClients === 1,
      );
      wsA.close();

      const wsBAfterDisconnect = await wsBAfterDisconnectPromise;
      expect(wsBAfterDisconnect.active).toBe(false);
      expect(wsBAfterDisconnect.activeClientConnected).toBe(false);
      expect(wsBAfterDisconnect.connectedClients).toBe(1);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "does not expose sanitizedText in accepted response payload",
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

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hello world" }),
      });

      expect(response.status).toBe(202);
      const body = await response.json();

      expect(body).toMatchObject({
        accepted: true,
        queueLength: 0,
        textChangedBySanitizer: false,
        providerId: "elevenlabs",
        modelId: "eleven_multilingual_v2",
        voiceId: "test-voice-id",
      });
      expect(body).toHaveProperty("turnId");
      expect(body).not.toHaveProperty("sanitizedText");
    },
  );

  test("rejects non-integer turn listen timing overrides", async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "invalid timing",
        listen: true,
        listenStartTimeoutMs: 0.5,
        listenCompletionTimeoutMs: 25,
        endSilenceMs: 40,
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "listenStartTimeoutMs must be a positive integer",
    });
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "forwards optional sessionId attachment and quickReplies into turn_start websocket payload",
    async () => {
      const asrConfig: AppConfig = {
        ...TEST_CONFIG,
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
      };

      const server = await startServer(asrConfig);
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

      const turnStartPromise = new Promise<{
        turnId: string;
        sessionId?: string;
        attachment?: {
          dataBase64?: string;
          fileName?: string;
          contentType?: string;
        };
        quickReplies?: Array<{
          id?: string;
          label?: string;
          text?: string;
        }>;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: {
            type?: string;
            turnId?: string;
            sessionId?: string;
            attachment?: {
              dataBase64?: string;
              fileName?: string;
              contentType?: string;
            };
            quickReplies?: Array<{
              id?: string;
              label?: string;
              text?: string;
            }>;
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({
            turnId: parsed.turnId,
            sessionId: parsed.sessionId,
            attachment: parsed.attachment,
            quickReplies: parsed.quickReplies,
          });
        };

        ws.on("message", onMessage);
      });

      const responsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          sessionId: "session-123",
          attachment: {
            dataBase64: "IyBSZWxlYXNlIE5vdGVzCi0gbGluZSBvbmU=",
            fileName: "notes.md",
            contentType: "text/markdown",
          },
          listen: true,
          quickReplies: [
            {
              id: "yes",
              label: "Yes",
              text: "Yes, proceed.",
            },
            {
              label: "Wait",
              text: "Please wait.",
            },
          ],
        }),
      });
      const turnStart = await turnStartPromise;
      ws.send(
        JSON.stringify({
          type: "turn_listen_quick_reply",
          turnId: turnStart.turnId,
          text: "Yes, proceed.",
          quickReplyId: "yes",
        }),
      );
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
        listen: {
          success: true,
          text: "Yes, proceed.",
        },
      });
      expect(turnStart.sessionId).toBe("session-123");
      expect(turnStart.attachment).toEqual({
        dataBase64: "IyBSZWxlYXNlIE5vdGVzCi0gbGluZSBvbmU=",
        fileName: "notes.md",
        contentType: "text/markdown",
      });
      expect(turnStart.quickReplies).toEqual([
        {
          id: "yes",
          label: "Yes",
          text: "Yes, proceed.",
        },
        {
          label: "Wait",
          text: "Please wait.",
        },
      ]);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "emits server-resolved sessionTitle on turn_start when session dispatch lookup succeeds",
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (requestUrl === "https://termstation/api/sessions") {
          return new Response(
            JSON.stringify([
              {
                session_id: "session-123",
                workspace: "voice",
                title: "",
                dynamic_title: "Agent One",
                is_active: true,
                last_activity: "2026-02-25T10:00:00Z",
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return originalFetch(input, init);
      }) as typeof fetch;
      cleanup.push(async () => {
        globalThis.fetch = originalFetch;
      });

      const server = await startServer({
        ...TEST_CONFIG,
        sessionDispatch: {
          provider: "termstation",
          cannedMessage:
            "Use the agent-voice-adapter-cli skill to continue the conversation with the user.",
          prependLinkedSessionLabelForTts: false,
          termstation: {
            apiBaseUrl: "https://termstation/api",
            requestTimeoutMs: 10_000,
          },
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
          speechEnabled: true,
          listeningEnabled: false,
        }),
      );

      const turnStartPromise = new Promise<{ sessionId?: string; sessionTitle?: string }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.off("message", onMessage);
            reject(new Error("timed out waiting for turn_start"));
          }, 2_000);
          timeout.unref?.();

          const onMessage = (raw: unknown) => {
            const text =
              typeof raw === "string"
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : String(raw);
            let parsed: { type?: string; sessionId?: string; sessionTitle?: string };
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            if (parsed.type !== "turn_start") {
              return;
            }
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve({
              sessionId: parsed.sessionId,
              sessionTitle: parsed.sessionTitle,
            });
          };

          ws.on("message", onMessage);
        },
      );

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          sessionId: "session-123",
        }),
      });
      expect(response.status).toBe(202);

      const turnStart = await turnStartPromise;
      expect(turnStart.sessionId).toBe("session-123");
      expect(turnStart.sessionTitle).toBe("voice, Agent One");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("returns ttsDebug when debugTts=true", async () => {
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
        listeningEnabled: false,
      }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "hello world", debugTts: true }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.ttsDebug).toMatchObject({
      providerId: "elevenlabs",
      modelId: "eleven_multilingual_v2",
      voiceId: "test-voice-id",
      outputSampleRate: 24000,
      listenRequested: false,
      requestTextChars: 11,
      sanitizedTextChars: 11,
    });
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("rejects invalid attachment payload", async () => {
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
        listeningEnabled: false,
      }),
    );

    const cases: Array<{ attachment: unknown; error: string }> = [
      {
        attachment: null,
        error: "attachment must be an object",
      },
      {
        attachment: [1, 2, 3],
        error: "attachment must be an object",
      },
      {
        attachment: "not-an-object",
        error: "attachment must be an object",
      },
      {
        attachment: {
          dataBase64: "",
          contentType: "text/plain",
        },
        error: "attachment.dataBase64 must be a non-empty string",
      },
      {
        attachment: {
          contentType: "text/plain",
        },
        error: "attachment.dataBase64 must be a non-empty string",
      },
      {
        attachment: {
          dataBase64: "aGVsbG8=",
          contentType: "",
        },
        error: "attachment.contentType must be a non-empty string",
      },
      {
        attachment: {
          dataBase64: "aGVsbG8=",
        },
        error: "attachment.contentType must be a non-empty string",
      },
      {
        attachment: {
          dataBase64: "aGVsbG8=",
          contentType: "text/plain",
          fileName: " ",
        },
        error: "attachment.fileName must be a non-empty string when provided",
      },
      {
        attachment: {
          text: "legacy field only",
          contentType: "text/plain",
        },
        error: "attachment.dataBase64 must be a non-empty string",
      },
    ];

    for (const testCase of cases) {
      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          attachment: testCase.attachment,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        error: testCase.error,
      });
    }
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "passes invalid base64 attachment through turn_start without server decode validation",
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
          listeningEnabled: false,
        }),
      );

      const turnStartPromise = new Promise<{
        turnId: string;
        attachment?: {
          dataBase64?: string;
          fileName?: string;
          contentType?: string;
          text?: string;
        };
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: {
            type?: string;
            turnId?: string;
            attachment?: {
              dataBase64?: string;
              fileName?: string;
              contentType?: string;
              text?: string;
            };
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({
            turnId: parsed.turnId,
            attachment: parsed.attachment,
          });
        };

        ws.on("message", onMessage);
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
          attachment: {
            dataBase64: "not base64 !!",
            fileName: "bad.bin",
            contentType: "application/octet-stream",
          },
        }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
      });
      const turnStart = await turnStartPromise;
      expect(turnStart.attachment).toEqual({
        dataBase64: "not base64 !!",
        fileName: "bad.bin",
        contentType: "application/octet-stream",
      });
      expect(turnStart.attachment?.text).toBeUndefined();
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "auto-adds default no-wait quick reply and applies deferred tap after tts end",
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

      const turnStartPromise = new Promise<{
        turnId: string;
        listenRequested?: boolean;
        quickReplies?: Array<{
          id?: string;
          label?: string;
          text?: string;
          defaultResume?: boolean;
        }>;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: {
            type?: string;
            turnId?: string;
            listenRequested?: boolean;
            quickReplies?: Array<{
              id?: string;
              label?: string;
              text?: string;
              defaultResume?: boolean;
            }>;
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({
            turnId: parsed.turnId,
            listenRequested: parsed.listenRequested,
            quickReplies: parsed.quickReplies,
          });
        };

        ws.on("message", onMessage);
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "hello world",
        }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
      });

      const turnStart = await turnStartPromise;
      expect(turnStart.listenRequested).toBe(false);
      expect(turnStart.quickReplies).toEqual([
        {
          id: "__auto_resume_voice__",
          label: "Resume",
          text: "Resume the conversation where you left off and continue the current task with the user over voice using the agent-voice-adapter-cli skill.",
          defaultResume: true,
        },
      ]);

      const ttsEndPromise = new Promise<{ turnId: string; success?: boolean }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.off("message", onMessage);
            reject(new Error("timed out waiting for turn_tts_end"));
          }, 2_000);
          timeout.unref?.();

          const onMessage = (raw: unknown) => {
            const text =
              typeof raw === "string"
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : String(raw);
            let parsed: { type?: string; turnId?: string; success?: boolean };
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            if (parsed.type !== "turn_tts_end" || parsed.turnId !== turnStart.turnId) {
              return;
            }
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve({ turnId: parsed.turnId, success: parsed.success });
          };

          ws.on("message", onMessage);
        },
      );
      await expect(ttsEndPromise).resolves.toMatchObject({
        turnId: turnStart.turnId,
      });

      const turnListenResultPromise = new Promise<{
        turnId: string;
        success?: boolean;
        text?: string;
        providerId?: string;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_listen_result"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: {
            type?: string;
            turnId?: string;
            success?: boolean;
            text?: string;
            providerId?: string;
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_listen_result" || parsed.turnId !== turnStart.turnId) {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({
            turnId: parsed.turnId,
            success: parsed.success,
            text: parsed.text,
            providerId: parsed.providerId,
          });
        };

        ws.on("message", onMessage);
      });

      ws.send(
        JSON.stringify({
          type: "turn_listen_quick_reply",
          turnId: turnStart.turnId,
          text: "Resume the conversation where you left off and continue the current task with the user over voice using the agent-voice-adapter-cli skill.",
          quickReplyId: "__auto_resume_voice__",
        }),
      );

      await expect(turnListenResultPromise).resolves.toMatchObject({
        turnId: turnStart.turnId,
        success: true,
        text: "Resume the conversation where you left off and continue the current task with the user over voice using the agent-voice-adapter-cli skill.",
        providerId: "quick_reply",
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "dispatches contextual no-wait quick reply text to linked session when configured",
    async () => {
      const originalFetch = globalThis.fetch;
      let dispatchedInput: string | null = null;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (requestUrl === "https://termstation/api/sessions/session-ctx/input") {
          const bodyText = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyText) as { data?: unknown };
          dispatchedInput = typeof parsed.data === "string" ? parsed.data : null;
          return new Response("", { status: 204 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const config: AppConfig = {
          ...TEST_CONFIG,
          sessionDispatch: {
            provider: "termstation",
            cannedMessage:
              "Use the agent-voice-adapter-cli skill to continue the conversation with the user.",
            termstation: {
              apiBaseUrl: "https://termstation/api",
              username: "user",
              password: "pass",
              requestTimeoutMs: 10_000,
            },
          },
        };

        const server = await startServer(config);
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

        const turnStartPromise = new Promise<{ turnId: string }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.off("message", onMessage);
            reject(new Error("timed out waiting for turn_start"));
          }, 2_000);
          timeout.unref?.();

          const onMessage = (raw: unknown) => {
            const text =
              typeof raw === "string"
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : String(raw);
            let parsed: { type?: string; turnId?: string };
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
              return;
            }
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve({ turnId: parsed.turnId });
          };

          ws.on("message", onMessage);
        });

        const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Can you continue from here?",
            sessionId: "session-ctx",
            quickReplies: [{ id: "resume", label: "Resume", text: "Resume voice handoff." }],
          }),
        });
        expect(response.status).toBe(202);

        const turnStart = await turnStartPromise;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.off("message", onMessage);
            reject(new Error("timed out waiting for turn_tts_end"));
          }, 2_000);
          timeout.unref?.();

          const onMessage = (raw: unknown) => {
            const text =
              typeof raw === "string"
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : String(raw);
            let parsed: { type?: string; turnId?: string };
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            if (parsed.type !== "turn_tts_end" || parsed.turnId !== turnStart.turnId) {
              return;
            }
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve();
          };

          ws.on("message", onMessage);
        });

        ws.send(
          JSON.stringify({
            type: "turn_listen_quick_reply",
            turnId: turnStart.turnId,
            quickReplyId: "resume",
            text: "Resume voice handoff.",
          }),
        );

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dispatchedInput).toContain("User is responding to a previous assistant message.");
        expect(dispatchedInput).toContain("Assistant message:");
        expect(dispatchedInput).toContain("Can you continue from here?");
        expect(dispatchedInput).toContain("User response:");
        expect(dispatchedInput).toContain("Resume voice handoff.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("rejects invalid quickReplies payload", async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "hello world",
        listen: true,
        quickReplies: [{ label: "Yes", text: " " }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "quickReplies[0].text must be a non-empty string",
    });
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "rejects listen when ASR provider is disabled",
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

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hello world", listen: true }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("ASR_PROVIDER");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "requires listening-enabled clients for listen mode",
    async () => {
      const asrConfig: AppConfig = {
        ...TEST_CONFIG,
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
      };

      const server = await startServer(asrConfig);
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

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hello world", listen: true }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain("listening-enabled");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "broadcasts turn lifecycle to all clients while keeping ownership on the activated client",
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

      const wsNonListening = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            wsNonListening.once("close", () => resolve());
            wsNonListening.close();
          }),
      );
      await once(wsNonListening, "open");
      wsNonListening.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: false,
        }),
      );

      const wsListening = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(
        () =>
          new Promise((resolve) => {
            wsListening.once("close", () => resolve());
            wsListening.close();
          }),
      );
      await once(wsListening, "open");
      wsListening.send(
        JSON.stringify({
          type: "client_state_update",
          acceptingTurns: true,
          speechEnabled: false,
          listeningEnabled: true,
        }),
      );
      wsListening.send(
        JSON.stringify({
          type: "client_activate",
        }),
      );

      const parseTurnMessage = (
        raw: unknown,
        type: "turn_start" | "turn_tts_end",
      ): { turnId: string; success?: boolean } | null => {
        const parsed = parseJsonMessage(raw);
        if (!parsed) {
          return null;
        }
        if (parsed.type !== type || typeof parsed.turnId !== "string") {
          return null;
        }
        return {
          turnId: parsed.turnId,
          ...(typeof parsed.success === "boolean" ? { success: parsed.success } : {}),
        };
      };

      const parseActivationState = (raw: unknown): boolean | null => {
        const parsed = parseJsonMessage(raw);
        if (!parsed) {
          return null;
        }
        if (parsed.type !== "client_activation_state" || typeof parsed.active !== "boolean") {
          return null;
        }
        return parsed.active;
      };

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          wsListening.off("message", onMessage);
          reject(new Error("timed out waiting for activation state"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const active = parseActivationState(raw);
          if (active !== true) {
            return;
          }
          clearTimeout(timeout);
          wsListening.off("message", onMessage);
          resolve();
        };

        wsListening.on("message", onMessage);
      });

      const waitForTurnMessage = (
        socket: WebSocket,
        type: "turn_start" | "turn_tts_end",
      ): Promise<{ turnId: string; success?: boolean }> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.off("message", onMessage);
            reject(new Error(`timed out waiting for ${type}`));
          }, 2_000);
          timeout.unref?.();

          const onMessage = (raw: unknown) => {
            const message = parseTurnMessage(raw, type);
            if (!message) {
              return;
            }
            clearTimeout(timeout);
            socket.off("message", onMessage);
            resolve(message);
          };

          socket.on("message", onMessage);
        });

      const listeningTurnStart = waitForTurnMessage(wsListening, "turn_start");
      const nonListeningTurnStart = waitForTurnMessage(wsNonListening, "turn_start");
      const listeningTurnEnd = waitForTurnMessage(wsListening, "turn_tts_end");
      const nonListeningTurnEnd = waitForTurnMessage(wsNonListening, "turn_tts_end");

      const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "route no wait to activated client" }),
      });

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(typeof body.turnId).toBe("string");

      const [resolvedListeningTurnStart, resolvedNonListeningTurnStart] = await Promise.all([
        listeningTurnStart,
        nonListeningTurnStart,
      ]);
      expect(resolvedListeningTurnStart.turnId).toBe(body.turnId);
      expect(resolvedNonListeningTurnStart.turnId).toBe(body.turnId);

      const [resolvedListeningTurnEnd, resolvedNonListeningTurnEnd] = await Promise.all([
        listeningTurnEnd,
        nonListeningTurnEnd,
      ]);
      expect(resolvedListeningTurnEnd.turnId).toBe(body.turnId);
      expect(resolvedNonListeningTurnEnd.turnId).toBe(body.turnId);
      expect(resolvedListeningTurnEnd.success).toBe(true);
      expect(resolvedNonListeningTurnEnd.success).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "emits activation state and switches active client on client_activate/client_deactivate",
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
            const onClosed = () => {
              closed += 1;
              if (closed === 2) {
                resolve();
              }
            };
            wsA.once("close", onClosed);
            wsB.once("close", onClosed);
            wsA.close();
            wsB.close();
          }),
      );

      await Promise.all([once(wsA, "open"), once(wsB, "open")]);

      const waitForActivation = (
        socket: WebSocket,
        expectedActive: boolean,
      ): Promise<{ active: boolean; connectedClients: number }> => {
        return waitForActivationState(socket, (state) => state.active === expectedActive).then(
          (state) => ({
            active: state.active,
            connectedClients: state.connectedClients,
          }),
        );
      };

      const wsAActiveAfterSwitch = waitForActivation(wsA, false);
      const wsBActiveAfterSwitch = waitForActivation(wsB, true);
      wsB.send(JSON.stringify({ type: "client_activate" }));

      const [aState, bState] = await Promise.all([wsAActiveAfterSwitch, wsBActiveAfterSwitch]);
      expect(aState.active).toBe(false);
      expect(bState.active).toBe(true);
      expect(aState.connectedClients).toBeGreaterThanOrEqual(2);
      expect(bState.connectedClients).toBeGreaterThanOrEqual(2);

      const wsAInactiveAfterDeactivate = waitForActivation(wsA, false);
      const wsBInactiveAfterDeactivate = waitForActivation(wsB, false);
      wsB.send(JSON.stringify({ type: "client_deactivate" }));

      const [aAfterDeactivate, bAfterDeactivate] = await Promise.all([
        wsAInactiveAfterDeactivate,
        wsBInactiveAfterDeactivate,
      ]);
      expect(aAfterDeactivate.active).toBe(false);
      expect(bAfterDeactivate.active).toBe(false);
      expect(aAfterDeactivate.connectedClients).toBeGreaterThanOrEqual(2);
      expect(bAfterDeactivate.connectedClients).toBeGreaterThanOrEqual(2);
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("responds to client ping with server pong", async () => {
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
    ws.send(JSON.stringify({ type: "client_ping", sentAtMs: 123 }));

    const pong = await new Promise<{
      type: string;
      echoedSentAtMs?: number;
      serverTimeMs?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", handleMessage);
        reject(new Error("timed out waiting for server_pong"));
      }, 2_000);
      timeout.unref?.();

      const handleMessage = (raw: unknown) => {
        const text =
          typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        let parsed: { type?: string; echoedSentAtMs?: number; serverTimeMs?: number };
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed.type !== "server_pong") {
          return;
        }
        clearTimeout(timeout);
        ws.off("message", handleMessage);
        resolve({
          type: parsed.type,
          echoedSentAtMs: parsed.echoedSentAtMs,
          serverTimeMs: parsed.serverTimeMs,
        });
      };

      ws.on("message", handleMessage);
    });

    expect(pong.type).toBe("server_pong");
    expect(pong.echoedSentAtMs).toBe(123);
    expect(typeof pong.serverTimeMs).toBe("number");
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "cancels an active listen turn via POST /api/turn/cancel",
    async () => {
      const asrConfig: AppConfig = {
        ...TEST_CONFIG,
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
      };

      const server = await startServer(asrConfig);
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

      const turnStartPromise = new Promise<{ turnId: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: { type?: string; turnId?: string };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({ turnId: parsed.turnId });
        };

        ws.on("message", onMessage);
      });

      const turnResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "cancel this active turn",
          listen: true,
        }),
      });

      const turnStart = await turnStartPromise;

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/turn/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnId: turnStart.turnId }),
      });
      expect(cancelResponse.status).toBe(200);
      await expect(cancelResponse.json()).resolves.toMatchObject({
        ok: true,
        turnId: turnStart.turnId,
        canceled: true,
      });

      const turnResponse = await turnResponsePromise;
      expect(turnResponse.status).toBe(502);
      const turnBody = await turnResponse.json();
      expect(turnBody).toMatchObject({
        accepted: false,
        turnId: turnStart.turnId,
        stage: "listen",
      });
      expect(turnBody.listen?.error).toBe("canceled");
      expect(turnBody.listen?.canceled).toBe(true);
      expect(turnBody.listen?.cancelReason).toBe("request_disconnected");
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("returns 404 when canceling an unknown turn", async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/api/turn/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ turnId: "missing-turn-id" }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain("not found");
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("requires turnId for stop-tts endpoint", async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/api/turn/stop-tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("turnId is required");
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("returns 404 for stop-tts on unknown turn", async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/api/turn/stop-tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ turnId: "missing-turn-id" }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain("active TTS playback");
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "accepts stop-tts for no-wait turns while playback-terminal ack is pending",
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

      const turnStartPromise = new Promise<{ turnId: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: { type?: string; turnId?: string };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({ turnId: parsed.turnId });
        };

        ws.on("message", onMessage);
      });

      const turnResponse = await fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "stop tts while pending playback terminal",
          listen: false,
        }),
      });
      expect(turnResponse.status).toBe(202);
      const turnBody = await turnResponse.json();

      const turnStart = await turnStartPromise;
      expect(turnStart.turnId).toBe(turnBody.turnId);

      const stopResponse = await fetch(`http://127.0.0.1:${port}/api/turn/stop-tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnId: turnStart.turnId }),
      });
      expect(stopResponse.status).toBe(200);
      await expect(stopResponse.json()).resolves.toMatchObject({
        ok: true,
        turnId: turnStart.turnId,
        stoppedTts: true,
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "treats stop-tts as success no-op when a listen turn is still active but not in TTS playback",
    async () => {
      const asrConfig: AppConfig = {
        ...TEST_CONFIG,
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
      };

      const server = await startServer(asrConfig);
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

      const turnStartPromise = new Promise<{ turnId: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.off("message", onMessage);
          reject(new Error("timed out waiting for turn_start"));
        }, 2_000);
        timeout.unref?.();

        const onMessage = (raw: unknown) => {
          const text =
            typeof raw === "string"
              ? raw
              : Buffer.isBuffer(raw)
                ? raw.toString("utf8")
                : String(raw);
          let parsed: { type?: string; turnId?: string };
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          if (parsed.type !== "turn_start" || typeof parsed.turnId !== "string") {
            return;
          }
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve({ turnId: parsed.turnId });
        };

        ws.on("message", onMessage);
      });

      const turnResponsePromise = fetch(`http://127.0.0.1:${port}/api/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "listen stop-tts noop",
          listen: true,
        }),
      });
      const turnStart = await turnStartPromise;

      // Give the server enough time to transition this listen turn out of the
      // short TTS phase before calling stop-tts.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const stopResponse = await fetch(`http://127.0.0.1:${port}/api/turn/stop-tts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnId: turnStart.turnId }),
      });
      expect(stopResponse.status).toBe(200);
      await expect(stopResponse.json()).resolves.toMatchObject({
        ok: true,
        turnId: turnStart.turnId,
        stoppedTts: false,
        noop: true,
      });

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/api/turn/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ turnId: turnStart.turnId }),
      });
      expect(cancelResponse.status).toBe(200);

      const turnResponse = await turnResponsePromise;
      expect(turnResponse.status).toBe(502);
    },
  );
});

describe("server settings API", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) {
        await fn();
      }
    }
  });

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "returns runtime-configurable server settings defaults",
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

      const response = await fetch(`http://127.0.0.1:${port}/api/server-settings`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        asrListenStartTimeoutMs: 30000,
        asrListenCompletionTimeoutMs: 60000,
        asrRecognitionEndSilenceMs: 1200,
        queueAdvanceDelayMs: 0,
        prependLinkedSessionLabelForTts: false,
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "applies runtime server settings updates and reflects them in status",
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

      const patchResponse = await fetch(`http://127.0.0.1:${port}/api/server-settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          asrListenStartTimeoutMs: 42000,
          asrListenCompletionTimeoutMs: 90000,
          asrRecognitionEndSilenceMs: 1800,
          queueAdvanceDelayMs: 2500,
          prependLinkedSessionLabelForTts: true,
        }),
      });
      expect(patchResponse.status).toBe(200);
      const patched = await patchResponse.json();
      expect(patched).toEqual({
        asrListenStartTimeoutMs: 42000,
        asrListenCompletionTimeoutMs: 90000,
        asrRecognitionEndSilenceMs: 1800,
        queueAdvanceDelayMs: 2500,
        prependLinkedSessionLabelForTts: true,
      });

      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(statusResponse.status).toBe(200);
      const statusBody = await statusResponse.json();
      expect(statusBody).toMatchObject({
        asrListenStartTimeoutMs: 42000,
        asrListenCompletionTimeoutMs: 90000,
        asrRecognitionEndSilenceMs: 1800,
        queueAdvanceDelayMs: 2500,
        prependLinkedSessionLabelForTts: true,
      });
    },
  );

  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)("rejects invalid runtime settings updates", async () => {
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

    const patchResponse = await fetch(`http://127.0.0.1:${port}/api/server-settings`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        asrListenStartTimeoutMs: "bad-value",
        prependLinkedSessionLabelForTts: "yes",
      }),
    });

    expect(patchResponse.status).toBe(400);
    const body = await patchResponse.json();
    expect(body.error).toContain("Invalid server settings update");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details).toContain("asrListenStartTimeoutMs must be a positive integer");
    expect(body.details).toContain("prependLinkedSessionLabelForTts must be a boolean");
  });
});
