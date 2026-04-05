export interface VoiceClientState {
  acceptingRequests: boolean;
  speechEnabled: boolean;
  recognitionEnabled: boolean;
  inTurn?: boolean;
  turnModeEnabled?: boolean;
  directTtsEnabled?: boolean;
  directSttEnabled?: boolean;
}

export interface VoiceClientCapabilities {
  turnModeEnabled: boolean;
  directTtsEnabled: boolean;
  directSttEnabled: boolean;
}

export function getVoiceClientCapabilities(state: VoiceClientState): VoiceClientCapabilities {
  return {
    turnModeEnabled: state.turnModeEnabled !== false,
    directTtsEnabled: state.directTtsEnabled === true,
    directSttEnabled: state.directSttEnabled === true,
  };
}

export function getAcceptingClientCount(states: Iterable<VoiceClientState>): number {
  let total = 0;
  for (const state of states) {
    if (state.acceptingRequests && getVoiceClientCapabilities(state).turnModeEnabled) {
      total += 1;
    }
  }
  return total;
}

export function getAudioEnabledAcceptingClientCount(states: Iterable<VoiceClientState>): number {
  let total = 0;
  for (const state of states) {
    if (
      state.acceptingRequests &&
      state.speechEnabled &&
      getVoiceClientCapabilities(state).turnModeEnabled
    ) {
      total += 1;
    }
  }
  return total;
}

export function getRecognitionEnabledAcceptingClientCount(
  states: Iterable<VoiceClientState>,
): number {
  let total = 0;
  for (const state of states) {
    if (
      state.acceptingRequests &&
      state.recognitionEnabled &&
      getVoiceClientCapabilities(state).turnModeEnabled
    ) {
      total += 1;
    }
  }
  return total;
}

export function getDirectTtsEnabledClientCount(states: Iterable<VoiceClientState>): number {
  let total = 0;
  for (const state of states) {
    if (getVoiceClientCapabilities(state).directTtsEnabled) {
      total += 1;
    }
  }
  return total;
}

export function getDirectSttEnabledClientCount(states: Iterable<VoiceClientState>): number {
  let total = 0;
  for (const state of states) {
    if (getVoiceClientCapabilities(state).directSttEnabled) {
      total += 1;
    }
  }
  return total;
}
