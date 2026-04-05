import { describe, expect, test } from "vitest";

import { isCanceledReason, resolveCancellationMetadata } from "./cancellation-utils.js";

describe("cancellation-utils", () => {
  test("recognizes explicit cancel reason fields", () => {
    expect(
      resolveCancellationMetadata({
        success: false,
        canceled: true,
        cancelReason: "owner_socket_closed",
      }),
    ).toEqual({
      canceled: true,
      cancelReason: "owner_socket_closed",
    });
  });

  test("falls back to legacy canceled error strings", () => {
    expect(
      resolveCancellationMetadata({
        success: false,
        error: "Turn owner socket closed before completion",
      }),
    ).toEqual({
      canceled: true,
      cancelReason: "owner_socket_closed",
    });

    expect(
      resolveCancellationMetadata({
        success: false,
        error: "canceled",
      }),
    ).toEqual({
      canceled: true,
      cancelReason: "request_disconnected",
    });
  });

  test("does not mark non-cancel failures as canceled", () => {
    expect(
      resolveCancellationMetadata({
        success: false,
        error: "recognition timed out",
      }),
    ).toEqual({
      canceled: false,
      cancelReason: null,
    });
  });

  test("isCanceledReason matches new and legacy values", () => {
    expect(isCanceledReason("request_disconnected")).toBe(true);
    expect(isCanceledReason("owner_socket_closed")).toBe(true);
    expect(isCanceledReason("Turn owner socket closed before completion")).toBe(true);
    expect(isCanceledReason("canceled")).toBe(true);
    expect(isCanceledReason("timed out")).toBe(false);
  });
});
