import { spawnSync } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

const shutdownKokoroSpy = vi.hoisted(() => vi.fn());
const shutdownParakeetSpy = vi.hoisted(() => vi.fn());

vi.mock("./kokoroLocalDaemonClient", async () => {
  const actual = await vi.importActual<typeof import("./kokoroLocalDaemonClient")>(
    "./kokoroLocalDaemonClient",
  );
  return {
    ...actual,
    shutdownKokoroDaemonProcesses: shutdownKokoroSpy,
  };
});

vi.mock("./parakeetLocalDaemonClient", async () => {
  const actual = await vi.importActual<typeof import("./parakeetLocalDaemonClient")>(
    "./parakeetLocalDaemonClient",
  );
  return {
    ...actual,
    shutdownParakeetDaemonProcesses: shutdownParakeetSpy,
  };
});

import type { AppConfig } from "./config";
import { startServer } from "./server";

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
    collapseWhitespace: true,
    maxTextChars: 5000,
  },
};

describe("server lifecycle", () => {
  test.skipIf(!SHOULD_RUN_SOCKET_TESTS)(
    "invokes daemon shutdown hooks when server closes",
    async () => {
      shutdownKokoroSpy.mockClear();
      shutdownParakeetSpy.mockClear();

      const server = await startServer(TEST_CONFIG);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      expect(shutdownKokoroSpy).toHaveBeenCalledTimes(1);
      expect(shutdownParakeetSpy).toHaveBeenCalledTimes(1);
    },
  );
});
