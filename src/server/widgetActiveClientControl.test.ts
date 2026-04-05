import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readPublicFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../public", relativePath), "utf8");
}

describe("widget active client control", () => {
  test("renders Activate control and active-device status field", () => {
    const html = readPublicFile("index.html");

    expect(html).toContain('id="activate-toggle"');
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="sidebar-menu-toggle"');
    expect(html).toContain('id="sidebar-sections"');
    expect(html).toContain(">Activate<");
    expect(html).toContain('id="activation-status"');
    expect(html).toContain("Active Device");
    expect(html).toContain('id="session-filter-bar"');
  });

  test("wires activate button and activation-state websocket handling", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain(
      'const activateToggleButton = document.getElementById("activate-toggle")',
    );
    expect(appJs).toContain('const themeToggleButton = document.getElementById("theme-toggle")');
    expect(appJs).toContain(
      'const activationStatusEl = document.getElementById("activation-status")',
    );
    expect(appJs).toContain("function setActivationUiState()");
    expect(appJs).toContain("let wantActive = false;");
    expect(appJs).toContain('activateToggleButton.textContent = "Deactivate"');
    expect(appJs).toContain('type: activate ? "client_activate" : "client_deactivate"');
    expect(appJs).toContain("if (wantActive) {");
    expect(appJs).toContain('case "client_activation_state"');
    expect(appJs).toContain("clientActivationState.active");
  });

  test("persists and applies a dark theme mode", () => {
    const html = readPublicFile("index.html");
    const appJs = readPublicFile("app.js");
    const css = readPublicFile("styles.css");

    expect(html).toContain('window.localStorage.getItem("agent-voice-adapter-theme")');
    expect(appJs).toContain('const THEME_STORAGE_KEY = "agent-voice-adapter-theme"');
    expect(appJs).toContain("function getInitialThemeMode()");
    expect(appJs).toContain("function updateThemeToggleState()");
    expect(appJs).toContain("function applyThemeMode(nextThemeMode, options = {})");
    expect(appJs).toContain('document.documentElement.dataset.theme = "dark";');
    expect(appJs).toContain(
      'themeToggleButton.textContent = dark ? "Theme: Dark" : "Theme: Light";',
    );
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--panel: #292c31;");
    expect(css).toContain("--accent: #93a0b0;");
  });

  test("collapses sidebar controls behind a menu in compact layout", () => {
    const appJs = readPublicFile("app.js");
    const css = readPublicFile("styles.css");

    expect(appJs).toContain(
      'const sidebarMenuToggleButton = document.getElementById("sidebar-menu-toggle")',
    );
    expect(appJs).toContain("function isCompactSidebarMode()");
    expect(appJs).toContain("function setMobileSidebarOpen(open)");
    expect(appJs).toContain('sidebarMenuToggleButton.textContent = nextOpen ? "Close" : "Menu";');
    expect(appJs).toContain('sidebarEl.classList.toggle("mobile-open", nextOpen);');
    expect(css).toContain(".sidebar-menu-toggle");
    expect(css).toContain(".sidebar-sections");
    expect(css).toContain(".sidebar.mobile-open .sidebar-sections");
  });

  test("advertises busy-state and turn/direct-media capabilities in websocket state updates", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function sendClientState()");
    expect(appJs).toContain("inTurn: Boolean(turnRuntimeState.activeTurnId)");
    expect(appJs).toContain("turnModeEnabled: true");
    expect(appJs).toContain("directTtsEnabled: false");
    expect(appJs).toContain("directSttEnabled: false");
    expect(appJs).toContain("if (previousInTurn !== nextInTurn) {");
    expect(appJs).toContain("sendClientState();");
  });

  test("only lets the active speech-enabled client play or listen for broadcast turns", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function shouldHandleTurnSpeech()");
    expect(appJs).toContain("function shouldHandleTurnRecognition()");
    expect(appJs).toContain("return clientActivationState.active && speechEnabled;");
    expect(appJs).toContain(
      "return clientActivationState.active && speechEnabled && recognitionEnabled;",
    );
    expect(appJs).toContain("if (shouldHandleTurnSpeech()) {");
    expect(appJs).toContain('setActiveTurnState(turnId, "tts")');
    expect(appJs).toContain("function isCurrentLocalTurn(turnId)");
    expect(appJs).toContain("clientActivationState.active || isCurrentLocalTurn(turnId)");
    expect(appJs).toContain('reason: "inactive_client"');
    expect(appJs).toContain("const shouldStartRecognition =");
    expect(appJs).toContain("entry?.requestRecognition &&");
  });

  test("uses playback drain for listen handoff and no-wait playback-terminal ack", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function shouldAutoStartRecognitionForEntry(entry)");
    expect(appJs).toContain("function maybeStartRecognitionHandoff(turnId, entry)");
    expect(appJs).toContain("const playedTurnAudioById = new Set();");
    expect(appJs).toContain("const pendingPlaybackTerminalAckByTurnId = new Map();");
    expect(appJs).toContain('setActiveTurnState(requestId, "listen_handoff")');
    expect(appJs).toContain("await player.waitForDrain();");
    expect(appJs).toContain('setActiveTurnState(requestId, "listen");');
    expect(appJs).toContain('const result = await postTurnAction("/api/turn/stop-tts", turnId);');
    expect(appJs).toContain("if (!maybeStartRecognitionHandoff(turnId, entry)) {");
    expect(appJs).toContain("if (!pendingRecognitionRequestIds.has(requestId)) {");
    expect(appJs).toContain("recorder.stopSession(requestId);");
    expect(appJs).toContain('type: "turn_playback_terminal"');
    expect(appJs).toContain("function maybeFinalizeNoListenTurn(");
    expect(appJs).toContain("playedTurnAudioById.add(turnId);");
    expect(appJs).toContain("maybeFinalizeNoListenTurn(turnId);");
  });

  test("fires primary bubble actions on pointerup taps with click fallback suppression", () => {
    const appJs = readPublicFile("app.js");
    const turnActionUtils = readPublicFile("turn-action-utils.js");

    expect(appJs).toContain("let suppressClickAfterPointerUp = false;");
    expect(appJs).toContain("const invokePrimaryBubbleAction = () => {");
    expect(appJs).toContain('entry.bubble.addEventListener("pointerup", () => {');
    expect(appJs).toContain("suppressClickAfterPointerUp = invokePrimaryBubbleAction();");
    expect(appJs).toContain("if (suppressClickAfterPointerUp) {");
    expect(turnActionUtils).toContain('if (phase === "tts" || phase === "listen_handoff") {');
    expect(turnActionUtils).toContain('if (phase === "listen") {');
  });

  test("sets pending cancel UI before awaiting turn cancellation response", () => {
    const appJs = readPublicFile("app.js");
    const pendingText = 'setRecognitionText(turnId, "Cancel requested...");';
    const cancelPost = 'await postTurnAction("/api/turn/cancel", turnId);';

    expect(appJs).toContain(pendingText);
    expect(appJs).toContain(cancelPost);
    expect(appJs.indexOf(pendingText)).toBeLessThan(appJs.indexOf(cancelPost));
  });

  test("renders session filter chips for global and linked agent sessions", () => {
    const appJs = readPublicFile("app.js");
    const css = readPublicFile("styles.css");

    expect(appJs).toContain(
      'const SESSION_FILTER_STORAGE_KEY = "agent-voice-adapter-session-filter"',
    );
    expect(appJs).toContain('const GLOBAL_SESSION_FILTER_ID = "";');
    expect(appJs).toContain("function collectSessionFilterOptions()");
    expect(appJs).toContain('label: "Global"');
    expect(appJs).toContain(
      "function applySessionFilter(filterId = sessionFilterState.selectedFilterId)",
    );
    expect(appJs).toContain("function renderSessionFilterTabs()");
    expect(appJs).toContain("bubble.dataset.sessionId = linkedSessionTarget.sessionId;");
    expect(appJs).toContain("sessionDispatchState.activeAgentTarget");
    expect(css).toContain(".session-filter-bar");
    expect(css).toContain(".session-filter-chip");
    expect(css).toContain(".session-filter-chip.active");
  });

  test("binds active bubble tap controls for client-started session voice capture", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function createSessionVoiceCaptureBubble(requestId, sessionRow) {");
    expect(appJs).toContain("bindBubbleTurnInteractions(entry, requestId);");
  });

  test("uses theme-aware recognition text colors instead of hardcoded light-mode values", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain('node.style.color = isError ? "var(--danger)" : "var(--muted)";');
    expect(appJs).not.toContain('node.style.color = isError ? "#9f1239" : "#334155";');
    expect(appJs).toContain('sessionDispatchStatusEl.style.color = isError ? "var(--danger)" : ""');
    expect(appJs).not.toContain('sessionDispatchStatusEl.style.color = isError ? "#9f1239" : ""');
  });

  test("deduplicates recognition cleanup into a teardownRecognition helper", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function teardownRecognition(turnId)");
    expect(appJs).toContain("teardownRecognition(requestId);");
    expect(appJs).toContain("teardownRecognition(turnId);");
  });

  test("removes dead settings panel collapse/expand code", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).not.toContain("SETTINGS_PANEL_OPEN_STORAGE_KEY");
    expect(appJs).not.toContain("getInitialSettingsPanelOpen");
    expect(appJs).not.toContain("persistSettingsPanelOpen");
    expect(appJs).not.toContain("updateSettingsSummaryLabel");
    expect(appJs).not.toContain("settingsSummaryEl");
    expect(appJs).not.toContain("settingsPanelEl");
  });

  test("extracts shared escapeHtml and asNonEmptyString into common modules", () => {
    const htmlUtils = readPublicFile("html-utils.js");
    const stringUtils = readPublicFile("string-utils.js");
    const markdownRenderer = readPublicFile("markdown-renderer.js");
    const syntaxHighlight = readPublicFile("syntax-highlight.js");
    const sessionDispatch = readPublicFile("session-dispatch-utils.js");
    const sessionVoice = readPublicFile("session-voice-utils.js");

    expect(htmlUtils).toContain("export function escapeHtml(value)");
    expect(htmlUtils).toContain("export function escapeHtmlAttribute(value)");
    expect(stringUtils).toContain("export function asNonEmptyString(value)");

    expect(markdownRenderer).toContain(
      'import { escapeHtml, escapeHtmlAttribute } from "./html-utils.js"',
    );
    expect(syntaxHighlight).toContain('import { escapeHtml } from "./html-utils.js"');
    expect(sessionDispatch).toContain('import { asNonEmptyString } from "./string-utils.js"');
    expect(sessionVoice).toContain('import { asNonEmptyString } from "./string-utils.js"');
  });
});
