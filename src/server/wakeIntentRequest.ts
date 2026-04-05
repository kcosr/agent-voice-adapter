import {
  type WakeIntentExecRunner,
  type WakeIntentExecutionResult,
  type WakeIntentLogger,
  type WakeIntentParseResult,
  executeWakeIntent,
  parseWakeIntent,
} from "./wakeIntent";
import type { WakeIntentAccessPolicy } from "./wakeIntentAccess";
import { isWakeIntentRequestAllowed } from "./wakeIntentAccess";

export interface ResolveWakeIntentRequestInput {
  text: unknown;
  remoteAddress?: string;
  providedSecret?: string;
  accessPolicy: WakeIntentAccessPolicy;
  execRunner?: WakeIntentExecRunner;
  logger?: WakeIntentLogger;
}

export interface WakeIntentSuccessResponse {
  accepted: true;
  intent: WakeIntentParseResult;
  execution: WakeIntentExecutionResult;
}

export interface WakeIntentErrorResponse {
  error: string;
}

export async function resolveWakeIntentRequest(
  input: ResolveWakeIntentRequestInput,
): Promise<{ status: number; body: WakeIntentSuccessResponse | WakeIntentErrorResponse }> {
  const allowed = isWakeIntentRequestAllowed({
    remoteAddress: input.remoteAddress,
    providedSecret: input.providedSecret,
    policy: input.accessPolicy,
  });
  if (!allowed) {
    return {
      status: 403,
      body: {
        error:
          "wake-intent denied (remote requests require allowRemote or valid x-wake-intent-secret)",
      },
    };
  }

  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: 'Expected JSON payload: { "text": string }',
      },
    };
  }

  const intent = parseWakeIntent(input.text);
  const execution = await executeWakeIntent(intent, {
    execRunner: input.execRunner,
    logger: input.logger,
  });

  return {
    status: 200,
    body: {
      accepted: true,
      intent,
      execution,
    },
  };
}
