import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WAKE_PREFIX_REGEX = /^(?:hey|hi|ok|okay)?\s*agent[\s,:-]*/i;
const DATE_HINT_REGEX = /\b(date|time|day|today|now)\b/i;
const ECHO_VERB_REGEX = /\b(echo|say|repeat|print)\b/i;
const ASSISTANT_KEYWORD_REGEX = /\bassistant\b/i;
const ASSISTANT_MODEL_ID = "openai-codex/gpt-5.3-codex:minimal";
const ASSISTANT_SESSION_FILE = "assistant.jsonl";
const ASSISTANT_SSH_HOST = "srv";
const ASSISTANT_TIMEOUT_MS = 120_000;
const ASSISTANT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export type WakeIntentAction = "date" | "echo" | "assistant" | "clarify";

export interface WakeIntentParseResult {
  action: WakeIntentAction;
  confidence: number;
  originalText: string;
  normalizedText: string;
  strippedText: string;
  args: {
    text?: string;
  };
  matchedRuleIds: string[];
}

export interface WakeIntentExecutionResult {
  executed: boolean;
  output?: string;
  error?: string;
}

export type WakeIntentExecRunner = (
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{
  stdout: string;
  stderr: string;
}>;

export interface WakeIntentLogger {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

interface CommandErrorDetails {
  message: string;
  code?: string | number;
  signal?: string;
}

function defaultExecRunner(
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
  },
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return execFileAsync(file, args, options).then(({ stdout, stderr }) => ({
    stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
    stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
  }));
}

function quoteShellArg(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildAssistantRemoteCommand(promptText: string): string {
  return [
    "cd ~ && pi",
    "--model",
    quoteShellArg(ASSISTANT_MODEL_ID),
    "--session",
    quoteShellArg(ASSISTANT_SESSION_FILE),
    "-p",
    quoteShellArg(promptText),
  ].join(" ");
}

function extractCommandErrorDetails(error: unknown): CommandErrorDetails {
  if (!error || typeof error !== "object") {
    return {
      message: String(error),
    };
  }

  const maybeCode = Reflect.get(error, "code");
  const maybeSignal = Reflect.get(error, "signal");
  const maybeMessage = Reflect.get(error, "message");

  return {
    message: typeof maybeMessage === "string" ? maybeMessage : String(error),
    code: typeof maybeCode === "string" || typeof maybeCode === "number" ? maybeCode : undefined,
    signal: typeof maybeSignal === "string" ? maybeSignal : undefined,
  };
}

export function normalizeWakeIntentText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripWakePrefix(input: string): string {
  const stripped = input.replace(WAKE_PREFIX_REGEX, "").trim();
  return stripped;
}

export function parseWakeIntent(input: string): WakeIntentParseResult {
  const originalText = input;
  const normalizedText = normalizeWakeIntentText(input);
  const strippedText = stripWakePrefix(normalizedText);
  const matchedRuleIds: string[] = [];

  const assistantMatch = ASSISTANT_KEYWORD_REGEX.exec(strippedText);
  if (assistantMatch && typeof assistantMatch.index === "number") {
    const tail = strippedText.slice(assistantMatch.index + assistantMatch[0].length).trim();
    matchedRuleIds.push("assistant-keyword");
    if (tail.length > 0) {
      matchedRuleIds.push("assistant-tail-present");
      return {
        action: "assistant",
        confidence: 0.97,
        originalText,
        normalizedText,
        strippedText,
        args: {
          text: tail,
        },
        matchedRuleIds,
      };
    }

    return {
      action: "clarify",
      confidence: 0.52,
      originalText,
      normalizedText,
      strippedText,
      args: {},
      matchedRuleIds: [...matchedRuleIds, "assistant-tail-missing"],
    };
  }

  const echoMatch = ECHO_VERB_REGEX.exec(strippedText);
  if (echoMatch && typeof echoMatch.index === "number") {
    const tail = strippedText.slice(echoMatch.index + echoMatch[0].length).trim();
    matchedRuleIds.push("echo-verb");
    if (tail.length > 0) {
      matchedRuleIds.push("echo-tail-present");
      return {
        action: "echo",
        confidence: 0.96,
        originalText,
        normalizedText,
        strippedText,
        args: {
          text: tail,
        },
        matchedRuleIds,
      };
    }

    return {
      action: "clarify",
      confidence: 0.51,
      originalText,
      normalizedText,
      strippedText,
      args: {},
      matchedRuleIds: [...matchedRuleIds, "echo-tail-missing"],
    };
  }

  if (DATE_HINT_REGEX.test(strippedText)) {
    matchedRuleIds.push("date-hints");
    return {
      action: "date",
      confidence: 0.9,
      originalText,
      normalizedText,
      strippedText,
      args: {},
      matchedRuleIds,
    };
  }

  return {
    action: "clarify",
    confidence: 0.35,
    originalText,
    normalizedText,
    strippedText,
    args: {},
    matchedRuleIds: ["fallback-clarify"],
  };
}

export async function executeWakeIntent(
  intent: WakeIntentParseResult,
  options?: {
    execRunner?: WakeIntentExecRunner;
    logger?: WakeIntentLogger;
  },
): Promise<WakeIntentExecutionResult> {
  const execRunner = options?.execRunner ?? defaultExecRunner;
  const logger = options?.logger;

  if (intent.action === "echo") {
    return {
      executed: true,
      output: intent.args.text ?? "",
    };
  }

  if (intent.action === "date") {
    try {
      const { stdout } = await execRunner("date", [], {
        timeout: 2_000,
      });

      return {
        executed: true,
        output: stdout.trim(),
      };
    } catch (error) {
      return {
        executed: false,
        error: `date command failed: ${String(error)}`,
      };
    }
  }

  if (intent.action === "assistant") {
    const promptText = intent.args.text?.trim();
    if (!promptText) {
      return {
        executed: false,
        error: "clarify",
      };
    }

    const startedAt = Date.now();
    try {
      const remoteCommand = buildAssistantRemoteCommand(promptText);
      logger?.info?.("wake_intent_assistant_started", {
        command: "ssh",
        argsPrefix: ["-n", ASSISTANT_SSH_HOST],
        host: ASSISTANT_SSH_HOST,
        remoteCommand,
        promptChars: promptText.length,
      });
      const { stdout, stderr } = await execRunner(
        "ssh",
        ["-n", ASSISTANT_SSH_HOST, remoteCommand],
        {
          timeout: ASSISTANT_TIMEOUT_MS,
          maxBuffer: ASSISTANT_MAX_BUFFER_BYTES,
        },
      );
      const combinedOutput = `${stdout}${stderr}`.trim();
      logger?.info?.("wake_intent_assistant_exited", {
        success: true,
        durationMs: Date.now() - startedAt,
        outputChars: combinedOutput.length,
      });

      return {
        executed: true,
        output: combinedOutput || "(no output)",
      };
    } catch (error) {
      const details = extractCommandErrorDetails(error);
      logger?.error?.("wake_intent_assistant_exited", {
        success: false,
        durationMs: Date.now() - startedAt,
        error: details.message,
        code: details.code,
        signal: details.signal,
      });
      return {
        executed: false,
        error: `assistant command failed: ${String(error)}`,
      };
    }
  }

  return {
    executed: false,
    error: "clarify",
  };
}
