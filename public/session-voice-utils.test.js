import { describe, expect, test } from "vitest";
import {
  canStartSessionVoiceCapture,
  createSessionVoiceCaptureRequestId,
  isSessionVoiceCaptureRequestId,
} from "./session-voice-utils.js";

describe("session-voice-utils", () => {
  test("createSessionVoiceCaptureRequestId returns prefixed id", () => {
    const requestId = createSessionVoiceCaptureRequestId(12345);
    expect(requestId.startsWith("session-voice-12345-")).toBe(true);
    expect(isSessionVoiceCaptureRequestId(requestId)).toBe(true);
  });

  test("isSessionVoiceCaptureRequestId rejects non-prefixed values", () => {
    expect(isSessionVoiceCaptureRequestId("")).toBe(false);
    expect(isSessionVoiceCaptureRequestId("ambient-123")).toBe(false);
    expect(isSessionVoiceCaptureRequestId("session-voice-abc")).toBe(true);
  });

  test("canStartSessionVoiceCapture validates required runtime state", () => {
    const base = {
      wsConnected: true,
      serviceEnabled: true,
      recognitionEnabled: true,
      sessionId: "session-123",
      activeTurnId: "",
      pendingRecognitionCount: 0,
    };

    expect(canStartSessionVoiceCapture(base)).toEqual({ ok: true, reason: "" });
    expect(canStartSessionVoiceCapture({ ...base, wsConnected: false }).ok).toBe(false);
    expect(canStartSessionVoiceCapture({ ...base, serviceEnabled: false }).ok).toBe(false);
    expect(canStartSessionVoiceCapture({ ...base, recognitionEnabled: false }).ok).toBe(false);
    expect(canStartSessionVoiceCapture({ ...base, sessionId: "" }).ok).toBe(false);
    expect(canStartSessionVoiceCapture({ ...base, activeTurnId: "turn-1" }).ok).toBe(false);
    expect(canStartSessionVoiceCapture({ ...base, pendingRecognitionCount: 2 }).ok).toBe(false);
  });
});
