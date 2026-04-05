function normalizeCancelReason(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized === "request_disconnected" ||
    normalized === "canceled" ||
    normalized.includes("request canceled") ||
    normalized.includes("http client disconnected")
  ) {
    return "request_disconnected";
  }

  if (
    normalized === "owner_socket_closed" ||
    normalized === "turn owner socket closed before completion" ||
    normalized.includes("owner socket closed")
  ) {
    return "owner_socket_closed";
  }

  if (normalized === "client_end") {
    return "client_end";
  }

  if (normalized === "stop_tts" || normalized.includes("stop tts")) {
    return "stop_tts";
  }

  if (normalized === "unknown") {
    return "unknown";
  }

  return null;
}

export function isCanceledReason(value) {
  return normalizeCancelReason(value) !== null;
}

export function resolveCancellationMetadata(payload) {
  if (!payload || typeof payload !== "object" || payload.success === true) {
    return {
      canceled: false,
      cancelReason: null,
    };
  }

  const explicitReason = normalizeCancelReason(payload.cancelReason);
  const fallbackReason = normalizeCancelReason(payload.error);
  const canceled = payload.canceled === true || explicitReason !== null || fallbackReason !== null;

  return {
    canceled,
    cancelReason: explicitReason ?? fallbackReason,
  };
}
