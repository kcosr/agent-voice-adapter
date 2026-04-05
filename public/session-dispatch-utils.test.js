import { describe, expect, test } from "vitest";
import {
  SESSION_DISPATCH_VOICE_INSTRUCTION,
  buildSessionDispatchCustomMessage,
  filterSessionRows,
  formatWorkspaceAndTitle,
  normalizeSessionRows,
  resolveSessionTitle,
  workspaceLabel,
} from "./session-dispatch-utils.js";

describe("session-dispatch-utils", () => {
  test("resolveSessionTitle prefers fixed title over dynamic title", () => {
    expect(resolveSessionTitle({ sessionId: "abc", title: "Fixed", dynamicTitle: "Dynamic" })).toBe(
      "Fixed",
    );
    expect(resolveSessionTitle({ sessionId: "abc", title: "", dynamicTitle: "Dynamic" })).toBe(
      "Dynamic",
    );
    expect(resolveSessionTitle({ sessionId: "abc", title: "", dynamicTitle: "" })).toBe("abc");
  });

  test("normalizeSessionRows extracts sessions and sorts by lastActivity descending", () => {
    const rows = normalizeSessionRows({
      sessions: [
        {
          sessionId: "a",
          workspace: "ws1",
          dynamicTitle: "older",
          lastActivity: "2026-01-01T00:00:00Z",
        },
        {
          session_id: "b",
          workspace: "ws2",
          title: "newer",
          last_activity: "2026-02-01T00:00:00Z",
        },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].sessionId).toBe("b");
    expect(rows[0].resolvedTitle).toBe("newer");
    expect(rows[1].resolvedTitle).toBe("older");
  });

  test("filterSessionRows matches workspace and resolved title", () => {
    const rows = [
      { workspace: "alpha", resolvedTitle: "Fix bug" },
      { workspace: "beta", resolvedTitle: "Ship docs" },
    ];
    expect(filterSessionRows(rows, "alp")).toHaveLength(1);
    expect(filterSessionRows(rows, "docs")).toHaveLength(1);
    expect(filterSessionRows(rows, "none")).toHaveLength(0);
  });

  test("buildSessionDispatchCustomMessage appends instruction only when missing", () => {
    const built = buildSessionDispatchCustomMessage("hello");
    expect(built).toContain("hello");
    expect(built).toContain(SESSION_DISPATCH_VOICE_INSTRUCTION);

    const alreadyContains = buildSessionDispatchCustomMessage(
      "Use the agent-voice-adapter-cli skill to continue the conversation with the user.",
    );
    expect(alreadyContains).toBe(
      "Use the agent-voice-adapter-cli skill to continue the conversation with the user.",
    );
  });

  test("workspaceLabel returns fallback for empty values", () => {
    expect(workspaceLabel("")).toBe("(no workspace)");
    expect(workspaceLabel("workspace-a")).toBe("workspace-a");
  });

  test("formatWorkspaceAndTitle matches workspace-first display contract", () => {
    expect(formatWorkspaceAndTitle("workspace-a", "Agent One")).toBe("workspace-a, Agent One");
    expect(formatWorkspaceAndTitle("", "Agent One")).toBe("Agent One");
    expect(formatWorkspaceAndTitle("workspace-a", "")).toBe("workspace-a, (no title)");
    expect(formatWorkspaceAndTitle("", "")).toBe("(no title)");
  });
});
