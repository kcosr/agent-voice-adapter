import { afterEach, describe, expect, test, vi } from "vitest";

import type { AppConfig } from "./config";
import { createSessionDispatchService } from "./sessionDispatch";

const BASE_CONFIG: AppConfig = {
  port: 0,
  listenHost: "127.0.0.1",
  wsPath: "/ws",
  tts: {
    provider: "elevenlabs",
    outputSampleRate: 24000,
    defaultModelId: "eleven_multilingual_v2",
    defaultVoiceId: "voice-id",
  },
  elevenLabs: {
    apiKey: "test",
    voiceId: "voice-id",
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

describe("sessionDispatch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("returns not-configured service when provider is none", async () => {
    const service = createSessionDispatchService({
      ...BASE_CONFIG,
      sessionDispatch: {
        provider: "none",
        cannedMessage: "hello",
        prependLinkedSessionLabelForTts: false,
      },
    });

    expect(service.isConfigured).toBe(false);
    await expect(service.listSessions()).rejects.toThrow(
      "Session dispatch provider is not configured",
    );
  });

  test("lists active termstation sessions sorted by last activity and resolved title", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          {
            session_id: "older",
            workspace: "A",
            title: "Fixed older",
            dynamic_title: "",
            is_active: true,
            last_activity: "2026-02-21T10:00:00.000Z",
          },
          {
            session_id: "inactive",
            workspace: "B",
            title: "Ignore me",
            dynamic_title: "Ignore me dynamic",
            is_active: false,
            last_activity: "2026-02-21T11:00:00.000Z",
          },
          {
            session_id: "newer",
            workspace: "C",
            title: "Fixed newer",
            dynamic_title: "Dynamic newer",
            is_active: true,
            last_activity: "2026-02-21T12:00:00.000Z",
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const service = createSessionDispatchService({
      ...BASE_CONFIG,
      sessionDispatch: {
        provider: "termstation",
        cannedMessage: "hello",
        prependLinkedSessionLabelForTts: false,
        termstation: {
          apiBaseUrl: "https://termstation/api",
          requestTimeoutMs: 5000,
        },
      },
    });

    const sessions = await service.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionId: "newer",
      workspace: "C",
      title: "Fixed newer",
      dynamicTitle: "Dynamic newer",
      resolvedTitle: "Fixed newer",
      isActive: true,
    });
    expect(sessions[1]).toMatchObject({
      sessionId: "older",
      resolvedTitle: "Fixed older",
      isActive: true,
    });
  });

  test("resolves an active session by id through provider lookup", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          {
            session_id: "alpha",
            workspace: "ws-a",
            title: "Title A",
            dynamic_title: "",
            is_active: true,
            last_activity: "2026-02-21T10:00:00.000Z",
          },
          {
            session_id: "beta",
            workspace: "ws-b",
            title: "Title B",
            dynamic_title: "",
            is_active: true,
            last_activity: "2026-02-21T11:00:00.000Z",
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const service = createSessionDispatchService({
      ...BASE_CONFIG,
      sessionDispatch: {
        provider: "termstation",
        cannedMessage: "hello",
        prependLinkedSessionLabelForTts: false,
        termstation: {
          apiBaseUrl: "https://termstation/api",
          requestTimeoutMs: 5000,
        },
      },
    });

    const resolved = await service.resolveSession("beta");
    expect(resolved).toMatchObject({
      sessionId: "beta",
      workspace: "ws-b",
      resolvedTitle: "Title B",
      isActive: true,
    });
  });

  test("sends canned termstation input with basic auth headers", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const service = createSessionDispatchService({
      ...BASE_CONFIG,
      sessionDispatch: {
        provider: "termstation",
        cannedMessage: "canned prompt",
        prependLinkedSessionLabelForTts: false,
        termstation: {
          apiBaseUrl: "https://termstation/api/",
          username: "user1",
          password: "pass1",
          requestTimeoutMs: 5000,
        },
      },
    });

    const result = await service.sendMessage({
      sessionId: "abc_123",
      mode: "canned",
    });

    expect(result.sentMessage).toBe("canned prompt");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected fetch to be called once");
    }
    const [calledUrl, calledInit] = firstCall;
    expect(calledUrl).toBe("https://termstation/api/sessions/abc_123/input");
    expect(calledInit).toBeDefined();
    expect(calledInit?.method).toBe("POST");
    expect(calledInit?.body).toBe(
      JSON.stringify({ data: "canned prompt", activity_policy: "immediate" }),
    );
    expect(calledInit?.headers).toMatchObject({
      authorization: "Basic dXNlcjE6cGFzczE=",
      "content-type": "application/json",
    });
  });

  test("requires custom message content when mode=custom", async () => {
    const service = createSessionDispatchService({
      ...BASE_CONFIG,
      sessionDispatch: {
        provider: "termstation",
        cannedMessage: "hello",
        prependLinkedSessionLabelForTts: false,
        termstation: {
          apiBaseUrl: "https://termstation/api",
          requestTimeoutMs: 5000,
        },
      },
    });

    await expect(
      service.sendMessage({
        sessionId: "abc_123",
        mode: "custom",
        customMessage: "   ",
      }),
    ).rejects.toThrow("Custom message is required when mode=custom");
  });
});
