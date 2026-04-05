#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const cliDistPath = path.join(repoRoot, "dist", "cli", "agent-voice-adapter-cli.js");
const placeholder = "__EMBEDDED_CLI_VERSION__";

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";

if (!version) {
  throw new Error("Unable to read package version for CLI embedding");
}

const cliSource = readFileSync(cliDistPath, "utf8");
if (!cliSource.includes(placeholder)) {
  throw new Error(`CLI placeholder "${placeholder}" not found in ${cliDistPath}`);
}

const updated = cliSource.split(placeholder).join(version);
writeFileSync(cliDistPath, updated, "utf8");
