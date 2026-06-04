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
  cancelTimer: NodeJS.Timeout | null;
  cancelRequested: boolean;
}

interface DaemonJobInput {
  requestId: string;
  text: string;
  voiceId: string;
  modelId: string;
  onAudioChunk: (pcmBytes: Uint8Array) => void;
  onOutputSampleRate?: (sampleRate: number) => void;
}

export interface PocketTtsDaemonClientOptions {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshTransportOptions;
  voiceId: string;
  modelId: string;
  language: string;
  configPath?: string;
  device: string;
  quantize: boolean;
  maxTokensPerChunk: number;
  framesAfterEos?: number;
  hardCancelTimeoutMs: number;
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
  language: string;
  configPath?: string;
  device: string;
  quantize: boolean;
  maxTokensPerChunk: number;
  framesAfterEos?: number;
  hardCancelTimeoutMs: number;
  log: (...args: unknown[]) => void;
}

function validatePocketTtsIdentifier(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error(
      `Invalid Pocket TTS ${fieldName}: use a built-in identifier with letters, digits, "_" or "-"`,
    );
  }
  return normalized;
}

class PocketTtsDaemonProcess {
  private static instances = new Map<string, PocketTtsDaemonProcess>();

  static getInstance(config: DaemonTransportConfig): PocketTtsDaemonProcess {
    const key = JSON.stringify({
      pythonBin: config.pythonBin,
      scriptPath: config.scriptPath,
      sshTarget: config.ssh?.target,
      sshPort: config.ssh?.port,
      sshIdentityFile: config.ssh?.identityFile,
      language: config.language,
      configPath: config.configPath,
      device: config.device,
      quantize: config.quantize,
      maxTokensPerChunk: config.maxTokensPerChunk,
      framesAfterEos: config.framesAfterEos,
      hardCancelTimeoutMs: config.hardCancelTimeoutMs,
    });

    const existing = PocketTtsDaemonProcess.instances.get(key);
    if (existing) {
      return existing;
    }

    const created = new PocketTtsDaemonProcess(config);
    PocketTtsDaemonProcess.instances.set(key, created);
    return created;
  }

  static shutdownAll(): void {
    for (const instance of PocketTtsDaemonProcess.instances.values()) {
      instance.shutdown(new Error("Pocket TTS daemon shutdown"));
    }
    PocketTtsDaemonProcess.instances.clear();
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
        requestId: request.requestId,
        text: request.text,
        voiceId: request.voiceId,
        modelId: request.modelId,
        onAudioChunk: request.onAudioChunk,
        onOutputSampleRate: request.onOutputSampleRate,
        resolve,
        reject,
        cancelTimer: null,
        cancelRequested: false,
      });

      void this.pumpQueue();
    });
  }

  cancel(requestId: string): void {
    const queuedIndex = this.queue.findIndex((request) => request.requestId === requestId);
    if (queuedIndex >= 0) {
      const [queued] = this.queue.splice(queuedIndex, 1);
      queued?.reject(new Error("Pocket TTS request canceled before synthesis started"));
      return;
    }

    if (!this.inFlight || this.inFlight.requestId !== requestId || this.inFlightCompleted) {
      return;
    }

    this.inFlight.cancelRequested = true;
    this.writeToDaemon({
      type: "cancel",
      request_id: requestId,
    });

    if (!this.inFlight.cancelTimer) {
      this.inFlight.cancelTimer = setTimeout(() => {
        if (!this.inFlight || this.inFlight.requestId !== requestId || this.inFlightCompleted) {
          return;
        }
        this.config.log("Pocket TTS daemon hard cancel timeout", {
          requestId,
          hardCancelTimeoutMs: this.config.hardCancelTimeoutMs,
        });
        this.shutdown(new Error("Pocket TTS daemon killed after cancel timeout"));
      }, this.config.hardCancelTimeoutMs);
    }
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
        reject(new Error("Pocket TTS daemon missing stdio streams"));
        return;
      }

      this.stdoutReader = createInterface({ input: child.stdout });

      child.stderr.on("data", (chunk: Buffer) => {
        this.config.log("Pocket TTS daemon stderr", chunk.toString("utf8"));
      });

      child.on("error", (error) => {
        this.config.log("Pocket TTS daemon process error", error);
        this.failActiveAndQueued(new Error(String(error)));
      });

      child.on("close", (code, signal) => {
        this.config.log("Pocket TTS daemon exited", { code, signal });
        this.child = null;
        this.ready = false;
        this.stdoutReader?.removeAllListeners();
        this.stdoutReader = null;
        this.failActiveAndQueued(
          new Error(
            `Pocket TTS daemon exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          ),
        );
      });

      this.stdoutReader.on("line", (line) => {
        this.handleDaemonLine(line);
      });

      const readyTimeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Pocket TTS daemon ready signal"));
      }, 30_000);

      const onReady = (line: string): void => {
        try {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type === "ready") {
            clearTimeout(readyTimeout);
            this.stdoutReader?.off("line", onReady);
            this.ready = true;
            this.config.log("Pocket TTS daemon ready");
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

    if (this.inFlight || this.queue.length === 0) {
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
      language: this.config.language,
      config_path: this.config.configPath,
      device: this.config.device,
      quantize: this.config.quantize,
      max_tokens: this.config.maxTokensPerChunk,
      frames_after_eos: this.config.framesAfterEos,
    };

    this.config.log("Pocket TTS daemon synth start", {
      requestId: next.requestId,
      modelId: next.modelId,
      voiceId: next.voiceId,
      textLength: next.text.length,
      language: this.config.language,
      configPath: this.config.configPath,
      device: this.config.device,
      quantize: this.config.quantize,
      maxTokensPerChunk: this.config.maxTokensPerChunk,
      framesAfterEos: this.config.framesAfterEos,
    });

    this.writeToDaemon(payload);
  }

  private writeToDaemon(payload: unknown): void {
    if (!this.child?.stdin) {
      this.completeInFlightWithError(new Error("Pocket TTS daemon is not available"));
      return;
    }

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
      language?: string;
      config_path?: string;
      device?: string;
      quantize?: boolean;
      sample_rate?: number;
      max_tokens?: number;
      frames_after_eos?: number;
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
      this.config.log("Pocket TTS daemon synth started", {
        requestId: this.inFlight.requestId,
        model: parsed.model,
        voice: parsed.voice,
        language: parsed.language,
        configPath: parsed.config_path,
        device: parsed.device,
        quantize: parsed.quantize,
        sampleRate: parsed.sample_rate,
        maxTokens: parsed.max_tokens,
        framesAfterEos: parsed.frames_after_eos,
      });
      return;
    }

    if (parsed.type === "audio" && typeof parsed.chunk_base64 === "string") {
      if (this.inFlight.cancelRequested) {
        return;
      }
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

    if (parsed.type === "canceled") {
      this.completeInFlightWithError(new Error("Pocket TTS request canceled"));
      return;
    }

    if (parsed.type === "error") {
      const error = new Error(parsed.error || "Pocket TTS daemon returned an unknown error");
      this.completeInFlightWithError(error);
    }
  }

  private clearCancelTimer(request: DaemonRequest): void {
    if (request.cancelTimer) {
      clearTimeout(request.cancelTimer);
      request.cancelTimer = null;
    }
  }

  private completeInFlightSuccess(): void {
    if (!this.inFlight || this.inFlightCompleted) {
      return;
    }

    this.clearCancelTimer(this.inFlight);
    this.inFlightCompleted = true;
    this.inFlight.resolve();
    this.inFlight = null;
    void this.pumpQueue();
  }

  private completeInFlightWithError(error: Error): void {
    if (!this.inFlight || this.inFlightCompleted) {
      return;
    }

    this.clearCancelTimer(this.inFlight);
    this.inFlightCompleted = true;
    this.inFlight.reject(error);
    this.inFlight = null;
    void this.pumpQueue();
  }

  private failActiveAndQueued(error: Error): void {
    if (this.inFlight && !this.inFlightCompleted) {
      this.clearCancelTimer(this.inFlight);
      this.inFlightCompleted = true;
      this.inFlight.reject(error);
      this.inFlight = null;
    }

    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued?.reject(error);
    }
  }

  private shutdown(error: Error): void {
    this.failActiveAndQueued(error);

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

export class PocketTtsDaemonClient {
  private readonly daemon: PocketTtsDaemonProcess;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly onAudioChunk: (pcmBytes: Uint8Array) => void;
  private readonly onOutputSampleRate?: (sampleRate: number) => void;
  private readonly onError: (error: unknown) => void;
  private readonly abortSignal: AbortSignal;
  private closed = false;
  private pendingText = "";
  private activeRequestId: string | null = null;

  constructor(options: PocketTtsDaemonClientOptions) {
    this.voiceId = validatePocketTtsIdentifier(options.voiceId, "voice ID");
    this.modelId = validatePocketTtsIdentifier(options.modelId, "model ID");
    this.onAudioChunk = options.onAudioChunk;
    this.onOutputSampleRate = options.onOutputSampleRate;
    this.onError = options.onError;
    this.abortSignal = options.abortSignal;
    this.daemon = PocketTtsDaemonProcess.getInstance({
      pythonBin: options.pythonBin,
      scriptPath: options.scriptPath,
      ssh: options.ssh,
      language: options.language,
      configPath: options.configPath,
      device: options.device,
      quantize: options.quantize,
      maxTokensPerChunk: options.maxTokensPerChunk,
      framesAfterEos: options.framesAfterEos,
      hardCancelTimeoutMs: options.hardCancelTimeoutMs,
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

    const requestId = randomUUID();
    this.activeRequestId = requestId;

    try {
      await this.daemon.enqueue({
        requestId,
        text: this.pendingText,
        voiceId: this.voiceId,
        modelId: this.modelId,
        onAudioChunk: this.onAudioChunk,
        onOutputSampleRate: this.onOutputSampleRate,
      });
    } catch (error) {
      this.onError(error);
      throw error;
    } finally {
      if (this.activeRequestId === requestId) {
        this.activeRequestId = null;
      }
    }
  }

  async cancel(): Promise<void> {
    this.closed = true;
    if (this.activeRequestId) {
      this.daemon.cancel(this.activeRequestId);
    }
  }
}

export function shutdownPocketTtsDaemonProcesses(): void {
  PocketTtsDaemonProcess.shutdownAll();
}
