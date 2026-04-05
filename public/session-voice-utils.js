import { asNonEmptyString } from "./string-utils.js";

export function createSessionVoiceCaptureRequestId(nowMs = Date.now()) {
  const ts = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : Date.now();
  const suffix = Math.random().toString(36).slice(2, 10);
  return `session-voice-${ts}-${suffix}`;
}

export function isSessionVoiceCaptureRequestId(requestId) {
  return asNonEmptyString(requestId).startsWith("session-voice-");
}

export function canStartSessionVoiceCapture(params) {
  const wsConnected = params?.wsConnected === true;
  if (!wsConnected) {
    return { ok: false, reason: "WebSocket is disconnected." };
  }

  const serviceEnabled = params?.serviceEnabled === true;
  if (!serviceEnabled) {
    return { ok: false, reason: "Service is disabled." };
  }

  const recognitionEnabled = params?.recognitionEnabled === true;
  if (!recognitionEnabled) {
    return { ok: false, reason: "Microphone recognition is not enabled." };
  }

  const sessionId = asNonEmptyString(params?.sessionId);
  if (!sessionId) {
    return { ok: false, reason: "Select a target session first." };
  }

  const activeTurnId = asNonEmptyString(params?.activeTurnId);
  if (activeTurnId) {
    return { ok: false, reason: "Wait for the active turn to finish." };
  }

  const pendingRecognitionCount = Number.isFinite(params?.pendingRecognitionCount)
    ? Math.max(0, Math.floor(params.pendingRecognitionCount))
    : 0;
  if (pendingRecognitionCount > 0) {
    return { ok: false, reason: "Recognition is already in progress." };
  }

  return { ok: true, reason: "" };
}
