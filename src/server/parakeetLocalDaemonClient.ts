import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Interface, createInterface } from "node:readline";

import { type SshTransportOptions, buildPythonDaemonCommand } from "./daemonCommand";

interface DaemonRequest {
  requestId: string;
  audioBase64: string;
  mimeType?: string;
  modelId?: string;
  resolve: (result: DaemonTranscriptionResult) => void;
  reject: (error: Error) => void;
}

interface DaemonJobInput {
  audioBytes: Uint8Array;
  mimeType?: string;
  modelId?: string;
}

export interface DaemonTranscriptionResult {
  text: string;
  modelId: string;
  durationMs: number;
}

export interface ParakeetLocalDaemonClientOptions {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshTransportOptions;
  modelId: string;
  device: "cuda" | "cpu" | "auto";
  timeoutMs: number;
  log?: (...args: unknown[]) => void;
}

interface DaemonTransportConfig {
  pythonBin: string;
  scriptPath: string;
  ssh?: SshTransportOptions;
  modelId: string;
  device: "cuda" | "cpu" | "auto";
  timeoutMs: number;
  log: (...args: unknown[]) => void;
}

class ParakeetDaemonProcess {
  private static instances = new Map<string, ParakeetDaemonProcess>();

  static getInstance(config: DaemonTransportConfig): ParakeetDaemonProcess {
    const key = JSON.stringify({
      pythonBin: config.pythonBin,
      scriptPath: config.scriptPath,
      sshTarget: config.ssh?.target,
      sshPort: config.ssh?.port,
      sshIdentityFile: config.ssh?.identityFile,
      modelId: config.modelId,
      device: config.device,
      timeoutMs: config.timeoutMs,
    });

    const existing = ParakeetDaemonProcess.instances.get(key);
    if (existing) {
      return existing;
    }

    const created = new ParakeetDaemonProcess(config);
    ParakeetDaemonProcess.instances.set(key, created);
    return created;
  }

  static shutdownAll(): void {
    for (const instance of ParakeetDaemonProcess.instances.values()) {
      instance.shutdown();
    }
    ParakeetDaemonProcess.instances.clear();
  }

  private readonly config: DaemonTransportConfig;
  private child: ChildProcess | null = null;
  private stdoutReader: Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private queue: DaemonRequest[] = [];
  private inFlight: DaemonRequest | null = null;
  private ready = false;
  private inFlightCompleted = false;
  private inFlightTimeoutHandle: NodeJS.Timeout | null = null;

  private constructor(config: DaemonTransportConfig) {
    this.config = config;
  }

  enqueue(request: DaemonJobInput): Promise<DaemonTranscriptionResult> {
    return new Promise<DaemonTranscriptionResult>((resolve, reject) => {
      this.queue.push({
        requestId: randomUUID(),
        audioBase64: Buffer.from(request.audioBytes).toString("base64"),
        mimeType: request.mimeType,
        modelId: request.modelId,
        resolve,
        reject,
      });

      void this.pumpQueue();
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
        pythonArgs: [
          "--model",
          this.config.modelId,
          "--device",
          this.config.device,
          "--quiet",
          "--warmup",
        ],
        ssh: this.config.ssh,
      });
      const child = spawn(launch.command, launch.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.child = child;
      this.ready = false;

      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error("Parakeet daemon missing stdio streams"));
        return;
      }

      this.stdoutReader = createInterface({ input: child.stdout });

      child.stderr.on("data", (chunk: Buffer) => {
        if (this.child !== child) {
          return;
        }

        this.config.log("Parakeet daemon stderr", chunk.toString("utf8"));
      });

      child.on("error", (error) => {
        if (this.child !== child) {
          return;
        }

        this.config.log("Parakeet daemon process error", error);
        this.failActiveAndQueued(new Error(String(error)));
      });

      child.on("close", (code, signal) => {
        if (this.child !== child) {
          return;
        }

        this.config.log("Parakeet daemon exited", { code, signal });
        this.child = null;
        this.ready = false;
        this.stdoutReader?.removeAllListeners();
        this.stdoutReader = null;
        this.failActiveAndQueued(
          new Error(
            `Parakeet daemon exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          ),
        );
      });

      this.stdoutReader.on("line", (line) => {
        this.handleDaemonLine(line);
      });

      const readyTimeout = setTimeout(() => {
        if (this.child === child) {
          this.config.log("Parakeet daemon ready timeout reached, restarting process");
          this.restartDaemon();
        }
        reject(new Error("Timed out waiting for parakeet daemon ready signal"));
      }, 90_000);

      const onReady = (line: string): void => {
        try {
          const parsed = JSON.parse(line) as { type?: string };
          if (parsed.type === "ready") {
            clearTimeout(readyTimeout);
            this.stdoutReader?.off("line", onReady);
            this.ready = true;
            this.config.log("Parakeet daemon ready");
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
      this.failActiveAndQueued(new Error("Parakeet daemon is not available"));
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.inFlight = next;
    this.inFlightCompleted = false;

    const payload = {
      type: "transcribe",
      request_id: next.requestId,
      audio_base64: next.audioBase64,
      mime_type: next.mimeType,
      model: next.modelId,
      device: this.config.device,
    };

    this.config.log("Parakeet daemon transcription start", {
      requestId: next.requestId,
      modelId: next.modelId || this.config.modelId,
      bytesBase64Length: next.audioBase64.length,
    });

    this.inFlightTimeoutHandle = setTimeout(() => {
      const currentRequestId = this.inFlight?.requestId;
      this.completeInFlightWithError(
        new Error(`Parakeet daemon timed out after ${this.config.timeoutMs}ms`),
      );
      this.config.log("Parakeet daemon transcription timeout", { requestId: currentRequestId });
      this.restartDaemon();
    }, this.config.timeoutMs);

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
      text?: string;
      error?: string;
      model_id?: string;
      duration_ms?: number;
      durationMs?: number;
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
      this.config.log("Parakeet daemon started", {
        requestId: parsed.request_id,
        modelId: parsed.model_id,
      });
      return;
    }

    if (parsed.type === "result") {
      const durationRaw = Number.isFinite(parsed.duration_ms)
        ? Number(parsed.duration_ms)
        : Number.isFinite(parsed.durationMs)
          ? Number(parsed.durationMs)
          : 0;
      const normalizedText = typeof parsed.text === "string" ? parsed.text : "";
      this.config.log("Parakeet daemon result", {
        requestId: parsed.request_id,
        modelId:
          (typeof parsed.model_id === "string" && parsed.model_id.trim()) ||
          this.inFlight.modelId ||
          this.config.modelId,
        durationMs: durationRaw,
        textLength: normalizedText.trim().length,
        textPreview: normalizedText.trim().slice(0, 160),
      });
      this.completeInFlightSuccess({
        text: normalizedText,
        modelId:
          (typeof parsed.model_id === "string" && parsed.model_id.trim()) ||
          this.inFlight.modelId ||
          this.config.modelId,
        durationMs: durationRaw,
      });
      return;
    }

    if (parsed.type === "error") {
      this.completeInFlightWithError(
        new Error(parsed.error || "Parakeet daemon returned an unknown error"),
      );
    }
  }

  private completeInFlightSuccess(result: DaemonTranscriptionResult): void {
    if (!this.inFlight || this.inFlightCompleted) {
      return;
    }

    this.clearInFlightTimeout();
    this.inFlightCompleted = true;
    this.inFlight.resolve(result);
    this.inFlight = null;
    void this.pumpQueue();
  }

  private completeInFlightWithError(error: Error): void {
    if (!this.inFlight || this.inFlightCompleted) {
      return;
    }

    this.clearInFlightTimeout();
    this.inFlightCompleted = true;
    this.inFlight.reject(error);
    this.inFlight = null;
    void this.pumpQueue();
  }

  private clearInFlightTimeout(): void {
    if (!this.inFlightTimeoutHandle) {
      return;
    }

    clearTimeout(this.inFlightTimeoutHandle);
    this.inFlightTimeoutHandle = null;
  }

  private restartDaemon(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;

    this.stdoutReader?.removeAllListeners();
    this.stdoutReader = null;

    if (child) {
      child.kill("SIGKILL");
    }
  }

  private failActiveAndQueued(error: Error): void {
    this.clearInFlightTimeout();

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
    this.failActiveAndQueued(new Error("Parakeet daemon shutdown"));

    this.clearInFlightTimeout();
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

export class ParakeetLocalDaemonClient {
  private readonly daemon: ParakeetDaemonProcess;

  constructor(options: ParakeetLocalDaemonClientOptions) {
    this.daemon = ParakeetDaemonProcess.getInstance({
      pythonBin: options.pythonBin,
      scriptPath: options.scriptPath,
      ssh: options.ssh,
      modelId: options.modelId,
      device: options.device,
      timeoutMs: options.timeoutMs,
      log: options.log ?? (() => {}),
    });
  }

  async transcribe(request: DaemonJobInput): Promise<DaemonTranscriptionResult> {
    return this.daemon.enqueue(request);
  }
}

export function shutdownParakeetDaemonProcesses(): void {
  ParakeetDaemonProcess.shutdownAll();
}
