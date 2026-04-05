import { type RawData, WebSocket } from "ws";

export interface ElevenLabsStreamingClientOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  baseUrl: string;
  outputFormat: string;
  abortSignal: AbortSignal;
  onAudioChunk: (pcmBytes: Uint8Array) => void;
  onError: (error: unknown) => void;
  log: (...args: unknown[]) => void;
}

export class ElevenLabsStreamingClient {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly outputFormat: string;
  private readonly abortSignal: AbortSignal;
  private readonly onAudioChunk: (pcmBytes: Uint8Array) => void;
  private readonly onError: (error: unknown) => void;
  private readonly log: (...args: unknown[]) => void;

  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private initialConfigSent = false;

  constructor(options: ElevenLabsStreamingClientOptions) {
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId;
    this.modelId = options.modelId;
    this.baseUrl = options.baseUrl;
    this.outputFormat = options.outputFormat;
    this.abortSignal = options.abortSignal;
    this.onAudioChunk = options.onAudioChunk;
    this.onError = options.onError;
    this.log = options.log;

    if (this.abortSignal.aborted) {
      void this.cancel();
    } else {
      this.abortSignal.addEventListener("abort", () => {
        void this.cancel();
      });
    }
  }

  async sendText(text: string): Promise<void> {
    if (!text || this.closed) {
      return;
    }

    await this.ensureConnected();

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      text,
      try_trigger_generation: true,
    };

    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.handleError(error);
    }
  }

  async finish(): Promise<void> {
    if (this.closed) {
      return;
    }

    await this.ensureConnected();

    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(
          JSON.stringify({
            text: "",
          }),
        );
      } catch (error) {
        this.handleError(error);
      }
    }

    if (this.closePromise) {
      await this.closePromise;
    }
  }

  async cancel(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const socket = this.socket;
    this.socket = null;

    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "cancelled");
        }
      } catch {
        // Ignore close errors.
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error("ElevenLabs streaming client already closed");
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = this.buildWebSocketUrl();
      const socket = new WebSocket(url, {
        headers: {
          "xi-api-key": this.apiKey,
        },
      });

      this.socket = socket;

      const handleOpen = (): void => {
        socket.removeListener("error", handleOpenError);
        this.attachEventHandlers(socket);
        this.log("ElevenLabs WebSocket opened", { url });
        this.sendInitialConfig();
        resolve();
      };

      const handleOpenError = (error: Error): void => {
        socket.removeListener("open", handleOpen);
        this.handleError(error);
        reject(error);
      };

      socket.once("open", handleOpen);
      socket.once("error", handleOpenError);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private buildWebSocketUrl(): string {
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      url = new URL("https://api.elevenlabs.io");
    }

    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }

    const path = `v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream-input`;
    const wsUrl = new URL(path, url);
    wsUrl.searchParams.set("model_id", this.modelId);
    wsUrl.searchParams.set("output_format", this.outputFormat);

    return wsUrl.toString();
  }

  private attachEventHandlers(socket: WebSocket): void {
    if (this.closePromise) {
      return;
    }

    this.closePromise = new Promise<void>((resolve) => {
      socket.on("message", (data: RawData) => {
        this.handleMessage(data);
      });

      socket.on("error", (error: Error) => {
        this.handleError(error);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        this.closed = true;
        this.log("ElevenLabs WebSocket closed", {
          code,
          reason: reason.toString("utf8"),
        });
        resolve();
      });
    });
  }

  private sendInitialConfig(): void {
    if (this.initialConfigSent || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      text: " ",
      try_trigger_generation: true,
      voice_settings: null as unknown,
      generation_config: {
        chunk_length_schedule: [50],
      },
    };

    try {
      this.socket.send(JSON.stringify(payload));
      this.initialConfigSent = true;
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleMessage(data: RawData): void {
    if (this.closed) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const payload = parsed as {
      audio?: unknown;
      audio_base64?: unknown;
      message_type?: unknown;
      error?: unknown;
    };

    const audioField = payload.audio ?? payload.audio_base64;
    if (typeof audioField === "string" && audioField.length > 0) {
      try {
        const buffer = Buffer.from(audioField, "base64");
        if (buffer.byteLength > 0) {
          this.onAudioChunk(new Uint8Array(buffer));
        }
      } catch (error) {
        this.handleError(error);
      }
      return;
    }

    if (payload.message_type === "error" || payload.message_type === "auth_error") {
      this.handleError(payload);
    }
  }

  private handleError(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.onError(error);
  }
}
