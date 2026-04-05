import type { AppConfig, SessionDispatchTermstationConfig } from "./config";
import { parseOptionalString } from "./parseUtils";

export type SessionSendMode = "canned" | "custom";

export interface SessionSummary {
  sessionId: string;
  workspace: string;
  title: string;
  dynamicTitle: string;
  resolvedTitle: string;
  isActive: boolean;
  lastActivity: string;
}

export interface SessionDispatchService {
  readonly providerId: "none" | "termstation";
  readonly isConfigured: boolean;
  readonly cannedMessage: string;
  listSessions(): Promise<SessionSummary[]>;
  resolveSession(sessionId: string): Promise<SessionSummary | null>;
  sendMessage(request: {
    sessionId: string;
    mode: SessionSendMode;
    customMessage?: string;
  }): Promise<{ sentMessage: string }>;
}

interface SessionTargetProvider {
  readonly providerId: "termstation";
  listSessions(): Promise<SessionSummary[]>;
  resolveSession(sessionId: string): Promise<SessionSummary | null>;
  sendInput(sessionId: string, message: string): Promise<void>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function requireSessionId(value: string): string {
  const trimmed = value.trim();
  if (!SESSION_ID_PATTERN.test(trimmed)) {
    throw new Error("Invalid sessionId");
  }
  return trimmed;
}

function buildBasicAuthHeader(
  username: string | undefined,
  password: string | undefined,
): string | undefined {
  if (!username || !password) {
    return undefined;
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseBool(value: unknown): boolean {
  return value === true;
}

function parseDateSortKey(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

class TermstationSessionTargetProvider implements SessionTargetProvider {
  readonly providerId = "termstation" as const;
  private readonly baseApiUrl: string;
  private readonly authHeader: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: SessionDispatchTermstationConfig) {
    this.baseApiUrl = config.apiBaseUrl.replace(/\/+$/, "");
    this.authHeader = buildBasicAuthHeader(config.username, config.password);
    this.timeoutMs = config.requestTimeoutMs;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.listActiveSessions();
  }

  async resolveSession(sessionId: string): Promise<SessionSummary | null> {
    const validatedSessionId = requireSessionId(sessionId);
    const sessions = await this.listActiveSessions();
    const matched = sessions.find((entry) => entry.sessionId === validatedSessionId);
    return matched ?? null;
  }

  private async listActiveSessions(): Promise<SessionSummary[]> {
    const response = await fetchWithTimeout(
      `${this.baseApiUrl}/sessions`,
      {
        method: "GET",
        headers: this.buildHeaders(),
      },
      this.timeoutMs,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`session listing failed with ${response.status}${text ? `: ${text}` : ""}`);
    }

    const raw = await response.json();
    if (!Array.isArray(raw)) {
      return [];
    }

    const parsed = raw
      .map((entry) => this.parseSession(entry))
      .filter((entry): entry is SessionSummary => entry !== null)
      .filter((entry) => entry.isActive);

    parsed.sort((a, b) => parseDateSortKey(b.lastActivity) - parseDateSortKey(a.lastActivity));
    return parsed;
  }

  async sendInput(sessionId: string, message: string): Promise<void> {
    const validatedSessionId = requireSessionId(sessionId);
    const payload = JSON.stringify({ data: message, activity_policy: "immediate" });
    const response = await fetchWithTimeout(
      `${this.baseApiUrl}/sessions/${encodeURIComponent(validatedSessionId)}/input`,
      {
        method: "POST",
        headers: this.buildHeaders({
          "content-type": "application/json",
        }),
        body: payload,
      },
      this.timeoutMs,
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`session input failed with ${response.status}${text ? `: ${text}` : ""}`);
    }
  }

  private parseSession(raw: unknown): SessionSummary | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const entry = raw as Record<string, unknown>;
    const sessionId = parseOptionalString(entry.session_id ?? entry.sessionId);
    if (!sessionId) {
      return null;
    }
    const workspace = parseOptionalString(entry.workspace) ?? "";
    const title = parseOptionalString(entry.title) ?? "";
    const dynamicTitle = parseOptionalString(entry.dynamic_title ?? entry.dynamicTitle) ?? "";
    const resolvedTitle = title || dynamicTitle || sessionId;
    const isActive = parseBool(entry.is_active ?? entry.isActive);
    const lastActivity = parseOptionalString(entry.last_activity ?? entry.lastActivity) ?? "";

    return {
      sessionId,
      workspace,
      title,
      dynamicTitle,
      resolvedTitle,
      isActive,
      lastActivity,
    };
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.authHeader ? { authorization: this.authHeader } : {}),
      ...(extra ?? {}),
    };
  }
}

function createNoopSessionDispatchService(cannedMessage: string): SessionDispatchService {
  return {
    providerId: "none",
    isConfigured: false,
    cannedMessage,
    async listSessions(): Promise<SessionSummary[]> {
      throw new Error("Session dispatch provider is not configured");
    },
    async resolveSession(): Promise<SessionSummary | null> {
      return null;
    },
    async sendMessage(): Promise<{ sentMessage: string }> {
      throw new Error("Session dispatch provider is not configured");
    },
  };
}

export function createSessionDispatchService(config: AppConfig): SessionDispatchService {
  const dispatchConfig = config.sessionDispatch;
  const cannedMessage =
    dispatchConfig?.cannedMessage.trim() ||
    "Use the agent-voice-adapter-cli skill to continue the conversation with the user.";

  if (!dispatchConfig || dispatchConfig.provider === "none" || !dispatchConfig.termstation) {
    return createNoopSessionDispatchService(cannedMessage);
  }

  const targetProvider: SessionTargetProvider = new TermstationSessionTargetProvider(
    dispatchConfig.termstation,
  );

  return {
    providerId: targetProvider.providerId,
    isConfigured: true,
    cannedMessage,
    listSessions(): Promise<SessionSummary[]> {
      return targetProvider.listSessions();
    },
    resolveSession(sessionId: string): Promise<SessionSummary | null> {
      return targetProvider.resolveSession(sessionId);
    },
    async sendMessage(request: {
      sessionId: string;
      mode: SessionSendMode;
      customMessage?: string;
    }): Promise<{ sentMessage: string }> {
      const sessionId = requireSessionId(request.sessionId);
      const message =
        request.mode === "custom" ? parseOptionalString(request.customMessage) : cannedMessage;
      if (!message) {
        throw new Error("Custom message is required when mode=custom");
      }
      await targetProvider.sendInput(sessionId, message);
      return { sentMessage: message };
    },
  };
}
