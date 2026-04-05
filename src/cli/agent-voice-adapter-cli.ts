#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

// Replaced during build by scripts/embed-cli-version.mjs so copied single-file CLI builds
// can still answer --version without requiring neighboring files.
const EMBEDDED_CLI_VERSION = "__EMBEDDED_CLI_VERSION__";
const DEFAULT_CLI_LISTEN_COMPLETION_TIMEOUT_MS = 120000;

export interface ParsedArgs {
  apiBaseUrl: string;
  text: string;
  quickReplies?: Array<{
    label: string;
    text: string;
  }>;
  attachment?: {
    dataBase64: string;
    fileName?: string;
    contentType: string;
  };
  sessionId?: string;
  model?: string;
  voice?: string;
  wakeIntentSharedSecret?: string;
  debugTts: boolean;
  listen: boolean;
  listenStartTimeoutMs?: number;
  listenCompletionTimeoutMs?: number;
  listenModel?: string;
  requestTimeoutMs: number;
  verbose: boolean;
}

function printHelp(): void {
  const help = `agent-voice-adapter-cli <text> [--url <api-base-url>] [--model <model-id>] [--voice <voice-id>] [--quick-reply <label[::text]>] [--attachment <text> | --attachment-file <path>] [--attachment-content-type <mime-type>] [--wake-intent-shared-secret <secret>] [--request-timeout-ms <ms>] [--debug-tts] [--no-wait] [--verbose] [--version]

Environment:
  AGENT_VOICE_ADAPTER_API_URL   Base API URL (default: http://localhost:4300)
  SESSION_ID   Optional linked session id (forwarded as sessionId)
  AGENT_VOICE_ADAPTER_WAKE_INTENT_SHARED_SECRET   Optional x-wake-intent-secret header value
  AGENT_VOICE_ADAPTER_REQUEST_TIMEOUT_MS   HTTP request timeout in ms (default: 300000)

Examples:
  agent-voice-adapter-cli "Hello from TTS"
  agent-voice-adapter-cli --no-wait "One-shot (no listen wait)"
  agent-voice-adapter-cli --listen-timeout-ms 15000 "Respond now"
  agent-voice-adapter-cli --listen-start-timeout-ms 30000 --listen-completion-timeout-ms 120000 "Respond now"
  agent-voice-adapter-cli --listen-model nvidia/parakeet-ctc-0.6b "Prompt"
  agent-voice-adapter-cli --request-timeout-ms 120000 "Prompt"
  agent-voice-adapter-cli --debug-tts "Return resolved TTS debug metadata"
  agent-voice-adapter-cli --verbose "Print full server JSON response"
  agent-voice-adapter-cli --attachment "Checklist:\\n- one\\n- two" "Prompt with inline attachment"
  agent-voice-adapter-cli --attachment-file ./notes.md "Prompt with file attachment"
  agent-voice-adapter-cli --attachment-file ./notes.md --attachment-content-type text/plain "Prompt with override MIME"
  agent-voice-adapter-cli --quick-reply "Yes" --quick-reply "Wait::Please wait." "Question with quick replies"
  agent-voice-adapter-cli --no-wait --quick-reply "Yes" --quick-reply "No" "One-shot prompt with quick replies"
  agent-voice-adapter-cli --model eleven_multilingual_v2 "Custom model"
  agent-voice-adapter-cli --voice VUGQSU6BSEjkbudnJbOj "Custom voice"
  agent-voice-adapter-cli --wake-intent-shared-secret my-secret "Send with wake-intent secret header"
  AGENT_VOICE_ADAPTER_API_URL=http://localhost:4400 agent-voice-adapter-cli "Custom URL"
  AGENT_VOICE_ADAPTER_WAKE_INTENT_SHARED_SECRET=my-secret agent-voice-adapter-cli "Custom header from env"
  agent-voice-adapter-cli --url http://localhost:4300 --model eleven_flash_v2_5 --voice test "Hello"
`;
  process.stdout.write(help);
}

export function resolveCliVersion(packageJsonRaw: string | null): string {
  if (packageJsonRaw) {
    try {
      const packageJson = JSON.parse(packageJsonRaw) as { version?: unknown };
      if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
        return packageJson.version.trim();
      }
    } catch {
      // Fall through to embedded version.
    }
  }

  if (typeof EMBEDDED_CLI_VERSION === "string" && EMBEDDED_CLI_VERSION.trim().length > 0) {
    return EMBEDDED_CLI_VERSION.trim();
  }

  throw new Error("Unable to determine CLI version");
}

function getCliVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "../../package.json");
  const packageJsonRaw = (() => {
    try {
      return readFileSync(packageJsonPath, "utf8");
    } catch {
      return null;
    }
  })();

  return resolveCliVersion(packageJsonRaw);
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function inferAttachmentContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".xml":
      return "application/xml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "application/javascript";
    case ".ts":
    case ".tsx":
      return "text/plain";
    case ".py":
      return "text/x-python";
    case ".java":
      return "text/x-java-source";
    case ".kt":
    case ".kts":
      return "text/x-kotlin";
    case ".c":
    case ".h":
      return "text/x-c";
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
    case ".hxx":
      return "text/x-c++src";
    case ".sh":
      return "application/x-sh";
    case ".csv":
      return "text/csv";
    case ".zip":
      return "application/zip";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".pdf":
      return "application/pdf";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain";
  }
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function parseArgs(argv: string[]): Promise<ParsedArgs | null> {
  let apiBaseUrl = process.env.AGENT_VOICE_ADAPTER_API_URL?.trim() || "http://localhost:4300";
  let wakeIntentSharedSecret = process.env.AGENT_VOICE_ADAPTER_WAKE_INTENT_SHARED_SECRET?.trim();
  let requestTimeoutMs = (() => {
    const raw = process.env.AGENT_VOICE_ADAPTER_REQUEST_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
      return 300000;
    }
    return Math.floor(parsed);
  })();
  const inferredSessionId = (
    process.env.SESSION_ID?.trim() || process.env.AGENT_VOICE_ADAPTER_SESSION_ID?.trim()
  )?.trim();
  const sessionId =
    inferredSessionId && inferredSessionId.length > 0 ? inferredSessionId : undefined;
  let model: string | undefined;
  let voice: string | undefined;
  let debugTts = false;
  let listen = true;
  let listenStartTimeoutMs: number | undefined;
  let listenCompletionTimeoutMs: number | undefined;
  let listenModel: string | undefined;
  let attachmentText: string | undefined;
  let attachmentFilePath: string | undefined;
  let attachmentContentType: string | undefined;
  const quickReplies: Array<{ label: string; text: string }> = [];
  let verbose = false;
  const textParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      textParts.push(...argv.slice(index + 1));
      break;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      return null;
    }

    if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${getCliVersion()}\n`);
      return null;
    }

    if (arg === "--url") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--url requires a value");
      }
      apiBaseUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--model") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--model requires a value");
      }
      model = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--voice") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--voice requires a value");
      }
      voice = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--wake-intent-shared-secret") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--wake-intent-shared-secret requires a value");
      }
      const trimmed = value.trim();
      wakeIntentSharedSecret = trimmed.length > 0 ? trimmed : undefined;
      index += 1;
      continue;
    }

    if (arg === "--request-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--request-timeout-ms requires a value");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--request-timeout-ms must be a positive integer");
      }
      requestTimeoutMs = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--debug-tts") {
      debugTts = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--listen" || arg === "--wait") {
      listen = true;
      continue;
    }

    if (arg === "--no-wait" || arg === "--no-listen") {
      listen = false;
      continue;
    }

    if (arg === "--listen-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--listen-timeout-ms requires a value");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--listen-timeout-ms must be a positive integer");
      }

      listenCompletionTimeoutMs = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--listen-start-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--listen-start-timeout-ms requires a value");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--listen-start-timeout-ms must be a positive integer");
      }

      listenStartTimeoutMs = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--listen-completion-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--listen-completion-timeout-ms requires a value");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--listen-completion-timeout-ms must be a positive integer");
      }

      listenCompletionTimeoutMs = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--listen-model") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--listen-model requires a value");
      }
      listenModel = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--attachment") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--attachment requires a value");
      }
      attachmentText = value;
      index += 1;
      continue;
    }

    if (arg === "--attachment-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--attachment-file requires a value");
      }
      attachmentFilePath = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--attachment-content-type") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--attachment-content-type requires a value");
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        throw new Error("--attachment-content-type requires a non-empty value");
      }
      attachmentContentType = trimmed;
      index += 1;
      continue;
    }

    if (arg === "--quick-reply") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--quick-reply requires a value");
      }
      const raw = value.trim();
      if (raw.length === 0) {
        throw new Error("--quick-reply requires a non-empty value");
      }

      const splitIndex = raw.indexOf("::");
      const label = (splitIndex >= 0 ? raw.slice(0, splitIndex) : raw).trim();
      const text = (splitIndex >= 0 ? raw.slice(splitIndex + 2) : raw).trim();
      if (!label) {
        throw new Error("--quick-reply label must be non-empty");
      }
      if (!text) {
        throw new Error("--quick-reply text must be non-empty");
      }
      quickReplies.push({
        label,
        text,
      });
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    textParts.push(arg);
  }

  let text = textParts.join(" ").trim();

  if (!text && !process.stdin.isTTY) {
    text = await readStdin();
  }

  if (!text) {
    throw new Error("No text provided. Pass text as arguments or pipe from stdin.");
  }

  if (attachmentText && attachmentFilePath) {
    throw new Error("--attachment and --attachment-file are mutually exclusive");
  }

  if (attachmentContentType && !attachmentText && !attachmentFilePath) {
    throw new Error("--attachment-content-type requires --attachment or --attachment-file");
  }
  if (quickReplies.length > 8) {
    throw new Error("--quick-reply supports at most 8 entries");
  }

  let attachment:
    | {
        dataBase64: string;
        fileName?: string;
        contentType: string;
      }
    | undefined;

  if (attachmentText) {
    attachment = {
      dataBase64: Buffer.from(attachmentText, "utf8").toString("base64"),
      contentType: attachmentContentType ?? "text/plain",
    };
  }

  if (attachmentFilePath) {
    let fileBytes: Buffer;
    try {
      fileBytes = readFileSync(attachmentFilePath);
    } catch (error) {
      throw new Error(
        `Unable to read attachment file: ${attachmentFilePath} (${normalizeError(error)})`,
      );
    }
    attachment = {
      dataBase64: fileBytes.toString("base64"),
      fileName: path.basename(attachmentFilePath),
      contentType: attachmentContentType ?? inferAttachmentContentType(attachmentFilePath),
    };
  }

  if (listen && typeof listenCompletionTimeoutMs !== "number") {
    listenCompletionTimeoutMs = DEFAULT_CLI_LISTEN_COMPLETION_TIMEOUT_MS;
  }

  return {
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
    text,
    ...(quickReplies.length > 0 ? { quickReplies } : {}),
    attachment,
    sessionId,
    model,
    voice,
    wakeIntentSharedSecret,
    debugTts,
    listen,
    listenStartTimeoutMs,
    listenCompletionTimeoutMs,
    listenModel,
    requestTimeoutMs,
    verbose,
  };
}

interface TurnPayload {
  text: string;
  quickReplies?: Array<{
    label: string;
    text: string;
  }>;
  attachment?: {
    dataBase64: string;
    fileName?: string;
    contentType: string;
  };
  sessionId?: string;
  model?: string;
  voice?: string;
  debugTts?: boolean;
  listen?: boolean;
  listenStartTimeoutMs?: number;
  listenCompletionTimeoutMs?: number;
  listenModel?: string;
}

export function createTurnPayload(parsed: ParsedArgs): TurnPayload {
  const payload: TurnPayload = {
    text: parsed.text,
  };

  if (parsed.quickReplies && parsed.quickReplies.length > 0) {
    payload.quickReplies = parsed.quickReplies;
  }

  if (parsed.attachment) {
    payload.attachment = parsed.attachment;
  }

  if (parsed.sessionId) {
    payload.sessionId = parsed.sessionId;
  }
  if (parsed.model) {
    payload.model = parsed.model;
  }
  if (parsed.voice) {
    payload.voice = parsed.voice;
  }
  if (parsed.debugTts) {
    payload.debugTts = true;
  }
  if (parsed.listen) {
    payload.listen = true;
    if (typeof parsed.listenStartTimeoutMs === "number") {
      payload.listenStartTimeoutMs = parsed.listenStartTimeoutMs;
    }
    if (typeof parsed.listenCompletionTimeoutMs === "number") {
      payload.listenCompletionTimeoutMs = parsed.listenCompletionTimeoutMs;
    }
    if (parsed.listenModel) {
      payload.listenModel = parsed.listenModel;
    }
  }

  return payload;
}

export function createTurnHeaders(parsed: ParsedArgs): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (parsed.wakeIntentSharedSecret) {
    headers["x-wake-intent-secret"] = parsed.wakeIntentSharedSecret;
  }

  return headers;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function createBriefSuccessOutput(responseBody: unknown): unknown {
  const parsed = asObject(responseBody);
  if (!parsed) {
    return responseBody;
  }

  const accepted = parsed.accepted === true;
  if (!accepted) {
    return responseBody;
  }

  const turnId = asNonEmptyString(parsed.turnId);
  const listen = asObject(parsed.listen);
  const hasSuccessfulListen = listen?.success === true;

  if (!hasSuccessfulListen) {
    if (!turnId) {
      return responseBody;
    }
    return { turnId };
  }

  const text = asNonEmptyString(listen?.text);
  const durationMs = asFiniteNumber(listen?.durationMs);
  const timeoutFallbackUsed = listen?.timeoutFallbackUsed === true;
  if (!turnId) {
    return responseBody;
  }

  return {
    turnId,
    ...(text ? { text } : {}),
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    ...(timeoutFallbackUsed ? { timeoutFallbackUsed: true } : {}),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = await parseArgs(argv);
  if (!parsed) {
    return;
  }

  const payload = createTurnPayload(parsed);

  const requestAbortController = new AbortController();
  const requestTimeoutHandle = setTimeout(() => {
    requestAbortController.abort();
  }, parsed.requestTimeoutMs);
  requestTimeoutHandle.unref?.();

  let response: Response;
  try {
    response = await fetch(`${parsed.apiBaseUrl}/api/turn`, {
      method: "POST",
      headers: createTurnHeaders(parsed),
      body: JSON.stringify(payload),
      signal: requestAbortController.signal,
    });
  } catch (error) {
    if (requestAbortController.signal.aborted) {
      throw new Error(`Request timed out after ${parsed.requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(requestTimeoutHandle);
  }

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${bodyText}`);
  }

  let parsedBody: unknown = bodyText;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    // Keep as raw text.
  }

  const output = parsed.verbose ? parsedBody : createBriefSuccessOutput(parsedBody);

  process.stdout.write(
    `${typeof output === "string" ? output : JSON.stringify(output, null, 2)}\n`,
  );
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`agent-voice-adapter-cli error: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
