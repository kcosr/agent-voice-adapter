import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android playback startup preroll setting", () => {
  test("renders startup preroll field in settings", () => {
    const layoutXml = readAndroidFile("res/layout/activity_main.xml");

    expect(layoutXml).toContain("Startup pre-roll (ms)");
    expect(layoutXml).toContain('android:id="@+id/playback_startup_preroll_input"');
    expect(layoutXml).toContain('android:id="@+id/playback_buffer_input"');
  });

  test("persists and wires startup preroll across activity and service config", () => {
    const configKt = readAndroidFile("java/com/agentvoiceadapter/android/AdapterConfig.kt");
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(configKt).toContain("const val PLAYBACK_STARTUP_PREROLL_MS = 200");
    expect(configKt).toContain(
      'private const val KEY_PLAYBACK_STARTUP_PREROLL_MS = "playback_startup_preroll_ms"',
    );
    expect(configKt).toContain(".putInt(");
    expect(activityKt).toContain("playbackStartupPrerollInput");
    expect(activityKt).toContain("playback_startup_preroll_input");
    expect(activityKt).toContain("playbackStartupPrerollMs = playbackStartupPrerollMs");
    expect(serviceKt).toContain(
      'private const val EXTRA_PLAYBACK_STARTUP_PREROLL_MS = "playback_startup_preroll_ms"',
    );
    expect(serviceKt).toContain(
      "putExtra(EXTRA_PLAYBACK_STARTUP_PREROLL_MS, config.playbackStartupPrerollMs)",
    );
    expect(serviceKt).toContain(
      "player.setPlaybackStartupPrerollMs(config.playbackStartupPrerollMs)",
    );
  });

  test("applies preroll to first tts chunk and cue playback start", () => {
    const playerKt = readAndroidFile("java/com/agentvoiceadapter/android/PcmAudioPlayer.kt");

    expect(playerKt).toContain("fun setPlaybackStartupPrerollMs(ms: Int)");
    expect(playerKt).toContain("fun playBase64Chunk(turnId: String, chunkBase64: String");
    expect(playerKt).toContain("shouldApplyStartupPrerollForTurnNoLock(turnId)");
    expect(playerKt).toContain("buildStartupPrerollPcmNoLock(outputRate)");
    expect(playerKt).toContain("val prerollBytes = buildStartupPrerollPcmNoLock(outputRate)");
    expect(playerKt).toContain(
      "private fun shouldApplyStartupPrerollForTurnNoLock(turnId: String)",
    );
    expect(playerKt).toContain("private fun buildStartupPrerollPcmNoLock(rate: Int)");
  });

  test("persists and applies playback buffer setting", () => {
    const configKt = readAndroidFile("java/com/agentvoiceadapter/android/AdapterConfig.kt");
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");
    const playerKt = readAndroidFile("java/com/agentvoiceadapter/android/PcmAudioPlayer.kt");

    expect(configKt).toContain("const val PLAYBACK_BUFFER_MS = 500");
    expect(configKt).toContain('private const val KEY_PLAYBACK_BUFFER_MS = "playback_buffer_ms"');
    expect(activityKt).toContain("playbackBufferInput");
    expect(activityKt).toContain("playback_buffer_input");
    expect(activityKt).toContain("playbackBufferMs = playbackBufferMs");
    expect(serviceKt).toContain(
      'private const val EXTRA_PLAYBACK_BUFFER_MS = "playback_buffer_ms"',
    );
    expect(serviceKt).toContain("putExtra(EXTRA_PLAYBACK_BUFFER_MS, config.playbackBufferMs)");
    expect(serviceKt).toContain("player.setPlaybackBufferMs(config.playbackBufferMs)");
    expect(playerKt).toContain("fun setPlaybackBufferMs(ms: Int)");
    expect(playerKt).toContain("targetBufferBytes");
    expect(playerKt).toContain("playbackBufferMs");
  });

  test("uses playback worker queue so AudioTrack writes are decoupled from ws ingest", () => {
    const playerKt = readAndroidFile("java/com/agentvoiceadapter/android/PcmAudioPlayer.kt");

    expect(playerKt).toContain("private data class QueuedPcmChunk");
    expect(playerKt).toContain("private val queuedPcm = ArrayDeque<QueuedPcmChunk>()");
    expect(playerKt).toContain("private fun enqueuePcmChunk(");
    expect(playerKt).toContain("private fun playbackWorkerLoop()");
    expect(playerKt).toContain("private fun writeQueuedChunk(chunk: QueuedPcmChunk)");
    expect(playerKt).toContain("private fun maybeResolvePlaybackDrainNoLock()");
    expect(playerKt).toContain("writeInProgressDurationMs");
    expect(playerKt).toContain("private var playbackEpoch: Long = 0L");
    expect(playerKt).toContain("chunk.epoch == playbackEpoch");
    expect(playerKt).toContain("private fun advancePlaybackEpochNoLock()");
  });
});
