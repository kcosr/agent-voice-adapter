#!/usr/bin/env node
/**
 * Validate or upload manually built desktop release assets.
 *
 * Usage:
 *   node scripts/release-assets.mjs verify v0.2.0 release-assets/v0.2.0/*
 *   node scripts/release-assets.mjs upload v0.2.0 release-assets/v0.2.0/*
 *   node scripts/release-assets.mjs upload --clobber v0.2.0 release-assets/v0.2.0/*
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";

const PACKAGE_NAME = "agent-voice-adapter";
const REPO = process.env.GITHUB_REPOSITORY ?? "kcosr/agent-voice-adapter";
const VERSION_OR_TAG = /^v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/;
const WINDOWS_ASSET =
  /^agent-voice-adapter-(.+)-windows-(x64|arm64)\.(exe|msi|zip|msix|appinstaller)$/;
const USAGE = [
  "Usage:",
  "  node scripts/release-assets.mjs verify <vX.Y.Z> <asset...>",
  "  node scripts/release-assets.mjs upload [--clobber] <vX.Y.Z> <asset...>",
  "",
  "Required assets:",
  "  agent-voice-adapter-X.Y.Z-macos-arm64.dmg",
  "  agent-voice-adapter-X.Y.Z-windows-x64.<exe|msi|zip|msix|appinstaller>",
].join("\n");

const rawArgs = process.argv.slice(2);
const command = rawArgs.shift();
const clobberIndex = rawArgs.indexOf("--clobber");
const clobber = clobberIndex !== -1;
if (clobber) {
  rawArgs.splice(clobberIndex, 1);
}

if (!command || !["verify", "upload"].includes(command) || rawArgs.length < 2) {
  console.error(USAGE);
  process.exit(1);
}

if (clobber && command !== "upload") {
  console.error("Error: --clobber is only valid with upload.");
  process.exit(1);
}

const tagInput = rawArgs.shift();
const tag = normalizeTag(tagInput);
const version = tag.slice(1);
const assetPaths = rawArgs;
const assets = validateAssets(assetPaths, version);

console.log(`Release tag: ${tag}`);
console.log(`Repository: ${REPO}`);
for (const asset of assets) {
  console.log(`  ${asset.platform}: ${asset.path}`);
}

if (command === "verify") {
  console.log("Release assets verified.");
  process.exit(0);
}

runFile("gh", ["release", "view", tag, "--repo", REPO], { silent: true });
const uploadArgs = ["release", "upload", tag, ...assets.map((asset) => asset.path), "--repo", REPO];
if (clobber) {
  uploadArgs.push("--clobber");
}
runFile("gh", uploadArgs);
console.log("Release assets uploaded.");

function normalizeTag(value) {
  const match = value?.match(VERSION_OR_TAG);
  if (!match) {
    console.error(`Error: release tag must look like vX.Y.Z, got ${value ?? "(missing)"}.`);
    process.exit(1);
  }
  return `v${match[1]}`;
}

function validateAssets(paths, expectedVersion) {
  const results = [];
  let hasMacArmDmg = false;
  let hasWindowsPackage = false;
  const seenNames = new Set();

  for (const assetPath of paths) {
    if (!existsSync(assetPath)) {
      fail(`asset does not exist: ${assetPath}`);
    }
    const stats = statSync(assetPath);
    if (!stats.isFile()) {
      fail(`asset is not a file: ${assetPath}`);
    }
    if (stats.size === 0) {
      fail(`asset is empty: ${assetPath}`);
    }

    const name = basename(assetPath);
    if (seenNames.has(name)) {
      fail(`duplicate asset filename: ${name}`);
    }
    seenNames.add(name);

    const macName = `${PACKAGE_NAME}-${expectedVersion}-macos-arm64.dmg`;
    if (name === macName) {
      hasMacArmDmg = true;
      results.push({ path: assetPath, platform: "macos-arm64" });
      continue;
    }

    const windowsMatch = name.match(WINDOWS_ASSET);
    if (windowsMatch) {
      const assetVersion = windowsMatch[1];
      if (assetVersion !== expectedVersion) {
        fail(`Windows asset version must be ${expectedVersion}: ${name}`);
      }
      hasWindowsPackage = true;
      results.push({ path: assetPath, platform: `windows-${windowsMatch[2]}` });
      continue;
    }

    fail(`unexpected asset filename: ${name}`);
  }

  if (!hasMacArmDmg) {
    fail(`missing ${PACKAGE_NAME}-${expectedVersion}-macos-arm64.dmg`);
  }
  if (!hasWindowsPackage) {
    fail(`missing a Windows desktop package for version ${expectedVersion}`);
  }

  return results;
}

function runFile(commandName, args, options = {}) {
  console.log(`$ ${[commandName, ...args.map((arg) => JSON.stringify(arg))].join(" ")}`);
  try {
    return execFileSync(commandName, args, {
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : "inherit",
    });
  } catch {
    console.error(`Command failed: ${commandName} ${args.join(" ")}`);
    process.exit(1);
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
