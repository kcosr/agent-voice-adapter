import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createBriefSuccessOutput,
  createTurnHeaders,
  createTurnPayload,
  parseArgs,
  resolveCliVersion,
} from "./agent-voice-adapter-cli";

describe("agent-voice-adapter-cli args", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("defaults to listen mode", async () => {
    const parsed = await parseArgs(["hello world"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.listen).toBe(true);
    expect(parsed.verbose).toBe(false);
    expect(parsed.requestTimeoutMs).toBe(300000);
    expect(parsed.listenCompletionTimeoutMs).toBe(120000);

    const payload = createTurnPayload(parsed);
    expect(payload.listen).toBe(true);
    expect(payload.listenCompletionTimeoutMs).toBe(120000);
  });

  test("supports one-shot mode via --no-wait", async () => {
    const parsed = await parseArgs(["--no-wait", "hello world"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.listen).toBe(false);
    expect(parsed.verbose).toBe(false);

    const payload = createTurnPayload(parsed);
    expect(payload).not.toHaveProperty("listen");
    expect(payload).not.toHaveProperty("listenCompletionTimeoutMs");
  });

  test("does not include listen timeout fields in one-shot mode", async () => {
    const parsed = await parseArgs([
      "--no-wait",
      "--listen-start-timeout-ms",
      "30000",
      "--listen-completion-timeout-ms",
      "120000",
      "hello world",
    ]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.listen).toBe(false);

    const payload = createTurnPayload(parsed);
    expect(payload).not.toHaveProperty("listen");
    expect(payload).not.toHaveProperty("listenStartTimeoutMs");
    expect(payload).not.toHaveProperty("listenCompletionTimeoutMs");
  });

  test("supports --no-listen alias", async () => {
    const parsed = await parseArgs(["--no-listen", "hello world"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.listen).toBe(false);
  });

  test("includes debugTts in payload with --debug-tts", async () => {
    const parsed = await parseArgs(["--debug-tts", "hello world"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.debugTts).toBe(true);

    const payload = createTurnPayload(parsed);
    expect(payload.debugTts).toBe(true);
  });

  test("supports --verbose output mode", async () => {
    const parsed = await parseArgs(["--verbose", "hello world"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.verbose).toBe(true);
  });

  test("supports repeated --quick-reply and forwards quickReplies payload", async () => {
    const parsed = await parseArgs([
      "--quick-reply",
      "Yes",
      "--quick-reply",
      "Wait::Please wait.",
      "question",
    ]);

    expect(parsed).not.toBeNull();
    expect(parsed?.quickReplies).toEqual([
      {
        label: "Yes",
        text: "Yes",
      },
      {
        label: "Wait",
        text: "Please wait.",
      },
    ]);
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(createTurnPayload(parsed)).toMatchObject({
      text: "question",
      quickReplies: [
        {
          label: "Yes",
          text: "Yes",
        },
        {
          label: "Wait",
          text: "Please wait.",
        },
      ],
    });
  });

  test("supports quick replies in one-shot mode", async () => {
    const parsed = await parseArgs(["--no-wait", "--quick-reply", "Yes", "question"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.listen).toBe(false);
    expect(parsed.quickReplies).toEqual([{ label: "Yes", text: "Yes" }]);

    const payload = createTurnPayload(parsed);
    expect(payload).toMatchObject({
      text: "question",
      quickReplies: [{ label: "Yes", text: "Yes" }],
    });
    expect(payload).not.toHaveProperty("listen");
  });

  test("supports quick replies with --no-listen alias", async () => {
    const parsed = await parseArgs(["--no-listen", "--quick-reply", "Yes::Proceed", "question"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.listen).toBe(false);
    expect(parsed?.quickReplies).toEqual([{ label: "Yes", text: "Proceed" }]);
  });

  test("supports inline attachment text with default content type", async () => {
    const parsed = await parseArgs(["--attachment", "line 1\nline 2", "hello world"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.attachment).not.toHaveProperty("text");
    expect(parsed?.attachment).not.toHaveProperty("fileName");
    expect(parsed?.attachment).toEqual({
      dataBase64: Buffer.from("line 1\nline 2", "utf8").toString("base64"),
      contentType: "text/plain",
    });
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(createTurnPayload(parsed)).toMatchObject({
      text: "hello world",
      attachment: {
        dataBase64: Buffer.from("line 1\nline 2", "utf8").toString("base64"),
        contentType: "text/plain",
      },
    });
  });

  test("supports attachment file and infers markdown content type", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "ava-cli-"));
    try {
      const attachmentPath = path.join(tempDir, "notes.md");
      writeFileSync(attachmentPath, "# Notes\n- one\n", "utf8");

      const parsed = await parseArgs(["--attachment-file", attachmentPath, "hello world"]);

      expect(parsed).not.toBeNull();
      expect(parsed?.attachment).toEqual({
        dataBase64: Buffer.from("# Notes\n- one\n", "utf8").toString("base64"),
        fileName: "notes.md",
        contentType: "text/markdown",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("treats .markdown attachment files as text/plain by default", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "ava-cli-"));
    try {
      const attachmentPath = path.join(tempDir, "notes.markdown");
      writeFileSync(attachmentPath, "# Notes\n- one\n", "utf8");

      const parsed = await parseArgs(["--attachment-file", attachmentPath, "hello world"]);

      expect(parsed).not.toBeNull();
      expect(parsed?.attachment).toEqual({
        dataBase64: Buffer.from("# Notes\n- one\n", "utf8").toString("base64"),
        fileName: "notes.markdown",
        contentType: "text/plain",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("defaults unknown attachment extensions to text/plain", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "ava-cli-"));
    try {
      const attachmentPath = path.join(tempDir, "notes.unknownext");
      writeFileSync(attachmentPath, "hello", "utf8");

      const parsed = await parseArgs(["--attachment-file", attachmentPath, "hello world"]);

      expect(parsed).not.toBeNull();
      expect(parsed?.attachment).toMatchObject({
        fileName: "notes.unknownext",
        contentType: "text/plain",
      });
      expect(parsed?.attachment).not.toHaveProperty("text");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("allows overriding attachment content type", async () => {
    const parsed = await parseArgs([
      "--attachment",
      "sample",
      "--attachment-content-type",
      "text/markdown",
      "hello world",
    ]);

    expect(parsed).not.toBeNull();
    expect(parsed?.attachment).toEqual({
      dataBase64: Buffer.from("sample", "utf8").toString("base64"),
      contentType: "text/markdown",
    });
  });

  test("base64-encodes binary attachment files", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "ava-cli-"));
    try {
      const attachmentPath = path.join(tempDir, "bundle.zip");
      const binary = Buffer.from([0, 255, 1, 254, 2, 128, 3, 127, 4, 42]);
      writeFileSync(attachmentPath, binary);

      const parsed = await parseArgs(["--attachment-file", attachmentPath, "hello world"]);

      expect(parsed).not.toBeNull();
      expect(parsed?.attachment).toEqual({
        dataBase64: binary.toString("base64"),
        fileName: "bundle.zip",
        contentType: "application/zip",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("infers configured content type map for non-markdown extensions", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "ava-cli-"));
    try {
      const attachmentPath = path.join(tempDir, "payload.json");
      writeFileSync(attachmentPath, '{"ok":true}', "utf8");

      const parsed = await parseArgs(["--attachment-file", attachmentPath, "hello world"]);

      expect(parsed).not.toBeNull();
      expect(parsed?.attachment).toMatchObject({
        fileName: "payload.json",
        contentType: "application/json",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("infers full locked MIME mapping table", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "ava-cli-"));
    const cases: Array<[string, string]> = [
      ["sample.md", "text/markdown"],
      ["sample.txt", "text/plain"],
      ["sample.log", "text/plain"],
      ["sample.json", "application/json"],
      ["sample.yaml", "application/yaml"],
      ["sample.yml", "application/yaml"],
      ["sample.xml", "application/xml"],
      ["sample.html", "text/html"],
      ["sample.htm", "text/html"],
      ["sample.js", "application/javascript"],
      ["sample.mjs", "application/javascript"],
      ["sample.cjs", "application/javascript"],
      ["sample.ts", "text/plain"],
      ["sample.tsx", "text/plain"],
      ["sample.py", "text/x-python"],
      ["sample.java", "text/x-java-source"],
      ["sample.kt", "text/x-kotlin"],
      ["sample.kts", "text/x-kotlin"],
      ["sample.c", "text/x-c"],
      ["sample.h", "text/x-c"],
      ["sample.cc", "text/x-c++src"],
      ["sample.cpp", "text/x-c++src"],
      ["sample.cxx", "text/x-c++src"],
      ["sample.hpp", "text/x-c++src"],
      ["sample.hxx", "text/x-c++src"],
      ["sample.sh", "application/x-sh"],
      ["sample.csv", "text/csv"],
      ["sample.zip", "application/zip"],
      ["sample.wav", "audio/wav"],
      ["sample.mp3", "audio/mpeg"],
      ["sample.m4a", "audio/mp4"],
      ["sample.ogg", "audio/ogg"],
      ["sample.flac", "audio/flac"],
      ["sample.pdf", "application/pdf"],
      ["sample.jpg", "image/jpeg"],
      ["sample.jpeg", "image/jpeg"],
      ["sample.png", "image/png"],
      ["sample.gif", "image/gif"],
      ["sample.webp", "image/webp"],
      ["sample.svg", "image/svg+xml"],
    ];
    try {
      for (const [fileName, expectedContentType] of cases) {
        const attachmentPath = path.join(tempDir, fileName);
        writeFileSync(attachmentPath, Buffer.from([0, 1, 2, 3]));
        const parsed = await parseArgs(["--attachment-file", attachmentPath, "hello world"]);
        expect(parsed).not.toBeNull();
        expect(parsed?.attachment).toMatchObject({
          fileName,
          contentType: expectedContentType,
        });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects attachment source conflicts", async () => {
    await expect(
      parseArgs(["--attachment", "one", "--attachment-file", "./notes.md", "hello world"]),
    ).rejects.toThrow("--attachment and --attachment-file are mutually exclusive");
  });

  test("rejects attachment content type without attachment source", async () => {
    await expect(
      parseArgs(["--attachment-content-type", "text/plain", "hello world"]),
    ).rejects.toThrow("--attachment-content-type requires --attachment or --attachment-file");
  });

  test("rejects unknown options", async () => {
    await expect(parseArgs(["--recognition-timeout-ms", "30000", "hello"])).rejects.toThrow(
      "Unknown option: --recognition-timeout-ms",
    );
  });

  test("supports end-of-options separator for literal hyphen-prefixed text", async () => {
    const parsed = await parseArgs(["--no-wait", "--", "--this-should-be-text"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.listen).toBe(false);
    expect(parsed?.text).toBe("--this-should-be-text");
  });

  test("prints version and exits when --version is provided", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const parsed = await parseArgs(["--version"]);

    expect(parsed).toBeNull();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/));
    writeSpy.mockRestore();
  });

  test("resolveCliVersion falls back to embedded version when package.json is unavailable", () => {
    expect(resolveCliVersion(null)).toBe("__EMBEDDED_CLI_VERSION__");
  });

  test("resolveCliVersion falls back to embedded version when package.json is invalid", () => {
    expect(resolveCliVersion("{ invalid json")).toBe("__EMBEDDED_CLI_VERSION__");
  });

  test("normalizes api base url from env", async () => {
    vi.stubEnv("AGENT_VOICE_ADAPTER_API_URL", "http://localhost:4300/");

    const parsed = await parseArgs(["hello world"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.apiBaseUrl).toBe("http://localhost:4300");
  });

  test("uses wake-intent shared secret from env and sets request header", async () => {
    vi.stubEnv("AGENT_VOICE_ADAPTER_WAKE_INTENT_SHARED_SECRET", "env-secret");

    const parsed = await parseArgs(["hello world"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.wakeIntentSharedSecret).toBe("env-secret");
    expect(createTurnHeaders(parsed)).toMatchObject({
      "content-type": "application/json",
      "x-wake-intent-secret": "env-secret",
    });
  });

  test("forwards SESSION_ID env as turn payload sessionId", async () => {
    vi.stubEnv("SESSION_ID", "session-123");

    const parsed = await parseArgs(["hello world"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.sessionId).toBe("session-123");
    expect(createTurnPayload(parsed)).toMatchObject({
      text: "hello world",
      sessionId: "session-123",
    });
  });

  test("uses request timeout from env", async () => {
    vi.stubEnv("AGENT_VOICE_ADAPTER_REQUEST_TIMEOUT_MS", "45000");

    const parsed = await parseArgs(["hello world"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.requestTimeoutMs).toBe(45000);
  });

  test("request-timeout flag overrides env value", async () => {
    vi.stubEnv("AGENT_VOICE_ADAPTER_REQUEST_TIMEOUT_MS", "45000");

    const parsed = await parseArgs(["--request-timeout-ms", "120000", "hello world"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.requestTimeoutMs).toBe(120000);
  });

  test("rejects invalid request-timeout values", async () => {
    await expect(parseArgs(["--request-timeout-ms", "0", "hello world"])).rejects.toThrow(
      "--request-timeout-ms must be a positive integer",
    );
  });

  test("cli wake-intent shared secret flag overrides env value", async () => {
    vi.stubEnv("AGENT_VOICE_ADAPTER_WAKE_INTENT_SHARED_SECRET", "env-secret");

    const parsed = await parseArgs(["--wake-intent-shared-secret", "flag-secret", "hello world"]);

    expect(parsed).not.toBeNull();
    if (!parsed) {
      throw new Error("expected parsed args");
    }
    expect(parsed.wakeIntentSharedSecret).toBe("flag-secret");
    expect(createTurnHeaders(parsed)["x-wake-intent-secret"]).toBe("flag-secret");
  });
});

describe("agent-voice-adapter-cli output formatting", () => {
  test("brief output for no-wait success keeps only turnId", () => {
    const formatted = createBriefSuccessOutput({
      accepted: true,
      turnId: "turn-123",
      queueLength: 0,
      providerId: "kokoro_local",
      modelId: "hexgrad/Kokoro-82M",
      voiceId: "af_heart",
    });

    expect(formatted).toEqual({
      turnId: "turn-123",
    });
  });

  test("brief output for wait success keeps turnId text and duration", () => {
    const formatted = createBriefSuccessOutput({
      accepted: true,
      turnId: "turn-123",
      listen: {
        success: true,
        text: "recognized speech",
        durationMs: 321,
        providerId: "parakeet_local",
        modelId: "nvidia/parakeet-ctc-0.6b",
      },
    });

    expect(formatted).toEqual({
      turnId: "turn-123",
      text: "recognized speech",
      durationMs: 321,
    });
  });

  test("brief output includes timeoutFallbackUsed when true", () => {
    const formatted = createBriefSuccessOutput({
      accepted: true,
      turnId: "turn-123",
      listen: {
        success: true,
        text: "partial recognized speech",
        durationMs: 654,
        timeoutFallbackUsed: true,
      },
    });

    expect(formatted).toEqual({
      turnId: "turn-123",
      text: "partial recognized speech",
      durationMs: 654,
      timeoutFallbackUsed: true,
    });
  });

  test("non-success payload is returned as-is", () => {
    const payload = {
      accepted: false,
      error: "failed",
    };
    expect(createBriefSuccessOutput(payload)).toEqual(payload);
  });
});
