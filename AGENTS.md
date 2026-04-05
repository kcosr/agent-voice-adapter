## Development guidelines

- For any new feature or behavior change, add or update tests and run the relevant test suite before opening a PR.
- For any new feature or behavior change, update documentation appropriately (see README.md and docs/).
- Keep changes scoped and avoid unrelated refactors.

## Changelog

Location: `CHANGELOG.md` (root)

### Format

Use these sections under `## [Unreleased]`:
- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- New entries ALWAYS go under `## [Unreleased]`
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.0.3]`)
- For released versions, omit empty subsections (only keep headings that contain entries)
- Use inline PR links: `([#123](<pr-url>))`

### Attribution

- Internal changes: `Fixed foo bar ([#123](<pr-url>))`
- External contributions: `Added feature X ([#456](<pr-url>) by [@user](https://github.com/user))`

## Releasing

### During Development

When preparing PRs for main, open the PR first to get the PR number, then update `CHANGELOG.md` under `## [Unreleased]` with that PR number and push a follow-up commit.

### When Ready to Release

1. Checkout and update main:
   ```bash
   git checkout main && git pull
   ```
2. Verify `## [Unreleased]` in `CHANGELOG.md` includes all changes.
3. Run the release script:
   ```bash
   node scripts/release.mjs patch
   node scripts/release.mjs minor
   node scripts/release.mjs major
   ```

Notes:
- Requires the `gh` CLI and an authenticated GitHub session.
- Script expects a clean working tree, bumps package versions, updates `CHANGELOG.md`, tags `vX.Y.Z`, pushes, and creates a prerelease.
- `scripts/bump-version.mjs` keeps all `package.json` versions and `package-lock.json` in sync.

## Android Debugging Notes

- Wireless ADB from Linux is supported via CLI only (no GUI required):
  1. Phone: `Developer options` -> `Wireless debugging` -> `Pair device with pairing code`
  2. Linux: `adb pair <PHONE_IP>:<PAIR_PORT>` (enter six-digit code)
  3. Linux: `adb connect <PHONE_IP>:<DEBUG_PORT>`
  4. Verify: `adb devices -l`
- For cue/media troubleshooting, capture filtered logs:
  - `adb logcat -v time | rg "VoiceAdapterService|ExternalMediaController|cue_state|media_ctrl|AudioTrack|AudioManager"`
- Full runbook: `docs/android-logcat-setup.md`

## Local Deployment Sync

> **Note for AI agents**: the specific paths and service unit below describe the maintainer's development environment. If `whoami` / `$USER` is not `kevin`, treat this section as illustrative only — adapt the paths, unit name, and deploy layout to the current user's environment, or skip the deploy steps entirely if the current task doesn't require them.

- Development source of truth is your worktree checkout.
- If you run the systemd service from a separate deploy checkout (for example to keep the dev tree free to rebase while the service runs a pinned copy), the service's `WorkingDirectory` should point at that deploy checkout and the unit name is typically `agent-voice-adapter.service`.
- For server-side changes to take effect in the running service:
  1. Sync changed files from the dev worktree into the deploy checkout (e.g. `rsync -a --delete --exclude '.git/' --exclude 'node_modules/' --exclude 'agent-voice-adapter.json' <src>/ <deploy>/`).
  2. Build in the service checkout (`npm run build`).
  3. Restart service (`sudo systemctl restart agent-voice-adapter.service`).
  4. Verify (`sudo systemctl is-active agent-voice-adapter.service` and `/api/status`).
- Android client deploy runs from the dev worktree via `./android/gradlew -p android :app:installDebug`.
