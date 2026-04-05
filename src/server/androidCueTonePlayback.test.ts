import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android cue tone playback", () => {
  test("routes cues through default notification ringtone with transient focus", () => {
    const cuePlayerKt = readAndroidFile("java/com/agentvoiceadapter/android/CuePlayer.kt");

    expect(cuePlayerKt).toContain("AudioAttributes.USAGE_NOTIFICATION_EVENT");
    expect(cuePlayerKt).toContain("RingtoneManager");
    expect(cuePlayerKt).toContain("TYPE_NOTIFICATION");
    expect(cuePlayerKt).toContain("TYPE_ALARM");
    expect(cuePlayerKt).toContain("TYPE_RINGTONE");
    expect(cuePlayerKt).toContain("getDefaultUri");
    expect(cuePlayerKt).toContain("getRingtone");
    expect(cuePlayerKt).toContain("playNotificationOnceLocked");
    expect(cuePlayerKt).toContain("requestAudioFocus");
    expect(cuePlayerKt).toContain("abandonAudioFocusRequest");
    expect(cuePlayerKt).toContain("setGainMultiplier");
    expect(cuePlayerKt).toContain(
      "Ringtone playback does not expose stable per-playback gain control",
    );
  });

  test("service defers recognition cues until capture teardown if needed", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("cuePlayer = CuePlayer(this)");
    expect(serviceKt).toContain("cuePlayer.setGainMultiplier(config.ttsGain)");
    expect(serviceKt).toContain("pendingRecognitionCueByTurnId");
    expect(serviceKt).toContain("pendingRetryCaptureTurnIds");
    expect(serviceKt).toContain("handledRecognitionCueTurnIds");
    expect(serviceKt).toContain("suppressSuccessCueTurnIds");
    expect(serviceKt).toContain("cue_state turn_start");
    expect(serviceKt).toContain("cue_state turn_tts_end");
    expect(serviceKt).toContain("cue_state turn_listen_stop");
    expect(serviceKt).toContain("cue_state turn_listen_result");
    expect(serviceKt).toContain("cue_state retry_capture_wait");
    expect(serviceKt).toContain("cue_state retry_capture_restart");
    expect(serviceKt).toContain("cue_state capture_chunk_send_failed");
    expect(serviceKt).toContain("cue_state capture_unexpected_stop");
    expect(serviceKt).toContain("cue_state capture_recover_schedule");
    expect(serviceKt).toContain("cue_state capture_watchdog_stop");
    expect(serviceKt).toContain("armTurnCaptureWatchdog(turnId)");
    expect(serviceKt).toContain("scheduleTurnCaptureRecovery(turnId,");
    expect(serviceKt).toContain("cue_state play_attempt");
    expect(serviceKt).toContain("private fun runOnMain(block: () -> Unit)");
    expect(serviceKt).toContain("private fun dispatchServerMessage(rawText: String)");
    expect(serviceKt).toContain("state_thread_violation operation=");
    expect(serviceKt).toContain('if (type == "turn_audio_chunk")');
    expect(serviceKt).toContain("maybePlayRecognitionCue(turnId, success)");
    expect(serviceKt).not.toContain("scheduleListenStopCueFallback(turnId)");
    expect(serviceKt).not.toContain("cancelListenStopCueFallback(turnId)");
    expect(serviceKt).toContain(
      "val captureStillActive = turnId == activeTurnCaptureId || micStreamer.isRunningFor(turnId)",
    );
    expect(serviceKt).toContain("pendingRecognitionCueByTurnId.remove(turnId)?.let");
    expect(serviceKt).toContain("playRecognitionCue(turnId, cueSuccess)");
    expect(serviceKt).toContain("playRecognitionCue(turnId, success)");
    expect(serviceKt).toContain("cue_state suppress_success_cue");
    expect(serviceKt).toContain('emitEvent(EVENT_TYPE_BUBBLE, "System: Recognition retrying...")');
    expect(serviceKt).toContain("cue_state play_skip turnId=$turnId reason=$reason");
    expect(serviceKt).toContain("if (handledRecognitionCueTurnIds.contains(turnId))");
    expect(serviceKt).toContain('if (turnId != "manual")');
    expect(serviceKt).toContain("player.playCueProbe(success)");
    expect(serviceKt).toContain("player.stop()");
    expect(serviceKt).toContain("stopTurnCapture()");
    expect(serviceKt).toContain("micStreamer.stop(turnId)");
    expect(serviceKt).toContain("cuePlayer.playWakeCue()");
    expect(serviceKt).not.toContain("cuePlayer.playWakeCue(start");
  });

  test("player provides a media-stream cue probe for audibility debugging", () => {
    const playerKt = readAndroidFile("java/com/agentvoiceadapter/android/PcmAudioPlayer.kt");

    expect(playerKt).toContain("fun playCueProbe(success: Boolean = true): Boolean");
    expect(playerKt).toContain("requestPlaybackFocusIfNeeded()");
    expect(playerKt).toContain("requestPlaybackFocusNoLock()");
    expect(playerKt).toContain("abandonCaptureFocusNoLock()");
    expect(playerKt).toContain("resolveCueOutputRateNoLock()");
    expect(playerKt).toContain("AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE");
    expect(playerKt).toContain('logCueProbeState("start", success, null, null)');
    expect(playerKt).toContain('logCueProbeState("focus_denied", success, null, null)');
    expect(playerKt).toContain('logCueProbeState("write", success, bytesWritten, probeGain)');
    expect(playerKt).toContain("cue_probe stage=");
    expect(playerKt).toContain("probeGain=");
    expect(playerKt).toContain("cue_probe stage=post_write_check");
    expect(playerKt).toContain("scheduleCueProbePostWriteCheckNoLock");
    expect(playerKt).toContain("expectedFrames=");
    expect(playerKt).toContain("advanced=");
    expect(playerKt).toContain("replayAttempt=");
    expect(playerKt).toContain("cue_probe stage=post_write_replay_trigger");
    expect(playerKt).toContain('logCueProbeState("replay_write", success, replayWrite, probeGain)');
    expect(playerKt).toContain("CUE_PROBE_MAX_REPLAY_ATTEMPTS");
    expect(playerKt).toContain("streamVolume=");
    expect(playerKt).toContain("routedDevice=");
    expect(playerKt).toContain("ensureTrack(outputRate)");
    expect(playerKt).toContain("resetTrackBufferForProbeNoLock()");
    expect(playerKt).toContain("val probeGain = resolveRecognitionCueProbeGainNoLock()");
    expect(playerKt).toContain("private fun resolveRecognitionCueProbeGainNoLock(): Float");
    expect(playerKt).toContain("val cueGainDb = -16.0 + (normalized.toDouble() * 28.0)");
    expect(playerKt).toContain("10.0.pow(cueGainDb / 20.0)");
    expect(playerKt).toContain("generateCueProbePcm(outputRate, success)");
    expect(playerKt).toContain("track?.write(adjustedBytes, 0, adjustedBytes.size)");
    expect(playerKt).toContain(
      "private fun generateCueProbePcm(sampleRate: Int, success: Boolean)",
    );
  });
});
