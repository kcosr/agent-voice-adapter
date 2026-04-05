import { describe, expect, test } from "vitest";

import type { AppConfig } from "./config";
import { ElevenLabsStreamingClient } from "./elevenLabsStreamingClient";
import { KokoroLocalDaemonClient } from "./kokoroLocalDaemonClient";
import { createStreamingTtsClient } from "./ttsProvider";

const BASE_OPTIONS = {
  modelId: "model-x",
  voiceId: "voice-x",
  abortSignal: new AbortController().signal,
  onAudioChunk: (_pcmBytes: Uint8Array) => {},
  onError: (_error: unknown) => {},
  log: (..._args: unknown[]) => {},
};

describe("createStreamingTtsClient", () => {
  test("creates ElevenLabs provider when configured", () => {
    const config: AppConfig = {
      port: 4300,
      wsPath: "/ws",
      tts: {
        provider: "elevenlabs",
        outputSampleRate: 24000,
        defaultModelId: "model",
        defaultVoiceId: "voice",
      },
      elevenLabs: {
        apiKey: "key",
        voiceId: "voice",
        modelId: "model",
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

    const client = createStreamingTtsClient(config, BASE_OPTIONS);
    expect(client).toBeInstanceOf(ElevenLabsStreamingClient);
  });

  test("creates kokoro_local daemon provider when configured", () => {
    const config: AppConfig = {
      port: 4300,
      wsPath: "/ws",
      tts: {
        provider: "kokoro_local",
        outputSampleRate: 24000,
        defaultModelId: "hexgrad/Kokoro-82M",
        defaultVoiceId: "af_heart",
      },
      kokoroLocal: {
        pythonBin: "python3",
        scriptPath: "scripts/kokoro_daemon.py",
        voiceId: "af_heart",
        modelId: "hexgrad/Kokoro-82M",
        langCode: "a",
        speed: 1,
        device: "auto",
        maxTextCharsPerChunk: 850,
        gapMsBetweenChunks: 0,
        sampleRate: 24000,
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

    const client = createStreamingTtsClient(config, BASE_OPTIONS);
    expect(client).toBeInstanceOf(KokoroLocalDaemonClient);
  });
});
