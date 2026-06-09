# Changelog

## [Unreleased]

### Added

- Added a `pocket_tts` TTS provider backed by a cancellable stdio daemon for local or SSH-hosted Pocket TTS.

### Fixed

- Constrained Pocket TTS request model/voice overrides to safe built-in identifiers, fixed queued synthesis ordering during daemon startup, and preserved queued Pocket requests across hard-cancel daemon restarts.

## [0.1.0] - 2026-04-04

- Initial release.
