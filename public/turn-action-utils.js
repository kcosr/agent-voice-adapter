export function resolvePrimaryBubbleAction(phase) {
  if (phase === "tts" || phase === "listen_handoff") {
    return "stop_tts";
  }
  if (phase === "listen") {
    return "cancel_turn";
  }
  return null;
}
