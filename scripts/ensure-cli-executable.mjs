#!/usr/bin/env node

import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureExecutable(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`CLI build artifact not found: ${filePath}`);
  }
  chmodSync(filePath, 0o755);
}

if (process.platform !== "win32") {
  const cliFile = path.resolve(__dirname, "../dist/cli/agent-voice-adapter-cli.js");
  ensureExecutable(cliFile);
}
