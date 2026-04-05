import { describe, expect, test } from "vitest";

import { buildPythonDaemonCommand } from "./daemonCommand";

describe("buildPythonDaemonCommand", () => {
  test("builds a local python command when ssh is not configured", () => {
    const command = buildPythonDaemonCommand({
      pythonBin: "python3",
      scriptPath: "scripts/kokoro_daemon.py",
      pythonArgs: ["--model", "hexgrad/Kokoro-82M"],
    });

    expect(command).toEqual({
      command: "python3",
      args: ["-u", "scripts/kokoro_daemon.py", "--model", "hexgrad/Kokoro-82M"],
    });
  });

  test("builds an ssh-wrapped python command when ssh is configured", () => {
    const command = buildPythonDaemonCommand({
      pythonBin: "/opt/venv/bin/python",
      scriptPath: "/srv/voice/scripts/parakeet_daemon.py",
      pythonArgs: ["--quiet", "--warmup"],
      ssh: {
        target: "voice-gpu",
        port: 2222,
        identityFile: "/home/user/.ssh/voice_gpu",
      },
    });

    expect(command).toEqual({
      command: "ssh",
      args: [
        "-T",
        "-p",
        "2222",
        "-i",
        "/home/user/.ssh/voice_gpu",
        "voice-gpu",
        "/opt/venv/bin/python",
        "-u",
        "/srv/voice/scripts/parakeet_daemon.py",
        "--quiet",
        "--warmup",
      ],
    });
  });
});
