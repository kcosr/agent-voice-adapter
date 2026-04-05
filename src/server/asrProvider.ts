import type { AppConfig } from "./config";
import { OpenAiAsrClient } from "./openaiAsrClient";
import { ParakeetLocalDaemonClient } from "./parakeetLocalDaemonClient";

export interface TranscribeAudioRequest {
  audioBytes: Uint8Array;
  mimeType?: string;
  modelId?: string;
}

export interface AsrTranscription {
  text: string;
  providerId: "parakeet_local" | "openai";
  modelId: string;
  durationMs: number;
}

export interface AsrProviderClient {
  transcribeAudio(request: TranscribeAudioRequest): Promise<AsrTranscription>;
}

interface CreateAsrProviderOptions {
  log?: (...args: unknown[]) => void;
}

class ParakeetLocalDaemonAsrClient implements AsrProviderClient {
  private readonly daemon: ParakeetLocalDaemonClient;

  constructor(
    config: NonNullable<AppConfig["parakeetLocal"]>,
    options: { log?: (...args: unknown[]) => void },
  ) {
    this.daemon = new ParakeetLocalDaemonClient({
      pythonBin: config.pythonBin,
      scriptPath: config.scriptPath,
      ssh: config.ssh,
      modelId: config.modelId,
      device: config.device,
      timeoutMs: config.timeoutMs,
      log: options.log,
    });
  }

  async transcribeAudio(request: TranscribeAudioRequest): Promise<AsrTranscription> {
    const result = await this.daemon.transcribe({
      audioBytes: request.audioBytes,
      mimeType: request.mimeType,
      modelId: request.modelId,
    });

    return {
      text: result.text,
      providerId: "parakeet_local",
      modelId: result.modelId,
      durationMs: result.durationMs,
    };
  }
}

class OpenAiAsrProviderClient implements AsrProviderClient {
  private readonly client: OpenAiAsrClient;

  constructor(
    config: NonNullable<AppConfig["openaiAsr"]>,
    options: { log?: (...args: unknown[]) => void },
  ) {
    this.client = new OpenAiAsrClient({
      apiKey: config.apiKey,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      language: config.language,
      timeoutMs: config.timeoutMs,
      log: options.log,
    });
  }

  async transcribeAudio(request: TranscribeAudioRequest): Promise<AsrTranscription> {
    const result = await this.client.transcribe({
      audioBytes: request.audioBytes,
      mimeType: request.mimeType,
      modelId: request.modelId,
    });

    return {
      text: result.text,
      providerId: "openai",
      modelId: result.modelId,
      durationMs: result.durationMs,
    };
  }
}

export function createAsrProvider(
  config: AppConfig,
  options: CreateAsrProviderOptions = {},
): AsrProviderClient | null {
  if (config.asr.provider === "parakeet_local") {
    if (!config.parakeetLocal) {
      throw new Error("ASR provider is parakeet_local but config.parakeetLocal is missing");
    }

    return new ParakeetLocalDaemonAsrClient(config.parakeetLocal, {
      log: options.log,
    });
  }

  if (config.asr.provider === "openai") {
    if (!config.openaiAsr) {
      throw new Error("ASR provider is openai but config.openaiAsr is missing");
    }

    return new OpenAiAsrProviderClient(config.openaiAsr, {
      log: options.log,
    });
  }

  return null;
}
