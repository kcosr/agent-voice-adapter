---
name: agent-voice-adapter-cli
description: Use this skill when you need to communicate with the user through the local agent-voice-adapter-cli.js CLI, including interactive listen turns, one-shot mode, and response parsing.
---

# Voice Adapter CLI Skill

Use this skill for voice interactions through:

```bash
agent-voice-adapter-cli.js
```

## Purpose

- Send spoken prompts to the user through the voice adapter server.
- Capture the user's spoken response as text when needed.
- Continue multi-turn voice conversations over the CLI channel.

## Prerequisites

- Set `AGENT_VOICE_ADAPTER_API_URL` to the adapter server URL.
- CLI available as `agent-voice-adapter-cli.js`.

## Core Commands

Interactive turn (default: wait for listen result):

```bash
agent-voice-adapter-cli.js "Are you ready to test this change?"
```

One-shot turn (no listen wait):

```bash
agent-voice-adapter-cli.js --no-wait "Done."
```

One-shot acknowledgment before work (no listen wait):

```bash
agent-voice-adapter-cli.js --no-wait "reviewing changes"
```

Timeout tuning:

```bash
agent-voice-adapter-cli.js \
  --listen-timeout-ms 300000 \
  --listen-start-timeout-ms 300000 \
  --listen-completion-timeout-ms 300000 \
  "Can you repeat that?"
```

Listen model override:

```bash
agent-voice-adapter-cli.js \
  --listen-model nvidia/parakeet-ctc-0.6b \
  "Tell me what you want to do."
```

Quick-action prompt (recommended for simple choices):

```bash
agent-voice-adapter-cli.js \
  --quick-reply "Yes" \
  --quick-reply "No" \
  --quick-reply "Wait::Please wait." \
  "Do you want me to proceed?"
```

Prompt with inline attachment:

```bash
agent-voice-adapter-cli.js \
  --attachment "Checklist:\n- one\n- two" \
  "I attached the checklist. Should I apply it?"
```

Prompt with file attachment:

```bash
agent-voice-adapter-cli.js \
  --attachment-file ./notes.md \
  "Please review the attached notes."
```

Prompt with file attachment and explicit MIME:

```bash
agent-voice-adapter-cli.js \
  --attachment-file ./notes.md \
  --attachment-content-type text/plain \
  "Use this file as plain text."
```

One-shot prompt with quick actions (no listen wait):

```bash
agent-voice-adapter-cli.js \
  --no-wait \
  --quick-reply "Proceed" \
  --quick-reply "Wait" \
  "I can continue now or wait. Tap one."
```

## Quick-Reply Guidance

- Prefer quick replies whenever the user can answer with a small fixed set of options (for example `Yes/No`, `Proceed/Wait`, `Option A/B/C`).
- Keep quick-reply options short and unambiguous; avoid long labels.
- Use normal interactive listen mode for open-ended answers.
- Quick replies are supported in both wait and no-wait turns.

## Attachment Guidance

- Use `--attachment <text>` for short inline attachment content.
- Use `--attachment-file <path>` for file-backed attachment content.
- `--attachment` and `--attachment-file` are mutually exclusive.
- `--attachment-content-type <mime-type>` requires `--attachment` or `--attachment-file`.
- For `.md` file attachments, the CLI infers `text/markdown` unless content type is explicitly overridden.

## Response Handling

Default CLI output is brief (recommended for normal conversation loops):

- one-shot (`--no-wait`): parse `turnId`.
- interactive wait: parse `turnId`, `text`, and optional `durationMs` / `timeoutFallbackUsed`.

Use `--verbose` when you need full server response fields, including:

- `accepted`
- `listen.success`
- `listen.text`
- `listen.error` (when unsuccessful)
- `listen.providerId` and `listen.modelId`

Quick-reply answer detection:

- treat `listen.providerId === "quick_reply"` as a quick-reply-selected answer path.
- quick-reply selections still populate `listen.text` with the resolved reply text.

## Conversation Loop Pattern

1. Send a context-aware prompt with default interactive mode. Prefer continuing the current thread (for example, `Are you ready to test the media resume fix?`) instead of repeatedly using generic prompts.
2. Parse `listen.text`.
3. Before starting any substantive work (code edits, test runs, repo exploration, repo reads), send a very brief acknowledgment first with `--no-wait` (for example: `reviewing changes`, `updating docs`, `running tests`).
4. For normal back-and-forth voice conversation, skip the extra `--no-wait` acknowledgment and just send the next interactive prompt/response.
5. Perform the requested action.
6. Send the next spoken response through the CLI.
7. Repeat until the user explicitly ends the session.

## Error Handling

If listen fails or is unclear, prompt again via CLI:

```bash
agent-voice-adapter-cli.js "I didn't catch that. Could you repeat it?"
```

If the request fails (409/5xx), check service/client connectivity and retry.

## Runtime Notes

- Prefer running CLI commands with a shell/exec timeout around 300 seconds for blocking turns.
- Keep prompts short and direct for better voice UX.
- Keep prompts contextual to the active task; use a generic fallback like `What would you like to do next?` only when there is no clear conversational context.
- Always send a `--no-wait` acknowledgment immediately before substantive work; skip it for routine conversational replies.
- Keep acknowledgments minimal (typically 2-4 words) and action-oriented.
- Do not use filler confirmations like `Understood`, `Got it`, or full plan restatements in these no-wait acknowledgments.
