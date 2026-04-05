import { describe, expect, test } from "vitest";

import { createAsrProvider } from "./asrProvider";
import type { AppConfig } from "./config";

function buildBaseConfig(): AppConfig {
  return {
    port: 4300,
    wsPath: "/ws",
    tts: {
      provider: "elevenlabs",
      outputSampleRate: 24000,
      defaultModelId: "eleven_multilingual_v2",
      defaultVoiceId: "voice",
    },
    elevenLabs: {
      apiKey: "key",
      voiceId: "voice",
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
    wakeIntent: { allowRemote: false },
    sanitizer: {
      stripBackticks: true,
      stripMarkdownArtifacts: true,
      stripUrlProtocol: true,
      collapseWhitespace: true,
      maxTextChars: 5000,
    },
  };
}

describe("createAsrProvider", () => {
  test("returns null when provider is 'none'", () => {
    const provider = createAsrProvider(buildBaseConfig());
    expect(provider).toBeNull();
  });

  test("creates the OpenAI ASR client when provider is 'openai'", () => {
    const config: AppConfig = {
      ...buildBaseConfig(),
      asr: {
        provider: "openai",
        defaultModelId: "gpt-4o-mini-transcribe",
        recognitionStartTimeoutMs: 30000,
        recognitionCompletionTimeoutMs: 60000,
        queueAdvanceDelayMs: 0,
      },
      openaiAsr: {
        apiKey: "sk-test",
        modelId: "gpt-4o-mini-transcribe",
        baseUrl: "https://api.openai.com",
        timeoutMs: 30000,
      },
    };

    const provider = createAsrProvider(config);
    expect(provider).not.toBeNull();
    expect(typeof provider?.transcribeAudio).toBe("function");
  });

  test("throws when provider is 'openai' but config.openaiAsr is missing", () => {
    const config: AppConfig = {
      ...buildBaseConfig(),
      asr: {
        provider: "openai",
        defaultModelId: "gpt-4o-mini-transcribe",
        recognitionStartTimeoutMs: 30000,
        recognitionCompletionTimeoutMs: 60000,
        queueAdvanceDelayMs: 0,
      },
    };

    expect(() => createAsrProvider(config)).toThrow(/openai.*openaiAsr/i);
  });

  test("throws when provider is 'parakeet_local' but config.parakeetLocal is missing", () => {
    const config: AppConfig = {
      ...buildBaseConfig(),
      asr: {
        provider: "parakeet_local",
        defaultModelId: "nvidia/parakeet-ctc-0.6b",
        recognitionStartTimeoutMs: 30000,
        recognitionCompletionTimeoutMs: 60000,
        queueAdvanceDelayMs: 0,
      },
    };

    expect(() => createAsrProvider(config)).toThrow(/parakeet_local.*parakeetLocal/i);
  });
});
