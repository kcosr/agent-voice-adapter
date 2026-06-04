import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { PocketTtsDaemonClient, shutdownPocketTtsDaemonProcesses } from "./pocketTtsDaemonClient";

function findPythonBin(): string | null {
  const result = spawnSync("bash", ["-lc", "command -v python3"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

const PYTHON_BIN = findPythonBin();

const BASE_SCRIPT = `
import base64
import json
import sys
import threading
import time

active = None
active_lock = threading.Lock()

def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

def synth(message):
    global active
    request_id = message["request_id"]
    emit({
        "type": "started",
        "request_id": request_id,
        "sample_rate": 16000,
        "model": message.get("model"),
        "voice": message.get("voice"),
        "language": message.get("language"),
    })
    for index in range(20):
        with active_lock:
            canceled = active is not None and active.get("canceled") is True
        if canceled:
            emit({"type": "canceled", "request_id": request_id})
            with active_lock:
                active = None
            return
        emit({
            "type": "audio",
            "request_id": request_id,
            "chunk_base64": base64.b64encode(f"chunk-{index}".encode()).decode("ascii"),
        })
        time.sleep(0.02)
    emit({"type": "done", "request_id": request_id})
    with active_lock:
        active = None

emit({"type": "ready"})
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "synthesize":
        with active_lock:
            active = {"request_id": message["request_id"], "canceled": False}
        threading.Thread(target=synth, args=(message,), daemon=True).start()
    elif message.get("type") == "cancel":
        with active_lock:
            if active is not None and active.get("request_id") == message.get("request_id"):
                active["canceled"] = True
`;

const ERROR_SCRIPT = `
import json
import sys

def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

emit({"type": "ready"})
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "synthesize":
        emit({"type": "error", "request_id": message["request_id"], "error": "synthetic failure"})
`;

const IGNORE_CANCEL_SCRIPT = `
import base64
import json
import sys
import threading
import time

def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

def synth(message):
    request_id = message["request_id"]
    emit({"type": "started", "request_id": request_id, "sample_rate": 16000})
    while True:
        emit({
            "type": "audio",
            "request_id": request_id,
            "chunk_base64": base64.b64encode(b"ignored").decode("ascii"),
        })
        time.sleep(0.02)

emit({"type": "ready"})
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "synthesize":
        threading.Thread(target=synth, args=(message,), daemon=True).start()
    elif message.get("type") == "cancel":
        pass
`;

function createTempScript(contents: string): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pocket-daemon-test-"));
  const scriptPath = path.join(dir, "daemon.py");
  writeFileSync(scriptPath, contents, "utf8");
  return { dir, scriptPath };
}

describe.skipIf(!PYTHON_BIN)("PocketTtsDaemonClient", () => {
  const pythonBin = PYTHON_BIN ?? "python3";
  const tempDirs: string[] = [];

  afterEach(() => {
    shutdownPocketTtsDaemonProcesses();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("streams PCM chunks and reports output sample rate", async () => {
    const { dir, scriptPath } = createTempScript(BASE_SCRIPT);
    tempDirs.push(dir);
    const chunks: Buffer[] = [];
    const sampleRates: number[] = [];
    const errors: unknown[] = [];
    const client = new PocketTtsDaemonClient({
      pythonBin,
      scriptPath,
      voiceId: "alba",
      modelId: "english",
      language: "english",
      device: "cpu",
      quantize: false,
      maxTokensPerChunk: 50,
      hardCancelTimeoutMs: 500,
      abortSignal: new AbortController().signal,
      onAudioChunk: (pcmBytes) => chunks.push(Buffer.from(pcmBytes)),
      onOutputSampleRate: (sampleRate) => sampleRates.push(sampleRate),
      onError: (error) => errors.push(error),
      log: () => {},
    });

    await client.sendText("hello");
    await client.finish();

    expect(sampleRates).toEqual([16000]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].toString("utf8")).toBe("chunk-0");
    expect(errors).toEqual([]);
  });

  test("propagates daemon errors", async () => {
    const { dir, scriptPath } = createTempScript(ERROR_SCRIPT);
    tempDirs.push(dir);
    const errors: unknown[] = [];
    const client = new PocketTtsDaemonClient({
      pythonBin,
      scriptPath,
      voiceId: "alba",
      modelId: "english",
      language: "english",
      device: "cpu",
      quantize: false,
      maxTokensPerChunk: 50,
      hardCancelTimeoutMs: 500,
      abortSignal: new AbortController().signal,
      onAudioChunk: () => {},
      onError: (error) => errors.push(error),
      log: () => {},
    });

    await client.sendText("hello");
    await expect(client.finish()).rejects.toThrow(/synthetic failure/);
    expect(errors).toHaveLength(1);
  });

  test("sends cancel command and stops forwarding audio after cancellation", async () => {
    const { dir, scriptPath } = createTempScript(BASE_SCRIPT);
    tempDirs.push(dir);
    const controller = new AbortController();
    const chunks: Buffer[] = [];
    const client = new PocketTtsDaemonClient({
      pythonBin,
      scriptPath,
      voiceId: "alba",
      modelId: "english",
      language: "english",
      device: "cpu",
      quantize: false,
      maxTokensPerChunk: 50,
      hardCancelTimeoutMs: 500,
      abortSignal: controller.signal,
      onAudioChunk: (pcmBytes) => {
        chunks.push(Buffer.from(pcmBytes));
        if (chunks.length === 1) {
          controller.abort("test_cancel");
        }
      },
      onError: () => {},
      log: () => {},
    });

    await client.sendText("hello");
    await expect(client.finish()).rejects.toThrow(/canceled/);
    const countAfterFinish = chunks.length;

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(countAfterFinish).toBe(1);
    expect(chunks.length).toBe(countAfterFinish);
  });

  test("kills the daemon when a cancel command is ignored", async () => {
    const { dir, scriptPath } = createTempScript(IGNORE_CANCEL_SCRIPT);
    tempDirs.push(dir);
    const controller = new AbortController();
    const chunks: Buffer[] = [];
    const logs: unknown[][] = [];
    const client = new PocketTtsDaemonClient({
      pythonBin,
      scriptPath,
      voiceId: "alba",
      modelId: "english",
      language: "english",
      device: "cpu",
      quantize: false,
      maxTokensPerChunk: 50,
      hardCancelTimeoutMs: 50,
      abortSignal: controller.signal,
      onAudioChunk: (pcmBytes) => {
        chunks.push(Buffer.from(pcmBytes));
        if (chunks.length === 1) {
          controller.abort("test_hard_cancel");
        }
      },
      onError: () => {},
      log: (...args) => logs.push(args),
    });

    await client.sendText("hello");
    await expect(client.finish()).rejects.toThrow(/cancel timeout/);

    expect(chunks).toHaveLength(1);
    expect(logs.some(([message]) => message === "Pocket TTS daemon hard cancel timeout")).toBe(
      true,
    );
  });
});
