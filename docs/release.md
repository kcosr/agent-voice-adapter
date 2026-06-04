# Release Runbook

This repository releases the server, web client, CLI, Android source, and
manually built desktop packages from GitHub releases.

Release automation follows the same shape as `t3code-threads`: create the
GitHub release from a clean `main` branch first, then attach platform binaries
after those packages have been built and staged locally.

## Preflight

1. Confirm `CHANGELOG.md` has user-facing notes under `## [Unreleased]`.
2. Confirm the branch is clean and current:

   ```bash
   git checkout main
   git pull --ff-only
   npm install
   npm run check
   ```

3. Confirm local release tools are available:

   ```bash
   node --version
   npm --version
   gh auth status --hostname github.com
   ```

## Create the GitHub release

```bash
npm run release -- patch    # Bug fixes
npm run release -- minor    # New features
npm run release -- major    # Breaking changes
npm run release -- 0.2.3    # Explicit version
```

The release script must run from a clean `main` branch. It bumps
`package.json` and `package-lock.json`, runs local checks, converts
`## [Unreleased]` into a dated version section, commits, tags, pushes, creates
a GitHub prerelease, then opens a new `## [Unreleased]` section for the next
cycle.

Use `npm run release -- current` only when `package.json` is already set to the
version being released and `CHANGELOG.md` does not already contain that version
section.

## Stage desktop assets

Desktop packages are built outside this repository and provided manually. Stage
them locally under a versioned directory that is ignored by git:

```text
release-assets/v0.2.0/
  agent-voice-adapter-0.2.0-macos-arm64.dmg
  agent-voice-adapter-0.2.0-windows-x64.exe
```

The macOS asset must be an Apple silicon DMG named:

```text
agent-voice-adapter-X.Y.Z-macos-arm64.dmg
```

Windows desktop packages can use any of these extensions:

```text
agent-voice-adapter-X.Y.Z-windows-x64.exe
agent-voice-adapter-X.Y.Z-windows-x64.msi
agent-voice-adapter-X.Y.Z-windows-x64.zip
agent-voice-adapter-X.Y.Z-windows-x64.msix
agent-voice-adapter-X.Y.Z-windows-x64.appinstaller
```

Use `windows-arm64` instead of `windows-x64` only for a Windows ARM package.

## Verify and upload assets

Validate filenames, non-empty files, and required platforms before uploading:

```bash
npm run release:assets -- verify v0.2.0 release-assets/v0.2.0/*
```

Attach the files to the existing GitHub release:

```bash
npm run release:assets -- upload v0.2.0 release-assets/v0.2.0/*
```

If replacing a bad upload, pass `--clobber`:

```bash
npm run release:assets -- upload --clobber v0.2.0 release-assets/v0.2.0/*
```

## Manual checklist

- The GitHub release exists for tag `vX.Y.Z`.
- The release notes match the `CHANGELOG.md` version section.
- The macOS ARM DMG opens locally and contains the expected desktop app.
- The Windows package installs or launches on a Windows test machine.
- `npm run release:assets -- verify vX.Y.Z <asset...>` passes.
- The GitHub release assets include the macOS ARM DMG and at least one Windows
  desktop package.
- Mark the GitHub prerelease as a full release when the attached desktop assets
  have been smoke-tested.
