import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseOptionalString } from "./parseUtils";

function isScalarConfigValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function readNestedConfigValue(config: unknown, segments: string[]): unknown {
  let cursor: unknown = config;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    const record = cursor as Record<string, unknown>;
    cursor = record[segment];
  }
  return cursor;
}

function setFileEnvValue(
  target: NodeJS.ProcessEnv,
  key: string,
  value: unknown,
  transform?: (value: string | number | boolean) => string,
): void {
  if (!isScalarConfigValue(value)) {
    return;
  }

  target[key] = transform ? transform(value) : String(value);
}

export function loadFileConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const requestedPath = parseOptionalString(env.AGENT_VOICE_ADAPTER_CONFIG_FILE);
  const defaultPath = path.resolve(__dirname, "../../config/agent-voice-adapter.json");
  const configPath = requestedPath ?? defaultPath;

  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const parsedObject = parsed as Record<string, unknown>;
  const fileEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(parsedObject)) {
    if (/^[A-Z0-9_]+$/.test(key) && isScalarConfigValue(value)) {
      fileEnv[key] = String(value);
    }
  }

  setFileEnvValue(fileEnv, "PORT", readNestedConfigValue(parsed, ["port"]));
  setFileEnvValue(fileEnv, "LISTEN_HOST", readNestedConfigValue(parsed, ["listenHost"]));
  setFileEnvValue(
    fileEnv,
    "HTTP_JSON_BODY_LIMIT",
    readNestedConfigValue(parsed, ["http", "jsonBodyLimit"]),
  );
  setFileEnvValue(fileEnv, "TTS_PROVIDER", readNestedConfigValue(parsed, ["tts", "provider"]));
  setFileEnvValue(
    fileEnv,
    "ELEVENLABS_API_KEY",
    readNestedConfigValue(parsed, ["elevenLabs", "apiKey"]),
  );
  setFileEnvValue(
    fileEnv,
    "ELEVENLABS_TTS_VOICE_ID",
    readNestedConfigValue(parsed, ["elevenLabs", "voiceId"]),
  );
  setFileEnvValue(
    fileEnv,
    "ELEVENLABS_TTS_MODEL",
    readNestedConfigValue(parsed, ["elevenLabs", "modelId"]),
  );
  setFileEnvValue(
    fileEnv,
    "ELEVENLABS_TTS_BASE_URL",
    readNestedConfigValue(parsed, ["elevenLabs", "baseUrl"]),
  );
  setFileEnvValue(
    fileEnv,
    "ELEVENLABS_TTS_OUTPUT_FORMAT",
    readNestedConfigValue(parsed, ["elevenLabs", "outputFormat"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_PYTHON_BIN",
    readNestedConfigValue(parsed, ["kokoroLocal", "pythonBin"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_SCRIPT_PATH",
    readNestedConfigValue(parsed, ["kokoroLocal", "scriptPath"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_SSH_TARGET",
    readNestedConfigValue(parsed, ["kokoroLocal", "ssh", "target"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_SSH_PORT",
    readNestedConfigValue(parsed, ["kokoroLocal", "ssh", "port"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_SSH_IDENTITY_FILE",
    readNestedConfigValue(parsed, ["kokoroLocal", "ssh", "identityFile"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_MODEL_ID",
    readNestedConfigValue(parsed, ["kokoroLocal", "modelId"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_VOICE_ID",
    readNestedConfigValue(parsed, ["kokoroLocal", "voiceId"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_LANG_CODE",
    readNestedConfigValue(parsed, ["kokoroLocal", "langCode"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_SPEED",
    readNestedConfigValue(parsed, ["kokoroLocal", "speed"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_DEVICE",
    readNestedConfigValue(parsed, ["kokoroLocal", "device"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_MAX_CHARS",
    readNestedConfigValue(parsed, ["kokoroLocal", "maxTextCharsPerChunk"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_GAP_MS",
    readNestedConfigValue(parsed, ["kokoroLocal", "gapMsBetweenChunks"]),
  );
  setFileEnvValue(
    fileEnv,
    "KOKORO_LOCAL_SAMPLE_RATE",
    readNestedConfigValue(parsed, ["kokoroLocal", "sampleRate"]),
  );
  setFileEnvValue(fileEnv, "ASR_PROVIDER", readNestedConfigValue(parsed, ["asr", "provider"]));
  setFileEnvValue(
    fileEnv,
    "ASR_RECOGNITION_START_TIMEOUT_MS",
    readNestedConfigValue(parsed, ["asr", "recognitionStartTimeoutMs"]),
  );
  setFileEnvValue(
    fileEnv,
    "ASR_RECOGNITION_COMPLETION_TIMEOUT_MS",
    readNestedConfigValue(parsed, ["asr", "recognitionCompletionTimeoutMs"]),
  );
  setFileEnvValue(
    fileEnv,
    "ASR_RECOGNITION_END_SILENCE_MS",
    readNestedConfigValue(parsed, ["asr", "recognitionEndSilenceMs"]),
  );
  setFileEnvValue(
    fileEnv,
    "WAIT_FOR_RECOGNITION_QUEUE_ADVANCE_DELAY_MS",
    readNestedConfigValue(parsed, ["asr", "queueAdvanceDelayMs"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_PYTHON_BIN",
    readNestedConfigValue(parsed, ["parakeetLocal", "pythonBin"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_SCRIPT_PATH",
    readNestedConfigValue(parsed, ["parakeetLocal", "scriptPath"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_SSH_TARGET",
    readNestedConfigValue(parsed, ["parakeetLocal", "ssh", "target"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_SSH_PORT",
    readNestedConfigValue(parsed, ["parakeetLocal", "ssh", "port"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_SSH_IDENTITY_FILE",
    readNestedConfigValue(parsed, ["parakeetLocal", "ssh", "identityFile"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_MODEL_ID",
    readNestedConfigValue(parsed, ["parakeetLocal", "modelId"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_DEVICE",
    readNestedConfigValue(parsed, ["parakeetLocal", "device"]),
  );
  setFileEnvValue(
    fileEnv,
    "PARAKEET_LOCAL_TIMEOUT_MS",
    readNestedConfigValue(parsed, ["parakeetLocal", "timeoutMs"]),
  );
  setFileEnvValue(
    fileEnv,
    "OPENAI_API_KEY",
    readNestedConfigValue(parsed, ["openaiAsr", "apiKey"]),
  );
  setFileEnvValue(
    fileEnv,
    "OPENAI_ASR_MODEL",
    readNestedConfigValue(parsed, ["openaiAsr", "modelId"]),
  );
  setFileEnvValue(
    fileEnv,
    "OPENAI_ASR_BASE_URL",
    readNestedConfigValue(parsed, ["openaiAsr", "baseUrl"]),
  );
  setFileEnvValue(
    fileEnv,
    "OPENAI_ASR_LANGUAGE",
    readNestedConfigValue(parsed, ["openaiAsr", "language"]),
  );
  setFileEnvValue(
    fileEnv,
    "OPENAI_ASR_TIMEOUT_MS",
    readNestedConfigValue(parsed, ["openaiAsr", "timeoutMs"]),
  );
  setFileEnvValue(
    fileEnv,
    "TTS_SANITIZE_STRIP_BACKTICKS",
    readNestedConfigValue(parsed, ["sanitizer", "stripBackticks"]),
  );
  setFileEnvValue(
    fileEnv,
    "TTS_SANITIZE_STRIP_MARKDOWN",
    readNestedConfigValue(parsed, ["sanitizer", "stripMarkdownArtifacts"]),
  );
  setFileEnvValue(
    fileEnv,
    "TTS_SANITIZE_STRIP_URL_PROTOCOL",
    readNestedConfigValue(parsed, ["sanitizer", "stripUrlProtocol"]),
  );
  setFileEnvValue(
    fileEnv,
    "TTS_SANITIZE_STRIP_EMOJI",
    readNestedConfigValue(parsed, ["sanitizer", "stripEmoji"]),
  );
  setFileEnvValue(
    fileEnv,
    "TTS_SANITIZE_COLLAPSE_WHITESPACE",
    readNestedConfigValue(parsed, ["sanitizer", "collapseWhitespace"]),
  );
  setFileEnvValue(
    fileEnv,
    "TTS_MAX_TEXT_CHARS",
    readNestedConfigValue(parsed, ["sanitizer", "maxTextChars"]),
  );
  setFileEnvValue(
    fileEnv,
    "WAKE_INTENT_ALLOW_REMOTE",
    readNestedConfigValue(parsed, ["wakeIntent", "allowRemote"]),
  );
  setFileEnvValue(
    fileEnv,
    "WAKE_INTENT_SHARED_SECRET",
    readNestedConfigValue(parsed, ["wakeIntent", "sharedSecret"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_PROVIDER",
    readNestedConfigValue(parsed, ["sessionDispatch", "provider"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_CANNED_MESSAGE",
    readNestedConfigValue(parsed, ["sessionDispatch", "cannedMessage"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_PREPEND_LINKED_SESSION_LABEL_FOR_TTS",
    readNestedConfigValue(parsed, ["sessionDispatch", "prependLinkedSessionLabelForTts"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_TERMSTATION_API_BASE_URL",
    readNestedConfigValue(parsed, ["sessionDispatch", "termstation", "apiBaseUrl"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_TERMSTATION_USERNAME",
    readNestedConfigValue(parsed, ["sessionDispatch", "termstation", "username"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_TERMSTATION_PASSWORD",
    readNestedConfigValue(parsed, ["sessionDispatch", "termstation", "password"]),
  );
  setFileEnvValue(
    fileEnv,
    "SESSION_DISPATCH_TERMSTATION_TIMEOUT_MS",
    readNestedConfigValue(parsed, ["sessionDispatch", "termstation", "requestTimeoutMs"]),
  );

  return fileEnv;
}
