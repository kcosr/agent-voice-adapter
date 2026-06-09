#!/usr/bin/env node
/**
 * Release script for agent-voice-adapter.
 *
 * Usage:
 *   node scripts/release.mjs current
 *   node scripts/release.mjs patch
 *   node scripts/release.mjs minor
 *   node scripts/release.mjs major
 *   node scripts/release.mjs 0.2.3
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PACKAGE_NAME = "agent-voice-adapter";
const REPO = process.env.GITHUB_REPOSITORY ?? "kcosr/agent-voice-adapter";
const RELEASE_BRANCH = "main";
const RELEASE_ARG = process.argv[2];
const BUMP_ARGS = new Set(["major", "minor", "patch"]);
const VERSION_ARG = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const packageJsonPath = join(ROOT, "package.json");
const changelogPath = join(ROOT, "CHANGELOG.md");
const notesFile = join(ROOT, ".release-notes-tmp.md");

if (
  !RELEASE_ARG ||
  (!BUMP_ARGS.has(RELEASE_ARG) && RELEASE_ARG !== "current" && !VERSION_ARG.test(RELEASE_ARG))
) {
  console.error("Usage: node scripts/release.mjs <current|major|minor|patch|X.Y.Z>");
  process.exit(1);
}

function run(cmd, options = {}) {
  console.log(`$ ${cmd}`);
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : "inherit",
      cwd: ROOT,
      ...options,
    });
  } catch {
    if (!options.ignoreError) {
      console.error(`Command failed: ${cmd}`);
      process.exit(1);
    }
    return null;
  }
}

function runFile(command, args, options = {}) {
  console.log(`$ ${[command, ...args.map((arg) => JSON.stringify(arg))].join(" ")}`);
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : "inherit",
      cwd: ROOT,
      ...options,
    });
  } catch {
    if (!options.ignoreError) {
      console.error(`Command failed: ${command} ${args.join(" ")}`);
      process.exit(1);
    }
    return null;
  }
}

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf-8"));
}

function getVersion() {
  const packageJson = readPackageJson();
  if (packageJson.name !== PACKAGE_NAME) {
    console.error(`Expected package name ${PACKAGE_NAME}, got ${packageJson.name}`);
    process.exit(1);
  }
  if (typeof packageJson.version !== "string" || !VERSION_ARG.test(packageJson.version)) {
    console.error("package.json version must be semantic X.Y.Z");
    process.exit(1);
  }
  return packageJson.version;
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function formatVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

function resolveTargetVersion(currentVersion) {
  if (RELEASE_ARG === "current") {
    return currentVersion;
  }
  if (VERSION_ARG.test(RELEASE_ARG)) {
    return RELEASE_ARG;
  }

  const parts = parseVersion(currentVersion);
  if (!parts) {
    console.error(`Current package.json version "${currentVersion}" is not valid semver`);
    process.exit(1);
  }
  if (RELEASE_ARG === "patch") {
    parts.patch += 1;
  } else if (RELEASE_ARG === "minor") {
    parts.minor += 1;
    parts.patch = 0;
  } else if (RELEASE_ARG === "major") {
    parts.major += 1;
    parts.minor = 0;
    parts.patch = 0;
  }
  return formatVersion(parts);
}

function ensureCleanMain() {
  const branch = run("git branch --show-current", { silent: true }).trim();
  if (branch !== RELEASE_BRANCH) {
    console.error(
      `Error: releases must be run from ${RELEASE_BRANCH}; current branch is ${branch || "(detached)"}.`,
    );
    process.exit(1);
  }
  const status = run("git status --porcelain", { silent: true });
  if (status?.trim()) {
    console.error("Error: Uncommitted changes detected. Commit or stash first.");
    console.error(status);
    process.exit(1);
  }
}

function ensureTools() {
  run("git --version", { silent: true });
  run("node --version", { silent: true });
  run("npm --version", { silent: true });
  run("gh --version", { silent: true });
  run("gh auth status --hostname github.com", { silent: true });
}

function ensureSyncedMain() {
  runFile(
    "git",
    ["fetch", "origin", `refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`],
    {
      silent: true,
    },
  );
  const local = runFile("git", ["rev-parse", RELEASE_BRANCH], { silent: true }).trim();
  const remote = runFile("git", ["rev-parse", `origin/${RELEASE_BRANCH}`], {
    silent: true,
  }).trim();
  if (local !== remote) {
    console.error(
      `Error: ${RELEASE_BRANCH} must match origin/${RELEASE_BRANCH}. Run git pull --ff-only first.`,
    );
    process.exit(1);
  }
}

function ensureTagAvailable(version) {
  const localTagExists = run(`git rev-parse -q --verify refs/tags/v${version}`, {
    silent: true,
    ignoreError: true,
  });
  if (localTagExists) {
    console.error(`Error: tag v${version} already exists.`);
    process.exit(1);
  }

  const remoteTagExists = run(`git ls-remote --tags origin refs/tags/v${version}`, {
    silent: true,
  });
  if (remoteTagExists?.trim()) {
    console.error(`Error: tag v${version} already exists on origin.`);
    process.exit(1);
  }
}

function readValidatedChangelogForRelease(version) {
  const content = readFileSync(changelogPath, "utf-8");
  if (!content.includes("## [Unreleased]")) {
    console.error("Error: No [Unreleased] section found in CHANGELOG.md");
    process.exit(1);
  }
  if (content.includes(`## [${version}]`)) {
    console.error(`Error: CHANGELOG.md already contains a [${version}] section`);
    process.exit(1);
  }
  const unreleasedMatch = content.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
  if (!unreleasedMatch || !hasReleaseNotes(unreleasedMatch[1])) {
    console.error("Error: CHANGELOG.md has no release notes under [Unreleased]");
    process.exit(1);
  }
  return content;
}

function hasReleaseNotes(section) {
  const normalized = section
    .replace(/### [^\n]+\n/g, "")
    .replace(/_No unreleased changes\._/g, "")
    .trim();
  return normalized.length > 0;
}

function updateChangelogForRelease(version) {
  const date = new Date().toISOString().split("T")[0];
  let content = readValidatedChangelogForRelease(version);
  content = content.replace(/## \[Unreleased\]/, `## [${version}] - ${date}`);
  content = stripEmptyReleaseSections(content, version);
  writeFileSync(changelogPath, content, "utf-8");
}

function stripEmptyReleaseSections(content, version) {
  const versionEscaped = version.replace(/\./g, "\\.");
  const sectionRegex = new RegExp(
    `(## \\[${versionEscaped}\\][^\\n]*\\n)([\\s\\S]*?)(?=\\n## \\[|$)`,
  );
  const match = content.match(sectionRegex);
  if (!match) {
    return content;
  }

  const heading = match[1];
  let body = match[2];
  body = body.replace(/### [^\n]+\n(?:\s*\n)*(?=###|##|$)/g, "");
  body = body.replace(/\n{3,}/g, "\n\n");
  const trimmed = body.trimEnd();
  const rebuilt = `${heading}${trimmed ? trimmed : ""}`.trimEnd();

  return content.replace(sectionRegex, `${rebuilt}\n\n`);
}

function extractReleaseNotes(version) {
  const content = readFileSync(changelogPath, "utf-8");
  const versionEscaped = version.replace(/\./g, "\\.");
  const regex = new RegExp(`## \\[${versionEscaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
  const match = content.match(regex);
  if (!match) {
    console.error(`Error: Could not extract release notes for v${version}`);
    process.exit(1);
  }
  return match[1].trim();
}

function addUnreleasedSection() {
  let content = readFileSync(changelogPath, "utf-8");
  const unreleasedSection = [
    "## [Unreleased]",
    "",
    "### Breaking Changes",
    "",
    "### Added",
    "",
    "### Changed",
    "",
    "### Fixed",
    "",
    "### Removed",
    "",
    "",
  ].join("\n");

  const original = content;
  content = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);
  if (content === original) {
    console.error("Error: Could not add [Unreleased] section to CHANGELOG.md");
    process.exit(1);
  }
  writeFileSync(changelogPath, content, "utf-8");
}

function stageExisting(paths) {
  const existing = paths.filter((relativePath) => existsSync(join(ROOT, relativePath)));
  if (existing.length > 0) {
    runFile("git", ["add", ...existing]);
  }
}

console.log("\n=== Release Script ===\n");

const currentVersion = getVersion();

ensureCleanMain();
ensureTools();
ensureSyncedMain();

const version = resolveTargetVersion(currentVersion);
ensureTagAvailable(version);
readValidatedChangelogForRelease(version);

if (version !== currentVersion) {
  runFile("node", ["scripts/bump-version.mjs", version]);
}

run("npm run check");
updateChangelogForRelease(version);

stageExisting(["CHANGELOG.md", "package.json", "package-lock.json"]);
runFile("git", ["commit", "-m", `Release v${version}`]);
runFile("git", ["tag", `v${version}`]);
runFile("git", ["push", "--atomic", "origin", RELEASE_BRANCH, `v${version}`]);

const releaseNotes = extractReleaseNotes(version);
writeFileSync(notesFile, releaseNotes, "utf-8");
try {
  runFile("gh", [
    "release",
    "create",
    `v${version}`,
    "--repo",
    REPO,
    "--prerelease",
    "--title",
    `v${version}`,
    "--notes-file",
    notesFile,
  ]);
} finally {
  rmSync(notesFile, { force: true });
}

addUnreleasedSection();
stageExisting(["CHANGELOG.md"]);
runFile("git", ["commit", "-m", "Open changelog for next cycle"]);
runFile("git", ["push", "origin", RELEASE_BRANCH]);

console.log(`\n=== Released v${version} ===`);
console.log(`https://github.com/${REPO}/releases/tag/v${version}`);
console.log("\nAttach desktop assets after manual package builds:");
console.log(`npm run release:assets -- verify v${version} release-assets/v${version}/*`);
console.log(`npm run release:assets -- upload v${version} release-assets/v${version}/*`);
