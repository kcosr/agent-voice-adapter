export interface OpenAiAsrClientOptions {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  language?: string;
  timeoutMs: number;
  log?: (...args: unknown[]) => void;
  fetchImpl?: typeof fetch;
}

export interface OpenAiAsrTranscribeRequest {
  audioBytes: Uint8Array;
  mimeType?: string;
  modelId?: string;
}

export interface OpenAiAsrTranscribeResult {
  text: string;
  modelId: string;
  durationMs: number;
}

const MIME_TYPE_TO_FILENAME: Record<string, string> = {
  "audio/wav": "audio.wav",
  "audio/wave": "audio.wav",
  "audio/x-wav": "audio.wav",
  "audio/webm": "audio.webm",
  "audio/webm;codecs=opus": "audio.webm",
  "audio/ogg": "audio.ogg",
  "audio/ogg;codecs=opus": "audio.ogg",
  "audio/mpeg": "audio.mp3",
  "audio/mp3": "audio.mp3",
  "audio/mp4": "audio.mp4",
  "audio/m4a": "audio.m4a",
  "audio/x-m4a": "audio.m4a",
  "audio/flac": "audio.flac",
};

export function resolveOpenAiAudioFilename(mimeType: string | undefined): string {
  if (!mimeType) {
    return "audio.wav";
  }
  const normalized = mimeType.trim().toLowerCase();
  if (MIME_TYPE_TO_FILENAME[normalized]) {
    return MIME_TYPE_TO_FILENAME[normalized];
  }
  const base = normalized.split(";")[0]?.trim() ?? "";
  if (MIME_TYPE_TO_FILENAME[base]) {
    return MIME_TYPE_TO_FILENAME[base];
  }
  return "audio.wav";
}

interface OpenAiTranscriptionResponse {
  text?: unknown;
}

export class OpenAiAsrClient {
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly language: string | undefined;
  private readonly timeoutMs: number;
  private readonly log: (...args: unknown[]) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiAsrClientOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.language = options.language;
    this.timeoutMs = options.timeoutMs;
    this.log = options.log ?? (() => undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(request: OpenAiAsrTranscribeRequest): Promise<OpenAiAsrTranscribeResult> {
    const modelId = request.modelId?.trim() || this.modelId;
    const filename = resolveOpenAiAudioFilename(request.mimeType);
    const contentType = request.mimeType?.trim() || "audio/wav";

    const body = new FormData();
    const audioBuffer = new ArrayBuffer(request.audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(request.audioBytes);
    const blob = new Blob([audioBuffer], { type: contentType });
    body.append("file", blob, filename);
    body.append("model", modelId);
    body.append("response_format", "json");
    if (this.language) {
      body.append("language", this.language);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(new Error(`OpenAI ASR request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    const startedAtMs = Date.now();

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const summary = errorText.slice(0, 500);
        throw new Error(
          `OpenAI ASR request failed (${response.status} ${response.statusText}): ${summary}`,
        );
      }

      const parsed = (await response.json().catch((error) => {
        throw new Error(`OpenAI ASR response parse failed: ${(error as Error).message}`);
      })) as OpenAiTranscriptionResponse;

      const text = typeof parsed.text === "string" ? parsed.text : "";
      const durationMs = Date.now() - startedAtMs;
      this.log("openai_asr_transcribe_ok", { modelId, durationMs, textLength: text.length });

      return { text, modelId, durationMs };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
