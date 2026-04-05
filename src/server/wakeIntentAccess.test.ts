import { describe, expect, test } from "vitest";

import { isLoopbackAddress, isWakeIntentRequestAllowed } from "./wakeIntentAccess";

describe("wakeIntentAccess", () => {
  test("identifies loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress("10.0.0.25")).toBe(false);
  });

  test("allows local requests regardless of remote policy", () => {
    expect(
      isWakeIntentRequestAllowed({
        remoteAddress: "127.0.0.1",
        policy: {
          allowRemote: false,
        },
      }),
    ).toBe(true);
  });

  test("allows remote requests when explicitly enabled", () => {
    expect(
      isWakeIntentRequestAllowed({
        remoteAddress: "10.0.0.25",
        policy: {
          allowRemote: true,
        },
      }),
    ).toBe(true);
  });

  test("allows remote requests with matching shared secret", () => {
    expect(
      isWakeIntentRequestAllowed({
        remoteAddress: "10.0.0.25",
        providedSecret: "top-secret",
        policy: {
          allowRemote: false,
          sharedSecret: "top-secret",
        },
      }),
    ).toBe(true);
  });

  test("rejects remote requests without allowRemote or shared secret", () => {
    expect(
      isWakeIntentRequestAllowed({
        remoteAddress: "10.0.0.25",
        policy: {
          allowRemote: false,
        },
      }),
    ).toBe(false);
  });

  test("rejects remote requests with wrong shared secret", () => {
    expect(
      isWakeIntentRequestAllowed({
        remoteAddress: "10.0.0.25",
        providedSecret: "wrong",
        policy: {
          allowRemote: false,
          sharedSecret: "top-secret",
        },
      }),
    ).toBe(false);
  });
});
