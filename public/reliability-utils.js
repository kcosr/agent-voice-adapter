export function shouldRecoverStaleListen({
  activePhase,
  activeTurnId,
  lastListenEventAtMs,
  nowMs,
  staleThresholdMs,
}) {
  if (activePhase !== "listen") {
    return false;
  }
  if (typeof activeTurnId !== "string" || activeTurnId.length === 0) {
    return false;
  }
  if (!Number.isFinite(lastListenEventAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  if (!Number.isFinite(staleThresholdMs) || staleThresholdMs <= 0) {
    return false;
  }
  return nowMs - lastListenEventAtMs >= staleThresholdMs;
}
