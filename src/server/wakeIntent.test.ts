import { describe, expect, test } from "vitest";

import { executeWakeIntent, parseWakeIntent, stripWakePrefix } from "./wakeIntent";

describe("wake intent parser", () => {
  test("strips common wake prefixes", () => {
    expect(stripWakePrefix("hey agent what is the date")).toBe("what is the date");
    expect(stripWakePrefix("agent echo hello")).toBe("echo hello");
  });

  test("maps date phrasing variants to date action", () => {
    const first = parseWakeIntent("Hey agent what is the date");
    const second = parseWakeIntent("Agent tell me the date");
    const third = parseWakeIntent("agent what time is it");

    expect(first.action).toBe("date");
    expect(second.action).toBe("date");
    expect(third.action).toBe("date");
  });

  test("maps echo verbs and captures tail text", () => {
    const echoOne = parseWakeIntent("agent echo hello world");
    const echoTwo = parseWakeIntent("agent say start a termstation session with codex");

    expect(echoOne.action).toBe("echo");
    expect(echoOne.args.text).toBe("hello world");

    expect(echoTwo.action).toBe("echo");
    expect(echoTwo.args.text).toBe("start a termstation session with codex");
  });

  test("returns clarify when echo verb has no tail", () => {
    const result = parseWakeIntent("agent echo");
    expect(result.action).toBe("clarify");
  });

  test("maps assistant mentions and captures tail text", () => {
    const first = parseWakeIntent("hey agent tell my assistant summarize this changelog");
    const second = parseWakeIntent("agent assistant check the latest logs");
    const third = parseWakeIntent("hey assistant check the latest logs");

    expect(first.action).toBe("assistant");
    expect(first.args.text).toBe("summarize this changelog");

    expect(second.action).toBe("assistant");
    expect(second.args.text).toBe("check the latest logs");

    expect(third.action).toBe("assistant");
    expect(third.args.text).toBe("check the latest logs");
  });

  test("returns clarify when assistant mention has no tail", () => {
    const result = parseWakeIntent("agent tell my assistant");
    expect(result.action).toBe("clarify");
  });
});

describe("wake intent execution", () => {
  test("executes echo intent without shelling out", async () => {
    const intent = parseWakeIntent("agent echo hello there");
    const execution = await executeWakeIntent(intent);

    expect(execution.executed).toBe(true);
    expect(execution.output).toBe("hello there");
  });

  test("does not execute clarify intents", async () => {
    const intent = parseWakeIntent("agent");
    const execution = await executeWakeIntent(intent);

    expect(execution.executed).toBe(false);
    expect(execution.error).toBe("clarify");
  });

  test("executes assistant intent via ssh srv with fixed model/session and -p prompt", async () => {
    const intent = parseWakeIntent("agent tell my assistant summarize this changelog");
    const calls: Array<{
      file: string;
      args: string[];
      options?: {
        cwd?: string;
        timeout?: number;
        maxBuffer?: number;
      };
    }> = [];

    const execution = await executeWakeIntent(intent, {
      execRunner: async (file, args, options) => {
        calls.push({ file, args, options });
        return {
          stdout: "assistant-ok\n",
          stderr: "",
        };
      },
    });

    expect(execution.executed).toBe(true);
    expect(execution.output).toBe("assistant-ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "ssh",
      args: [
        "-n",
        "srv",
        "cd ~ && pi --model 'openai-codex/gpt-5.3-codex:minimal' --session 'assistant.jsonl' -p 'summarize this changelog'",
      ],
      options: {
        timeout: 120000,
      },
    });
  });

  test("logs assistant spawn and completion events", async () => {
    const intent = parseWakeIntent("hey assistant summarize this changelog");
    const infoLogs: Array<{ event: unknown; details: unknown }> = [];
    const errorLogs: Array<{ event: unknown; details: unknown }> = [];

    const execution = await executeWakeIntent(intent, {
      logger: {
        info: (event, details) => {
          infoLogs.push({ event, details });
        },
        error: (event, details) => {
          errorLogs.push({ event, details });
        },
      },
      execRunner: async () => ({
        stdout: "ok",
        stderr: "",
      }),
    });

    expect(execution.executed).toBe(true);
    expect(errorLogs).toHaveLength(0);
    expect(infoLogs).toHaveLength(2);
    expect(infoLogs[0].event).toBe("wake_intent_assistant_started");
    expect(infoLogs[1].event).toBe("wake_intent_assistant_exited");
  });
});
