export interface WakeIntentAccessPolicy {
  allowRemote: boolean;
  sharedSecret?: string;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

export function isWakeIntentRequestAllowed(input: {
  remoteAddress: string | undefined;
  providedSecret?: string;
  policy: WakeIntentAccessPolicy;
}): boolean {
  if (isLoopbackAddress(input.remoteAddress)) {
    return true;
  }

  if (input.policy.allowRemote) {
    return true;
  }

  const expectedSecret = input.policy.sharedSecret?.trim();
  if (!expectedSecret) {
    return false;
  }

  return input.providedSecret?.trim() === expectedSecret;
}
