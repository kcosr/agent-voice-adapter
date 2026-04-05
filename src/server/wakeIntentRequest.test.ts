import { describe, expect, test } from "vitest";

import { resolveWakeIntentRequest } from "./wakeIntentRequest";

describe("resolveWakeIntentRequest", () => {
  test("rejects unauthorized remote wake-intent requests", async () => {
    const result = await resolveWakeIntentRequest({
      text: "agent what is the date",
      remoteAddress: "10.0.0.8",
      accessPolicy: {
        allowRemote: false,
      },
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error:
        "wake-intent denied (remote requests require allowRemote or valid x-wake-intent-secret)",
    });
  });

  test("rejects missing text payload", async () => {
    const result = await resolveWakeIntentRequest({
      text: null,
      remoteAddress: "127.0.0.1",
      accessPolicy: {
        allowRemote: false,
      },
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'Expected JSON payload: { "text": string }',
    });
  });

  test("accepts local echo request", async () => {
    const result = await resolveWakeIntentRequest({
      text: "agent echo hello there",
      remoteAddress: "127.0.0.1",
      accessPolicy: {
        allowRemote: false,
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      intent: {
        action: "echo",
      },
      execution: {
        executed: true,
        output: "hello there",
      },
    });
  });

  test("accepts remote request with matching shared secret", async () => {
    const result = await resolveWakeIntentRequest({
      text: "agent echo secured",
      remoteAddress: "10.0.0.8",
      providedSecret: "test-secret",
      accessPolicy: {
        allowRemote: false,
        sharedSecret: "test-secret",
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      accepted: true,
      execution: {
        executed: true,
        output: "secured",
      },
    });
  });
});
