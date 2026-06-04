import type { AppConfig } from "./config";
import { ElevenLabsStreamingClient } from "./elevenLabsStreamingClient";
import { KokoroLocalDaemonClient } from "./kokoroLocalDaemonClient";
import { PocketTtsDaemonClient } from "./pocketTtsDaemonClient";

export interface StreamingTtsClient {
  sendText(text: string): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

export interface CreateStreamingTtsClientOptions {
  modelId: string;
  voiceId: string;
  abortSignal: AbortSignal;
  onAudioChunk: (pcmBytes: Uint8Array) => void;
  onOutputSampleRate?: (sampleRate: number) => void;
  onError: (error: unknown) => void;
  log: (...args: unknown[]) => void;
}

export function createStreamingTtsClient(
  config: AppConfig,
  options: CreateStreamingTtsClientOptions,
): StreamingTtsClient {
  if (config.tts.provider === "kokoro_local") {
    if (!config.kokoroLocal) {
      throw new Error("Missing kokoro_local provider configuration");
    }

    return new KokoroLocalDaemonClient({
      pythonBin: config.kokoroLocal.pythonBin,
      scriptPath: config.kokoroLocal.scriptPath,
      ssh: config.kokoroLocal.ssh,
      voiceId: options.voiceId,
      modelId: options.modelId,
      langCode: config.kokoroLocal.langCode,
      speed: config.kokoroLocal.speed,
      device: config.kokoroLocal.device,
      maxTextCharsPerChunk: config.kokoroLocal.maxTextCharsPerChunk,
      gapMsBetweenChunks: config.kokoroLocal.gapMsBetweenChunks,
      abortSignal: options.abortSignal,
      onAudioChunk: options.onAudioChunk,
      onOutputSampleRate: options.onOutputSampleRate,
      onError: options.onError,
      log: options.log,
    });
  }

  if (config.tts.provider === "pocket_tts") {
    if (!config.pocketTts) {
      throw new Error("Missing pocket_tts provider configuration");
    }

    return new PocketTtsDaemonClient({
      pythonBin: config.pocketTts.pythonBin,
      scriptPath: config.pocketTts.scriptPath,
      ssh: config.pocketTts.ssh,
      voiceId: options.voiceId,
      modelId: options.modelId,
      language: config.pocketTts.language,
      configPath: config.pocketTts.configPath,
      device: config.pocketTts.device,
      quantize: config.pocketTts.quantize,
      maxTokensPerChunk: config.pocketTts.maxTokensPerChunk,
      framesAfterEos: config.pocketTts.framesAfterEos,
      hardCancelTimeoutMs: config.pocketTts.hardCancelTimeoutMs,
      abortSignal: options.abortSignal,
      onAudioChunk: options.onAudioChunk,
      onOutputSampleRate: options.onOutputSampleRate,
      onError: options.onError,
      log: options.log,
    });
  }

  if (!config.elevenLabs) {
    throw new Error("Missing ElevenLabs provider configuration");
  }

  return new ElevenLabsStreamingClient({
    apiKey: config.elevenLabs.apiKey,
    voiceId: options.voiceId,
    modelId: options.modelId,
    baseUrl: config.elevenLabs.baseUrl,
    outputFormat: config.elevenLabs.outputFormat,
    abortSignal: options.abortSignal,
    onAudioChunk: options.onAudioChunk,
    onError: options.onError,
    log: options.log,
  });
}
