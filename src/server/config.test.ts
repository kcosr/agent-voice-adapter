import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config";

describe("loadConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const next = tempDirs.pop();
      if (next) {
        rmSync(next, { recursive: true, force: true });
      }
    }
  });

  test("uses default voice id when ELEVENLABS_TTS_VOICE_ID is not provided", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
    });

    expect(config.tts.provider).toBe("elevenlabs");
    expect(config.elevenLabs?.voiceId).toBe("VUGQSU6BSEjkbudnJbOj");
    expect(config.tts.defaultVoiceId).toBe("VUGQSU6BSEjkbudnJbOj");
  });

  test("uses default model when ELEVENLABS_TTS_MODEL is not provided", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
    });

    expect(config.elevenLabs?.modelId).toBe("eleven_multilingual_v2");
    expect(config.tts.defaultModelId).toBe("eleven_multilingual_v2");
  });

  test("supports custom ELEVENLABS_TTS_MODEL", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_TTS_VOICE_ID: "test-voice",
      ELEVENLABS_TTS_MODEL: "eleven_flash_v2_5",
    });

    expect(config.elevenLabs?.modelId).toBe("eleven_flash_v2_5");
    expect(config.tts.defaultModelId).toBe("eleven_flash_v2_5");
  });

  test("defaults HTTP_JSON_BODY_LIMIT to 1mb", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
    });

    expect(config.http?.jsonBodyLimit).toBe("1mb");
  });

  test("supports HTTP_JSON_BODY_LIMIT override", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      HTTP_JSON_BODY_LIMIT: "2mb",
    });

    expect(config.http?.jsonBodyLimit).toBe("2mb");
  });

  test("supports kokoro_local provider without ELEVENLABS_API_KEY", () => {
    const config = loadConfig({
      TTS_PROVIDER: "kokoro_local",
      KOKORO_LOCAL_MODEL_ID: "hexgrad/Kokoro-82M",
      KOKORO_LOCAL_VOICE_ID: "af_bella",
      KOKORO_LOCAL_SAMPLE_RATE: "24000",
    });

    expect(config.tts.provider).toBe("kokoro_local");
    expect(config.kokoroLocal?.modelId).toBe("hexgrad/Kokoro-82M");
    expect(config.kokoroLocal?.voiceId).toBe("af_bella");
    expect(config.kokoroLocal?.scriptPath).toContain("scripts/kokoro_daemon.py");
    expect(config.elevenLabs).toBeUndefined();
    expect(config.tts.defaultVoiceId).toBe("af_bella");
  });

  test("ignores legacy process transport setting for kokoro_local", () => {
    const config = loadConfig({
      TTS_PROVIDER: "kokoro_local",
      KOKORO_LOCAL_TRANSPORT: "process",
    });

    expect(config.kokoroLocal?.scriptPath).toContain("scripts/kokoro_daemon.py");
  });

  test("supports ssh config for kokoro_local daemon", () => {
    const config = loadConfig({
      TTS_PROVIDER: "kokoro_local",
      KOKORO_LOCAL_SSH_TARGET: "voice-gpu",
      KOKORO_LOCAL_SSH_PORT: "2222",
      KOKORO_LOCAL_SSH_IDENTITY_FILE: "/home/test/.ssh/voice_gpu",
    });

    expect(config.kokoroLocal?.ssh).toEqual({
      target: "voice-gpu",
      port: 2222,
      identityFile: "/home/test/.ssh/voice_gpu",
    });
  });

  test("invalid TTS_PROVIDER falls back to elevenlabs", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      TTS_PROVIDER: "something_else",
    });

    expect(config.tts.provider).toBe("elevenlabs");
  });

  test("defaults ASR provider to none", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
    });

    expect(config.asr.provider).toBe("none");
    expect(config.asr.queueAdvanceDelayMs).toBe(2000);
    expect(config.wakeIntent).toEqual({ allowRemote: false });
    expect(config.parakeetLocal).toBeUndefined();
  });

  test("supports wake-intent remote access env settings", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      WAKE_INTENT_ALLOW_REMOTE: "true",
      WAKE_INTENT_SHARED_SECRET: "test-secret",
    });

    expect(config.wakeIntent).toEqual({
      allowRemote: true,
      sharedSecret: "test-secret",
    });
  });

  test("supports custom waitForRecognition queue advance delay", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      WAIT_FOR_RECOGNITION_QUEUE_ADVANCE_DELAY_MS: "750",
    });

    expect(config.asr.queueAdvanceDelayMs).toBe(750);
  });

  test("falls back waitForRecognition queue advance delay to default for invalid values", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      WAIT_FOR_RECOGNITION_QUEUE_ADVANCE_DELAY_MS: "-10",
    });

    expect(config.asr.queueAdvanceDelayMs).toBe(2000);
  });

  test("supports parakeet_local ASR provider", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "parakeet_local",
      PARAKEET_LOCAL_PYTHON_BIN: "/tmp/python",
      PARAKEET_LOCAL_SCRIPT_PATH: "/tmp/parakeet_daemon.py",
      PARAKEET_LOCAL_MODEL_ID: "nvidia/parakeet-ctc-0.6b",
      PARAKEET_LOCAL_DEVICE: "cuda",
      PARAKEET_LOCAL_TIMEOUT_MS: "120000",
      ASR_RECOGNITION_START_TIMEOUT_MS: "30000",
      ASR_RECOGNITION_COMPLETION_TIMEOUT_MS: "60000",
      ASR_RECOGNITION_END_SILENCE_MS: "1800",
    });

    expect(config.asr.provider).toBe("parakeet_local");
    expect(config.asr.defaultModelId).toBe("nvidia/parakeet-ctc-0.6b");
    expect(config.asr.recognitionStartTimeoutMs).toBe(30000);
    expect(config.asr.recognitionCompletionTimeoutMs).toBe(60000);
    expect(config.asr.recognitionEndSilenceMs).toBe(1800);
    expect(config.parakeetLocal).toMatchObject({
      pythonBin: "/tmp/python",
      scriptPath: "/tmp/parakeet_daemon.py",
      modelId: "nvidia/parakeet-ctc-0.6b",
      device: "cuda",
      timeoutMs: 120000,
    });
  });

  test("supports legacy ASR_RECOGNITION_TIMEOUT_MS as completion timeout fallback", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "parakeet_local",
      ASR_RECOGNITION_TIMEOUT_MS: "45000",
    });

    expect(config.asr.recognitionStartTimeoutMs).toBe(30000);
    expect(config.asr.recognitionCompletionTimeoutMs).toBe(45000);
  });

  test("falls back recognition end-silence threshold to default for invalid values", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_RECOGNITION_END_SILENCE_MS: "-1",
    });

    expect(config.asr.recognitionEndSilenceMs).toBe(1200);
  });

  test("defaults parakeet_local script to daemon", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "parakeet_local",
    });

    expect(config.parakeetLocal?.scriptPath).toContain("scripts/parakeet_daemon.py");
  });

  test("ignores legacy process transport setting for parakeet_local", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "parakeet_local",
      PARAKEET_LOCAL_TRANSPORT: "process",
    });

    expect(config.parakeetLocal?.scriptPath).toContain("scripts/parakeet_daemon.py");
  });

  test("supports ssh config for parakeet_local daemon", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "parakeet_local",
      PARAKEET_LOCAL_SSH_TARGET: "voice-gpu",
      PARAKEET_LOCAL_SSH_PORT: "2202",
      PARAKEET_LOCAL_SSH_IDENTITY_FILE: "/home/test/.ssh/parakeet_gpu",
    });

    expect(config.parakeetLocal?.ssh).toEqual({
      target: "voice-gpu",
      port: 2202,
      identityFile: "/home/test/.ssh/parakeet_gpu",
    });
  });

  test("supports openai ASR provider with defaults", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
    });

    expect(config.asr.provider).toBe("openai");
    expect(config.asr.defaultModelId).toBe("gpt-4o-mini-transcribe");
    expect(config.openaiAsr).toMatchObject({
      apiKey: "sk-test",
      modelId: "gpt-4o-mini-transcribe",
      baseUrl: "https://api.openai.com",
      timeoutMs: 60000,
    });
    expect(config.openaiAsr?.language).toBeUndefined();
    expect(config.parakeetLocal).toBeUndefined();
  });

  test("supports openai ASR model override and language hint", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      ASR_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_ASR_MODEL: "whisper-1",
      OPENAI_ASR_LANGUAGE: "en",
      OPENAI_ASR_BASE_URL: "https://proxy.example.com",
      OPENAI_ASR_TIMEOUT_MS: "45000",
    });

    expect(config.asr.defaultModelId).toBe("whisper-1");
    expect(config.openaiAsr).toMatchObject({
      modelId: "whisper-1",
      language: "en",
      baseUrl: "https://proxy.example.com",
      timeoutMs: 45000,
    });
  });

  test("openai ASR provider requires OPENAI_API_KEY", () => {
    expect(() =>
      loadConfig({
        ELEVENLABS_API_KEY: "test-key",
        ASR_PROVIDER: "openai",
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  test("loads structured JSON config from AGENT_VOICE_ADAPTER_CONFIG_FILE", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "voice-config-"));
    tempDirs.push(tempDir);
    const configFilePath = path.join(tempDir, "config.json");
    writeFileSync(
      configFilePath,
      JSON.stringify(
        {
          http: {
            jsonBodyLimit: "2mb",
          },
          tts: {
            provider: "kokoro_local",
          },
          kokoroLocal: {
            voiceId: "am_adam",
            modelId: "hexgrad/Kokoro-82M",
            sampleRate: 22050,
          },
          wakeIntent: {
            allowRemote: true,
            sharedSecret: "from-file",
          },
          asr: {
            queueAdvanceDelayMs: 2500,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig({
      AGENT_VOICE_ADAPTER_CONFIG_FILE: configFilePath,
    });

    expect(config.tts.provider).toBe("kokoro_local");
    expect(config.http?.jsonBodyLimit).toBe("2mb");
    expect(config.tts.defaultVoiceId).toBe("am_adam");
    expect(config.kokoroLocal?.sampleRate).toBe(22050);
    expect(config.asr.queueAdvanceDelayMs).toBe(2500);
    expect(config.wakeIntent).toEqual({
      allowRemote: true,
      sharedSecret: "from-file",
    });
  });

  test("prefers environment values over file config values", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "voice-config-"));
    tempDirs.push(tempDir);
    const configFilePath = path.join(tempDir, "config.json");
    writeFileSync(
      configFilePath,
      JSON.stringify(
        {
          http: {
            jsonBodyLimit: "2mb",
          },
          tts: {
            provider: "kokoro_local",
          },
          kokoroLocal: {
            voiceId: "am_adam",
          },
          asr: {
            queueAdvanceDelayMs: 2500,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig({
      AGENT_VOICE_ADAPTER_CONFIG_FILE: configFilePath,
      HTTP_JSON_BODY_LIMIT: "3mb",
      KOKORO_LOCAL_VOICE_ID: "bm_daniel",
      WAIT_FOR_RECOGNITION_QUEUE_ADVANCE_DELAY_MS: "500",
    });

    expect(config.http?.jsonBodyLimit).toBe("3mb");
    expect(config.tts.defaultVoiceId).toBe("bm_daniel");
    expect(config.asr.queueAdvanceDelayMs).toBe(500);
  });

  test("enables termstation session dispatch when api base URL is configured", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      SESSION_DISPATCH_TERMSTATION_API_BASE_URL: "https://termstation/api",
      SESSION_DISPATCH_TERMSTATION_USERNAME: "kevin",
      SESSION_DISPATCH_TERMSTATION_PASSWORD: "secret",
      SESSION_DISPATCH_TERMSTATION_TIMEOUT_MS: "12000",
    });

    expect(config.sessionDispatch).toEqual({
      provider: "termstation",
      cannedMessage:
        "Use the agent-voice-adapter-cli skill to continue the conversation with the user.",
      prependLinkedSessionLabelForTts: false,
      termstation: {
        apiBaseUrl: "https://termstation/api",
        username: "kevin",
        password: "secret",
        requestTimeoutMs: 12000,
      },
    });
  });

  test("loads session dispatch settings from structured file config", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "voice-config-"));
    tempDirs.push(tempDir);
    const configFilePath = path.join(tempDir, "config.json");
    writeFileSync(
      configFilePath,
      JSON.stringify(
        {
          sessionDispatch: {
            provider: "termstation",
            cannedMessage: "custom canned",
            prependLinkedSessionLabelForTts: true,
            termstation: {
              apiBaseUrl: "https://termstation/api",
              username: "bridge",
              password: "bridge-pass",
              requestTimeoutMs: 9000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig({
      AGENT_VOICE_ADAPTER_CONFIG_FILE: configFilePath,
      ELEVENLABS_API_KEY: "test-key",
    });

    expect(config.sessionDispatch).toEqual({
      provider: "termstation",
      cannedMessage: "custom canned",
      prependLinkedSessionLabelForTts: true,
      termstation: {
        apiBaseUrl: "https://termstation/api",
        username: "bridge",
        password: "bridge-pass",
        requestTimeoutMs: 9000,
      },
    });
  });

  test("loads linked-session TTS prefix toggle from environment", () => {
    const config = loadConfig({
      ELEVENLABS_API_KEY: "test-key",
      SESSION_DISPATCH_TERMSTATION_API_BASE_URL: "https://termstation/api",
      SESSION_DISPATCH_PREPEND_LINKED_SESSION_LABEL_FOR_TTS: "true",
    });

    expect(config.sessionDispatch?.prependLinkedSessionLabelForTts).toBe(true);
  });
});
