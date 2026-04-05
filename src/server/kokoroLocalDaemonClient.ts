import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Interface, createInterface } from "node:readline";

import { type SshTransportOptions, buildPythonDaemonCommand } from "./daemonCommand";

interface DaemonRequest {
  requestId: string;
  text: string;
  voiceId: string;
  modelId: string;
  onAudioChunk: (pcmBytes: Uint8Array) => void;
  onOutputSampleRate?: (sampleRate: number) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface DaemonJobInput {
  text: string;
  voiceId: string;
  modelId: string;
  onAudioChunk: (pcmBytes: Uint8Array) => void;
  onOutputSampleRate?: (sampleRate: number) => void;
}

export interface KokoroLocalDaemonClientOptions {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshTransportOptions;
  voiceId: string;
  modelId: string;
  langCode: string;
  speed: number;
  device: "cuda" | "cpu" | "auto";
  maxTextCharsPerChunk: number;
  gapMsBetweenChunks: number;
  abortSignal: AbortSignal;
  onAudioChunk: (pcmBytes: Uint8Array) => void;
  onOutputSampleRate?: (sampleRate: number) => void;
  onError: (error: unknown) => void;
  log: (...args: unknown[]) => void;
}

interface DaemonTransportConfig {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshTransportOptions;
  langCode: string;
  speed: number;
  device: "cuda" | "cpu" | "auto";
  maxTextCharsPerChunk: number;
  gapMsBetweenChunks: number;
  log: (...args: unknown[]) => void;
}

class KokoroDaemonProcess {
  private static instances = new Map<string, KokoroDaemonProcess>();

  static getInstance(config: DaemonTransportConfig): KokoroDaemonProcess {
    const key = JSON.stringify({
      pythonBin: config.pythonBin,
      scriptPath: config.scriptPath,
      sshTarget: config.ssh?.target,
      sshPort: config.ssh?.port,
      sshIdentityFile: config.ssh?.identityFile,
      langCode: config.langCode,
      speed: config.speed,
      device: config.device,
      maxTextCharsPerChunk: config.maxTextCharsPerChunk,
      gapMsBetweenChunks: config.gapMsBetweenChunks,
    });

    const existing = KokoroDaemonProcess.instances.get(key);
    if (existing) {
      return existing;
    }

    const created = new KokoroDaemonProcess(config);
    KokoroDaemonProcess.instances.set(key, created);
    return created;
  }

  static shutdownAll(): void {
    for (const instance of KokoroDaemonProcess.instances.values()) {
      instance.shutdown();
    }
    KokoroDaemonProcess.instances.clear();
  }

  private readonly config: DaemonTransportConfig;
  private child: ChildProcess | null = null;
  private stdoutReader: Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private queue: DaemonRequest[] = [];
  private inFlight: DaemonRequest | null = null;
  private ready = false;
  private inFlightCompleted = false;

  private constructor(config: DaemonTransportConfig) {
    this.config = config;
  }

  enqueue(request: DaemonJobInput): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        requestId: randomUUID(),
        text: request.text,
        voiceId: request.voiceId,
        modelId: request.modelId,
        onAudioChunk: request.onAudioChunk,
        onOutputSampleRate: request.onOutputSampleRate,
        resolve,
        reject,
      });

      this.pumpQueue();
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.ready) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const launch = buildPythonDaemonCommand({
        pythonBin: this.config.pythonBin,
        scriptPath: this.config.scriptPath,
        ssh: this.config.ssh,
      });
      const child = spawn(launch.command, launch.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.child = child;
      this.ready = false;

      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error("Kokoro daemon missing stdio streams"));
        return;
      }

      this.stdoutReader = createInterface({ input: child.stdout });

      child.stderr.on("data", (chunk: Buffer) => {
        this.config.log("Kokoro daemon stderr", chunk.toString("utf8"));
      });

      child.on("error", (error) => {
        this.config.log("Kokoro daemon process error", error);
        this.failActiveAndQueued(new Error(String(error)));
      });

      child.on("close", (code, signal) => {
        this.config.log("Kokoro daemon exited", { code, signal });
        this.child = null;
        this.ready = false;
        this.stdoutReader?.removeAllListeners();
        this.stdoutReader = null;
        this.failActiveAndQueued(
          new Error(
            `Kokoro daemon exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          ),
        );
      });

      this.stdoutReader.on("line", (line) => {
        this.handleDaemonLine(line);
      });

      const readyTimeout = setTimeout(() => {
        reject(new Error("Timed out waiting for kokoro daemon ready signal"));
      }, 30_000);

      const onReady = (line: string): void => {
        try {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type === "ready") {
            clearTimeout(readyTimeout);
            this.stdoutReader?.off("line", onReady);
            this.ready = true;
            this.config.log("Kokoro daemon ready");
            resolve();
          }
        } catch {
          // Ignore non-json lines during startup.
        }
      };

      this.stdoutReader.on("line", onReady);
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async pumpQueue(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) {
      return;
    }

    try {
      await this.ensureStarted();
    } catch (error) {
      this.failActiveAndQueued(new Error(String(error)));
      return;
    }

    if (!this.child || !this.child.stdin) {
      this.failActiveAndQueued(new Error("Kokoro daemon is not available"));
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.inFlight = next;
    this.inFlightCompleted = false;

    const payload = {
      type: "synthesize",
      request_id: next.requestId,
      text: next.text,
      voice: next.voiceId,
      model: next.modelId,
      lang: this.config.langCode,
      speed: this.config.speed,
      device: this.config.device,
      max_chars: this.config.maxTextCharsPerChunk,
      gap_ms: this.config.gapMsBetweenChunks,
    };

    this.config.log("Kokoro daemon synth start", {
      requestId: next.requestId,
      modelId: next.modelId,
      voiceId: next.voiceId,
      textLength: next.text.length,
      langCode: this.config.langCode,
      speed: this.config.speed,
      device: this.config.device,
      maxTextCharsPerChunk: this.config.maxTextCharsPerChunk,
      gapMsBetweenChunks: this.config.gapMsBetweenChunks,
    });

    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.completeInFlightWithError(new Error(String(error)));
    }
  }

  private handleDaemonLine(line: string): void {
    let parsed: {
      type?: string;
      request_id?: string;
      chunk_base64?: string;
      error?: string;
      model?: string;
      voice?: string;
      lang?: string;
      speed?: number;
      device?: string;
      sample_rate?: number;
      max_chars?: number;
      gap_ms?: number;
      chunk_count?: number;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!this.inFlight) {
      return;
    }

    if (parsed.request_id && parsed.request_id !== this.inFlight.requestId) {
      return;
    }

    if (parsed.type === "started") {
      if (
        typeof parsed.sample_rate === "number" &&
        Number.isFinite(parsed.sample_rate) &&
        parsed.sample_rate > 0
      ) {
        this.inFlight.onOutputSampleRate?.(Math.floor(parsed.sample_rate));
      }
      this.config.log("Kokoro daemon synth started", {
        requestId: this.inFlight.requestId,
        model: parsed.model,
        voice: parsed.voice,
        lang: parsed.lang,
        speed: parsed.speed,
        device: parsed.device,
        sampleRate: parsed.sample_rate,
        maxChars: parsed.max_chars,
        gapMs: parsed.gap_ms,
        chunkCount: parsed.chunk_count,
      });
      return;
    }

    if (parsed.type === "audio" && typeof parsed.chunk_base64 === "string") {
      try {
        const bytes = Buffer.from(parsed.chunk_base64, "base64");
        if (bytes.length > 0) {
          this.inFlight.onAudioChunk(new Uint8Array(bytes));
        }
      } catch (error) {
        this.completeInFlightWithError(new Error(String(error)));
      }
      return;
    }

    if (parsed.type === "done") {
      this.completeInFlightSuccess();
      return;
    }

    if (parsed.type === "error") {
      const error = new Error(parsed.error || "Kokoro daemon returned an unknown error");
      this.completeInFlightWithError(error);
    }
  }

  private completeInFlightSuccess(): void {
    if (!this.inFlight || this.inFlightCompleted) {
      return;
    }

    this.inFlightCompleted = true;
    this.inFlight.resolve();
    this.inFlight = null;
    void this.pumpQueue();
  }

  private completeInFlightWithError(error: Error): void {
    if (!this.inFlight || this.inFlightCompleted) {
      return;
    }

    this.inFlightCompleted = true;
    this.inFlight.reject(error);
    this.inFlight = null;
    void this.pumpQueue();
  }

  private failActiveAndQueued(error: Error): void {
    if (this.inFlight && !this.inFlightCompleted) {
      this.inFlightCompleted = true;
      this.inFlight.reject(error);
      this.inFlight = null;
    }

    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued?.reject(error);
    }
  }

  private shutdown(): void {
    this.failActiveAndQueued(new Error("Kokoro daemon shutdown"));

    const child = this.child;
    this.child = null;
    this.ready = false;
    this.inFlight = null;
    this.inFlightCompleted = false;
    this.queue = [];

    this.stdoutReader?.removeAllListeners();
    this.stdoutReader = null;

    if (child) {
      child.kill("SIGKILL");
    }
  }
}

export class KokoroLocalDaemonClient {
  private readonly daemon: KokoroDaemonProcess;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly onAudioChunk: (pcmBytes: Uint8Array) => void;
  private readonly onOutputSampleRate?: (sampleRate: number) => void;
  private readonly onError: (error: unknown) => void;
  private readonly abortSignal: AbortSignal;
  private closed = false;
  private pendingText = "";

  constructor(options: KokoroLocalDaemonClientOptions) {
    this.voiceId = options.voiceId;
    this.modelId = options.modelId;
    this.onAudioChunk = options.onAudioChunk;
    this.onOutputSampleRate = options.onOutputSampleRate;
    this.onError = options.onError;
    this.abortSignal = options.abortSignal;
    this.daemon = KokoroDaemonProcess.getInstance({
      pythonBin: options.pythonBin,
      scriptPath: options.scriptPath,
      ssh: options.ssh,
      langCode: options.langCode,
      speed: options.speed,
      device: options.device,
      maxTextCharsPerChunk: options.maxTextCharsPerChunk,
      gapMsBetweenChunks: options.gapMsBetweenChunks,
      log: options.log,
    });

    if (this.abortSignal.aborted) {
      void this.cancel();
    } else {
      this.abortSignal.addEventListener("abort", () => {
        void this.cancel();
      });
    }
  }

  async sendText(text: string): Promise<void> {
    if (this.closed || !text.trim()) {
      return;
    }

    this.pendingText = text;
  }

  async finish(): Promise<void> {
    if (this.closed || !this.pendingText) {
      return;
    }

    try {
      await this.daemon.enqueue({
        text: this.pendingText,
        voiceId: this.voiceId,
        modelId: this.modelId,
        onAudioChunk: this.onAudioChunk,
        onOutputSampleRate: this.onOutputSampleRate,
      });
    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.closed = true;
  }
}

export function shutdownKokoroDaemonProcesses(): void {
  KokoroDaemonProcess.shutdownAll();
}
