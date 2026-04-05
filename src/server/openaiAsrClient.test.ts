import { describe, expect, test, vi } from "vitest";

import { OpenAiAsrClient, resolveOpenAiAudioFilename } from "./openaiAsrClient";

function buildClientOptions(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    apiKey: "sk-test",
    modelId: "gpt-4o-mini-transcribe",
    baseUrl: "https://api.openai.com",
    timeoutMs: 30000,
    ...overrides,
  } as ConstructorParameters<typeof OpenAiAsrClient>[0];
}

describe("resolveOpenAiAudioFilename", () => {
  test("maps known mime types to expected filenames", () => {
    expect(resolveOpenAiAudioFilename("audio/wav")).toBe("audio.wav");
    expect(resolveOpenAiAudioFilename("audio/webm")).toBe("audio.webm");
    expect(resolveOpenAiAudioFilename("audio/webm;codecs=opus")).toBe("audio.webm");
    expect(resolveOpenAiAudioFilename("audio/ogg;codecs=opus")).toBe("audio.ogg");
    expect(resolveOpenAiAudioFilename("audio/mpeg")).toBe("audio.mp3");
    expect(resolveOpenAiAudioFilename("audio/mp4")).toBe("audio.mp4");
    expect(resolveOpenAiAudioFilename("audio/flac")).toBe("audio.flac");
  });

  test("normalizes case and trims whitespace", () => {
    expect(resolveOpenAiAudioFilename(" AUDIO/WAV ")).toBe("audio.wav");
  });

  test("falls back to audio.wav for unknown or missing mime types", () => {
    expect(resolveOpenAiAudioFilename(undefined)).toBe("audio.wav");
    expect(resolveOpenAiAudioFilename("")).toBe("audio.wav");
    expect(resolveOpenAiAudioFilename("application/octet-stream")).toBe("audio.wav");
  });
});

describe("OpenAiAsrClient.transcribe", () => {
  test("posts multipart to /v1/audio/transcriptions with bearer auth and returns parsed text", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new OpenAiAsrClient(
      buildClientOptions({ fetchImpl, modelId: "gpt-4o-mini-transcribe" }),
    );

    const result = await client.transcribe({
      audioBytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/wav",
    });

    expect(result.text).toBe("hello world");
    expect(result.modelId).toBe("gpt-4o-mini-transcribe");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1/audio/transcriptions");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBeNull();
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("audio.wav");
  });

  test("honors per-request modelId override", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new OpenAiAsrClient(buildClientOptions({ fetchImpl }));

    await client.transcribe({
      audioBytes: new Uint8Array([0]),
      mimeType: "audio/wav",
      modelId: "whisper-1",
    });

    const form = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .body as FormData;
    expect(form.get("model")).toBe("whisper-1");
  });

  test("passes through language hint when configured", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "hola" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new OpenAiAsrClient(buildClientOptions({ fetchImpl, language: "es" }));

    await client.transcribe({
      audioBytes: new Uint8Array([0]),
      mimeType: "audio/wav",
    });

    const form = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .body as FormData;
    expect(form.get("language")).toBe("es");
  });

  test("derives filename from mimeType for webm uploads", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new OpenAiAsrClient(buildClientOptions({ fetchImpl }));

    await client.transcribe({
      audioBytes: new Uint8Array([0]),
      mimeType: "audio/webm;codecs=opus",
    });

    const form = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
  });

  test("strips trailing slash from baseUrl", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new OpenAiAsrClient(
      buildClientOptions({ fetchImpl, baseUrl: "https://api.openai.com/" }),
    );

    await client.transcribe({ audioBytes: new Uint8Array([0]) });

    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  test("throws descriptive error on non-2xx responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid audio" } }), {
          status: 400,
          statusText: "Bad Request",
        }),
    ) as unknown as typeof fetch;
    const client = new OpenAiAsrClient(buildClientOptions({ fetchImpl }));

    await expect(
      client.transcribe({ audioBytes: new Uint8Array([0]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/OpenAI ASR request failed \(400 Bad Request\).*invalid audio/);
  });

  test("returns empty string when response JSON has no text field", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new OpenAiAsrClient(buildClientOptions({ fetchImpl }));

    const result = await client.transcribe({ audioBytes: new Uint8Array([0]) });
    expect(result.text).toBe("");
  });
});
