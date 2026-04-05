import { describe, expect, test } from "vitest";

import {
  type VoiceClientState,
  getAcceptingClientCount,
  getAudioEnabledAcceptingClientCount,
  getDirectSttEnabledClientCount,
  getDirectTtsEnabledClientCount,
  getRecognitionEnabledAcceptingClientCount,
  getVoiceClientCapabilities,
} from "./clientState";

describe("client state counters", () => {
  test("counts accepting clients", () => {
    const states: VoiceClientState[] = [
      { acceptingRequests: true, speechEnabled: false, recognitionEnabled: false },
      { acceptingRequests: true, speechEnabled: true, recognitionEnabled: true },
      { acceptingRequests: false, speechEnabled: true, recognitionEnabled: true },
    ];

    expect(getAcceptingClientCount(states)).toBe(2);
  });

  test("counts only accepting clients with speech enabled", () => {
    const states: VoiceClientState[] = [
      { acceptingRequests: true, speechEnabled: false, recognitionEnabled: false },
      { acceptingRequests: true, speechEnabled: true, recognitionEnabled: true },
      { acceptingRequests: false, speechEnabled: true, recognitionEnabled: true },
    ];

    expect(getAudioEnabledAcceptingClientCount(states)).toBe(1);
  });

  test("counts only accepting clients with recognition enabled", () => {
    const states: VoiceClientState[] = [
      { acceptingRequests: true, speechEnabled: false, recognitionEnabled: false },
      { acceptingRequests: true, speechEnabled: true, recognitionEnabled: true },
      { acceptingRequests: false, speechEnabled: true, recognitionEnabled: true },
    ];

    expect(getRecognitionEnabledAcceptingClientCount(states)).toBe(1);
  });

  test("excludes direct-media-only clients from turn-mode counters", () => {
    const states: VoiceClientState[] = [
      {
        acceptingRequests: true,
        speechEnabled: true,
        recognitionEnabled: true,
        turnModeEnabled: false,
      },
      { acceptingRequests: true, speechEnabled: true, recognitionEnabled: true },
    ];

    expect(getAcceptingClientCount(states)).toBe(1);
    expect(getAudioEnabledAcceptingClientCount(states)).toBe(1);
    expect(getRecognitionEnabledAcceptingClientCount(states)).toBe(1);
  });

  test("counts direct-media capabilities independently from turn mode", () => {
    const states: VoiceClientState[] = [
      {
        acceptingRequests: false,
        speechEnabled: false,
        recognitionEnabled: false,
        turnModeEnabled: false,
        directTtsEnabled: true,
        directSttEnabled: true,
      },
      {
        acceptingRequests: true,
        speechEnabled: true,
        recognitionEnabled: true,
        directTtsEnabled: true,
        directSttEnabled: false,
      },
    ];

    expect(getDirectTtsEnabledClientCount(states)).toBe(2);
    expect(getDirectSttEnabledClientCount(states)).toBe(1);
  });

  test("normalizes capability defaults", () => {
    expect(
      getVoiceClientCapabilities({
        acceptingRequests: true,
        speechEnabled: true,
        recognitionEnabled: false,
      }),
    ).toEqual({
      turnModeEnabled: true,
      directTtsEnabled: false,
      directSttEnabled: false,
    });
  });
});
