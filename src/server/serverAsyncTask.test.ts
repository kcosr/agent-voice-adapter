import { describe, expect, test, vi } from "vitest";

import { runWebsocketAsyncTaskSafely } from "./server";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("runWebsocketAsyncTaskSafely", () => {
  test("logs and forwards request-scoped errors", async () => {
    const logger = vi.fn();
    const onRequestError = vi.fn();

    runWebsocketAsyncTaskSafely({
      requestId: "turn-1",
      operation: "turn_listen_blob",
      task: async () => {
        throw new Error("boom");
      },
      onRequestError,
      logger,
    });

    await flushMicrotasks();

    expect(logger).toHaveBeenCalledWith("[agent-voice-adapter] websocket async handler failed", {
      operation: "turn_listen_blob",
      requestId: "turn-1",
      error: "boom",
    });
    expect(onRequestError).toHaveBeenCalledWith("turn-1", "boom");
  });

  test("logs but does not forward when requestId is null", async () => {
    const logger = vi.fn();
    const onRequestError = vi.fn();

    runWebsocketAsyncTaskSafely({
      requestId: null,
      operation: "turn_listen_stream_chunk",
      task: async () => {
        throw new Error("stream failure");
      },
      onRequestError,
      logger,
    });

    await flushMicrotasks();

    expect(logger).toHaveBeenCalledWith("[agent-voice-adapter] websocket async handler failed", {
      operation: "turn_listen_stream_chunk",
      requestId: null,
      error: "stream failure",
    });
    expect(onRequestError).not.toHaveBeenCalled();
  });
});
