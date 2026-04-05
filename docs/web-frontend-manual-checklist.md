# Web Frontend Manual Validation Checklist

Use this checklist before shipping web frontend changes.

## Session Dispatch

1. Open `Agent Sessions` and confirm active sessions load.
2. Filter by workspace and by title; confirm list updates in real time.
3. Select a row; verify selection outline updates.
4. Confirm `Make Active Agent` is disabled with no selection.
5. Confirm `Make Active Agent` is disabled when selected row is already active.
6. Enter message text and send to selected session.
7. Confirm modal closes on success and a local user bubble is appended.
8. Click a row `Voice` button and confirm modal closes, mic capture starts, and recognized text is sent to that row's session.
9. Click `Voice to Active Agent` and confirm voice capture starts for the saved active target.
10. Confirm the chat header shows a `Global` filter chip plus chips for the active or seen linked sessions.
11. Click a linked-session chip and confirm only matching session bubbles remain visible; click `Global` and confirm the full log returns.

## Active Bubble Actions

1. Start a `listen=true` turn.
2. During TTS, confirm active bubble is outlined.
3. Tap active bubble during TTS; confirm `Stop TTS` request is sent and the bubble does not enter cancelable recognition state until local mic capture actually starts.
4. During recognition, tap active bubble; confirm cancel request is sent.
5. Long-press active bubble and confirm both actions are visible.
6. Start `Voice to Active Agent` or row-level `Voice`; once listening is active, tap that client-started capture bubble and confirm cancel request is sent.

## Layout and Usability

1. Confirm `Show Settings` / `Hide Settings` collapses and persists across reload.
2. Confirm status chips remain visible and readable while chat scrolls.
3. Confirm session modal list scrolls independently on narrow/mobile viewport.
4. Toggle `Theme: Light` / `Theme: Dark` and confirm the choice persists across reload without reverting to the default palette.
5. On narrow/mobile width, confirm the sidebar collapses to a header with `Menu`, and that controls/status only appear after opening that menu.

## Attachment Preview

1. Submit a turn with `attachment.dataBase64` + `attachment.contentType`; confirm bubble shows an attachment section with file/type metadata.
2. Submit a `text/markdown` attachment; confirm bubble preview renders formatted markdown (headings/lists/code/links).
3. Submit a long markdown attachment; confirm preview is visually clamped and `Show more` appears only when content overflows.
4. Click `Show more`; confirm modal opens with full content and preserves attachment metadata row.
5. Submit a non-markdown text attachment (`text/plain`); confirm plain text preview/modal behavior remains intact.
6. Confirm modal closes via `Close`, `Escape`, and backdrop click.
7. Confirm `Copy` places full attachment text on the clipboard.
8. Submit a non-text attachment (for example `application/zip`) and confirm no inline preview/modal path is shown.
9. Submit an inline attachment with no `attachment.fileName`; confirm no `Download` action is shown.
10. Submit a full file attachment (`attachment.fileName` present) and confirm a `Download` action appears in the bubble; click it and confirm the browser downloads decoded bytes with the expected filename.
11. Submit an invalid-base64 file attachment (`attachment.fileName` present); confirm UI shows invalid encoding state and `Download invalid file`, then verify download name uses `<fileName>.invalid`.
12. Submit an HTML attachment (`contentType=text/html`); confirm attachment section shows `Open in browser` plus `Download`, and `Open in browser` opens a new browser tab instead of inline modal rendering.

## Reliability and Recovery

1. Simulate websocket drop; confirm UI reconnects and stale active state clears.
2. Simulate stuck recognition; confirm watchdog/stale-listen recovery cancels turn.
3. Confirm browser console logs include `[agent-voice-adapter:web]` diagnostics.
