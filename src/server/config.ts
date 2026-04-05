import path from "node:path";

import { loadFileConfigEnv } from "./configFile";
import { parseOptionalString } from "./parseUtils";

export interface SanitizerConfig {
  stripBackticks: boolean;
  stripMarkdownArtifacts: boolean;
  stripUrlProtocol: boolean;
  collapseWhitespace: boolean;
  maxTextChars: number;
}

export type TtsProvider = "elevenlabs" | "kokoro_local";
export type AsrProvider = "none" | "parakeet_local" | "openai";

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  baseUrl: string;
  outputFormat: string;
}

export interface SshConfig {
  target: string;
  port?: number;
  identityFile?: string;
}

export interface KokoroLocalConfig {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshConfig;
  voiceId: string;
  modelId: string;
  langCode: string;
  speed: number;
  device: "cuda" | "cpu" | "auto";
  maxTextCharsPerChunk: number;
  gapMsBetweenChunks: number;
  sampleRate: number;
}

export interface ParakeetLocalConfig {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshConfig;
  modelId: string;
  device: "cuda" | "cpu" | "auto";
  timeoutMs: number;
}

export interface OpenAiAsrConfig {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  language?: string;
  timeoutMs: number;
}

export type SessionDispatchProvider = "none" | "termstation";

export interface SessionDispatchTermstationConfig {
  apiBaseUrl: string;
  username?: string;
  password?: string;
  requestTimeoutMs: number;
}

export interface SessionDispatchConfig {
  provider: SessionDispatchProvider;
  cannedMessage: string;
  prependLinkedSessionLabelForTts?: boolean;
  termstation?: SessionDispatchTermstationConfig;
}

export interface AppConfig {
  port: number;
  listenHost?: string;
  wsPath: string;
  http?: {
    jsonBodyLimit: string;
  };
  tts: {
    provider: TtsProvider;
    outputSampleRate: number;
    defaultModelId: string;
    defaultVoiceId: string;
  };
  elevenLabs?: ElevenLabsConfig;
  kokoroLocal?: KokoroLocalConfig;
  asr: {
    provider: AsrProvider;
    defaultModelId: string | null;
    recognitionStartTimeoutMs: number;
    recognitionCompletionTimeoutMs: number;
    recognitionEndSilenceMs?: number;
    queueAdvanceDelayMs: number;
  };
  wakeIntent: {
    allowRemote: boolean;
    sharedSecret?: string;
  };
  sessionDispatch?: SessionDispatchConfig;
  parakeetLocal?: ParakeetLocalConfig;
  openaiAsr?: OpenAiAsrConfig;
  sanitizer: SanitizerConfig;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return defaultValue;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseTtsProvider(value: string | undefined): TtsProvider {
  if (!value) {
    return "elevenlabs";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "elevenlabs") {
    return "elevenlabs";
  }

  if (normalized === "kokoro_local") {
    return "kokoro_local";
  }

  return "elevenlabs";
}

function parseAsrProvider(value: string | undefined): AsrProvider {
  if (!value) {
    return "none";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "parakeet_local") {
    return "parakeet_local";
  }

  if (normalized === "openai") {
    return "openai";
  }

  if (normalized === "none") {
    return "none";
  }

  return "none";
}

function parseSessionDispatchProvider(
  value: string | undefined,
  hasTermstationConfig: boolean,
): SessionDispatchProvider {
  if (!value) {
    return hasTermstationConfig ? "termstation" : "none";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "termstation") {
    return "termstation";
  }

  if (normalized === "none") {
    return "none";
  }

  return hasTermstationConfig ? "termstation" : "none";
}

function parseSampleRateFromOutputFormat(format: string): number {
  const match = /^pcm_(\d+)$/.exec(format.trim().toLowerCase());
  if (!match) {
    return 24000;
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 24000;
  }

  return Math.floor(parsed);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

function loadSshConfig(env: NodeJS.ProcessEnv, prefix: string): SshConfig | undefined {
  const target = parseOptionalString(env[`${prefix}_SSH_TARGET`]);
  if (!target) {
    return undefined;
  }

  const port = parseOptionalPositiveInt(env[`${prefix}_SSH_PORT`]);
  const identityFile = parseOptionalString(env[`${prefix}_SSH_IDENTITY_FILE`]);

  return {
    target,
    ...(port ? { port } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

const DEFAULT_ELEVENLABS_TTS_VOICE_ID = "VUGQSU6BSEjkbudnJbOj";
const DEFAULT_KOKORO_MODEL_ID = "hexgrad/Kokoro-82M";
const DEFAULT_KOKORO_VOICE_ID = "af_heart";
const DEFAULT_KOKORO_LANG_CODE = "a";
const DEFAULT_PARAKEET_MODEL_ID = "nvidia/parakeet-ctc-0.6b";
const DEFAULT_OPENAI_ASR_MODEL_ID = "gpt-4o-mini-transcribe";
const DEFAULT_OPENAI_ASR_BASE_URL = "https://api.openai.com";
const DEFAULT_SESSION_DISPATCH_CANNED_MESSAGE =
  "Use the agent-voice-adapter-cli skill to continue the conversation with the user.";

function requireEnv(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const fileEnv = loadFileConfigEnv(env);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  const provider = parseTtsProvider(env.TTS_PROVIDER);
  const asrProvider = parseAsrProvider(env.ASR_PROVIDER);
  const listenHost = env.LISTEN_HOST?.trim() || undefined;
  const defaultKokoroScriptPath = path.resolve(__dirname, "../../scripts/kokoro_daemon.py");
  const defaultParakeetScriptPath = path.resolve(__dirname, "../../scripts/parakeet_daemon.py");
  const kokoroSsh = loadSshConfig(env, "KOKORO_LOCAL");
  const parakeetSsh = loadSshConfig(env, "PARAKEET_LOCAL");
  const recognitionCompletionTimeoutMs = parsePositiveInt(
    env.ASR_RECOGNITION_COMPLETION_TIMEOUT_MS ?? env.ASR_RECOGNITION_TIMEOUT_MS,
    60000,
  );
  const recognitionStartTimeoutMs = parsePositiveInt(env.ASR_RECOGNITION_START_TIMEOUT_MS, 30000);
  const recognitionEndSilenceMs = parsePositiveInt(env.ASR_RECOGNITION_END_SILENCE_MS, 1200);
  const queueAdvanceDelayMs = parseNonNegativeInt(
    env.WAIT_FOR_RECOGNITION_QUEUE_ADVANCE_DELAY_MS,
    2000,
  );
  const wakeIntentAllowRemote = parseBoolean(env.WAKE_INTENT_ALLOW_REMOTE, false);
  const wakeIntentSharedSecret = parseOptionalString(env.WAKE_INTENT_SHARED_SECRET);
  const httpJsonBodyLimit = parseOptionalString(env.HTTP_JSON_BODY_LIMIT) ?? "1mb";
  const termstationSessionDispatchApiBaseUrl = parseOptionalString(
    env.SESSION_DISPATCH_TERMSTATION_API_BASE_URL ?? env.TERMSTATION_URL,
  );
  const sessionDispatchProvider = parseSessionDispatchProvider(
    env.SESSION_DISPATCH_PROVIDER,
    Boolean(termstationSessionDispatchApiBaseUrl),
  );
  const sessionDispatchCannedMessage =
    parseOptionalString(env.SESSION_DISPATCH_CANNED_MESSAGE) ??
    DEFAULT_SESSION_DISPATCH_CANNED_MESSAGE;
  const prependLinkedSessionLabelForTts = parseBoolean(
    env.SESSION_DISPATCH_PREPEND_LINKED_SESSION_LABEL_FOR_TTS,
    false,
  );
  const sessionDispatchRequestTimeoutMs = parsePositiveInt(
    env.SESSION_DISPATCH_TERMSTATION_TIMEOUT_MS,
    10000,
  );
  const sessionDispatch =
    sessionDispatchProvider === "termstation"
      ? {
          provider: "termstation" as const,
          cannedMessage: sessionDispatchCannedMessage,
          prependLinkedSessionLabelForTts,
          termstation: {
            apiBaseUrl: requireEnv(
              termstationSessionDispatchApiBaseUrl,
              "SESSION_DISPATCH_TERMSTATION_API_BASE_URL",
            ),
            username: parseOptionalString(
              env.SESSION_DISPATCH_TERMSTATION_USERNAME ?? env.TERMSTATION_AUTH_USER,
            ),
            password: parseOptionalString(
              env.SESSION_DISPATCH_TERMSTATION_PASSWORD ?? env.TERMSTATION_AUTH_PASS,
            ),
            requestTimeoutMs: sessionDispatchRequestTimeoutMs,
          },
        }
      : {
          provider: "none" as const,
          cannedMessage: sessionDispatchCannedMessage,
          prependLinkedSessionLabelForTts,
        };

  const parakeetModelId =
    (env.PARAKEET_LOCAL_MODEL_ID ?? DEFAULT_PARAKEET_MODEL_ID).trim() || DEFAULT_PARAKEET_MODEL_ID;
  const openaiAsrModelId =
    (env.OPENAI_ASR_MODEL ?? DEFAULT_OPENAI_ASR_MODEL_ID).trim() || DEFAULT_OPENAI_ASR_MODEL_ID;

  const parseDeviceOption = (value: string | undefined): "cuda" | "cpu" | "auto" => {
    const raw = (value ?? "auto").trim().toLowerCase();
    return raw === "cuda" || raw === "cpu" ? raw : "auto";
  };

  const asrDefaultModelId =
    asrProvider === "parakeet_local"
      ? parakeetModelId
      : asrProvider === "openai"
        ? openaiAsrModelId
        : null;

  const asr = {
    provider: asrProvider,
    defaultModelId: asrDefaultModelId,
    recognitionStartTimeoutMs,
    recognitionCompletionTimeoutMs,
    recognitionEndSilenceMs,
    queueAdvanceDelayMs,
  };

  const parakeetLocal: ParakeetLocalConfig | undefined =
    asrProvider === "parakeet_local"
      ? {
          pythonBin: (env.PARAKEET_LOCAL_PYTHON_BIN ?? "python3").trim() || "python3",
          scriptPath:
            (env.PARAKEET_LOCAL_SCRIPT_PATH ?? defaultParakeetScriptPath).trim() ||
            defaultParakeetScriptPath,
          ...(parakeetSsh ? { ssh: parakeetSsh } : {}),
          modelId: parakeetModelId,
          device: parseDeviceOption(env.PARAKEET_LOCAL_DEVICE),
          timeoutMs: parsePositiveInt(env.PARAKEET_LOCAL_TIMEOUT_MS, 90000),
        }
      : undefined;

  const openaiAsrLanguage = parseOptionalString(env.OPENAI_ASR_LANGUAGE);
  const openaiAsr: OpenAiAsrConfig | undefined =
    asrProvider === "openai"
      ? {
          apiKey: requireEnv(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
          modelId: openaiAsrModelId,
          baseUrl:
            (env.OPENAI_ASR_BASE_URL ?? DEFAULT_OPENAI_ASR_BASE_URL).trim() ||
            DEFAULT_OPENAI_ASR_BASE_URL,
          ...(openaiAsrLanguage ? { language: openaiAsrLanguage } : {}),
          timeoutMs: parsePositiveInt(env.OPENAI_ASR_TIMEOUT_MS, 60000),
        }
      : undefined;

  const wakeIntent = {
    allowRemote: wakeIntentAllowRemote,
    ...(wakeIntentSharedSecret ? { sharedSecret: wakeIntentSharedSecret } : {}),
  };

  const sanitizer: SanitizerConfig = {
    stripBackticks: parseBoolean(env.TTS_SANITIZE_STRIP_BACKTICKS, true),
    stripMarkdownArtifacts: parseBoolean(env.TTS_SANITIZE_STRIP_MARKDOWN, true),
    stripUrlProtocol: parseBoolean(env.TTS_SANITIZE_STRIP_URL_PROTOCOL, true),
    collapseWhitespace: parseBoolean(env.TTS_SANITIZE_COLLAPSE_WHITESPACE, true),
    maxTextChars: parsePositiveInt(env.TTS_MAX_TEXT_CHARS, 5000),
  };

  const shared = {
    port: parsePositiveInt(env.PORT, 4300),
    listenHost,
    wsPath: "/ws" as const,
    http: { jsonBodyLimit: httpJsonBodyLimit },
    asr,
    parakeetLocal,
    openaiAsr,
    wakeIntent,
    sessionDispatch,
    sanitizer,
  };

  if (provider === "kokoro_local") {
    const modelId = (env.KOKORO_LOCAL_MODEL_ID ?? DEFAULT_KOKORO_MODEL_ID).trim();
    const voiceId = (env.KOKORO_LOCAL_VOICE_ID ?? DEFAULT_KOKORO_VOICE_ID).trim();
    const langCode = (env.KOKORO_LOCAL_LANG_CODE ?? DEFAULT_KOKORO_LANG_CODE).trim();
    const sampleRate = parsePositiveInt(env.KOKORO_LOCAL_SAMPLE_RATE, 24000);
    const speed = parsePositiveNumber(env.KOKORO_LOCAL_SPEED, 1.0);

    return {
      ...shared,
      tts: {
        provider: "kokoro_local" as const,
        outputSampleRate: sampleRate,
        defaultModelId: modelId,
        defaultVoiceId: voiceId,
      },
      kokoroLocal: {
        pythonBin: (env.KOKORO_LOCAL_PYTHON_BIN ?? "python3").trim() || "python3",
        scriptPath:
          (env.KOKORO_LOCAL_SCRIPT_PATH ?? defaultKokoroScriptPath).trim() ||
          defaultKokoroScriptPath,
        ...(kokoroSsh ? { ssh: kokoroSsh } : {}),
        voiceId,
        modelId,
        langCode,
        speed,
        device: parseDeviceOption(env.KOKORO_LOCAL_DEVICE),
        maxTextCharsPerChunk: parsePositiveInt(env.KOKORO_LOCAL_MAX_CHARS, 850),
        gapMsBetweenChunks: parseNonNegativeInt(env.KOKORO_LOCAL_GAP_MS, 0),
        sampleRate,
      },
    };
  }

  const outputFormat = (env.ELEVENLABS_TTS_OUTPUT_FORMAT ?? "pcm_24000").trim() || "pcm_24000";
  const modelId =
    (env.ELEVENLABS_TTS_MODEL ?? "eleven_multilingual_v2").trim() || "eleven_multilingual_v2";
  const voiceId =
    (env.ELEVENLABS_TTS_VOICE_ID ?? DEFAULT_ELEVENLABS_TTS_VOICE_ID).trim() ||
    DEFAULT_ELEVENLABS_TTS_VOICE_ID;

  return {
    ...shared,
    tts: {
      provider: "elevenlabs" as const,
      outputSampleRate: parseSampleRateFromOutputFormat(outputFormat),
      defaultModelId: modelId,
      defaultVoiceId: voiceId,
    },
    elevenLabs: {
      apiKey: requireEnv(env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY"),
      voiceId,
      modelId,
      baseUrl:
        (env.ELEVENLABS_TTS_BASE_URL ?? "https://api.elevenlabs.io").trim() ||
        "https://api.elevenlabs.io",
      outputFormat,
    },
  };
}
