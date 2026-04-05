import { asNonEmptyString } from "./string-utils.js";

export const SESSION_DISPATCH_VOICE_INSTRUCTION =
  "Use the agent-voice-adapter-cli skill to continue the conversation with the user.";

function asBoolean(value) {
  return value === true;
}

function parseSortKey(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveSessionTitle(session) {
  const title = asNonEmptyString(session?.title);
  if (title) {
    return title;
  }
  const dynamicTitle = asNonEmptyString(session?.dynamicTitle ?? session?.dynamic_title);
  if (dynamicTitle) {
    return dynamicTitle;
  }
  return asNonEmptyString(session?.sessionId ?? session?.session_id);
}

export function normalizeSessionRows(payload) {
  const arrayPayload = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : [];
  const rows = [];

  for (const item of arrayPayload) {
    const sessionId = asNonEmptyString(item?.sessionId ?? item?.session_id);
    if (!sessionId) {
      continue;
    }

    const workspace = asNonEmptyString(item?.workspace);
    const title = asNonEmptyString(item?.title);
    const dynamicTitle = asNonEmptyString(item?.dynamicTitle ?? item?.dynamic_title);
    const resolvedTitle = resolveSessionTitle({
      sessionId,
      title,
      dynamicTitle,
    });
    const lastActivity = asNonEmptyString(item?.lastActivity ?? item?.last_activity);
    const isActive = asBoolean(item?.isActive ?? item?.is_active);

    rows.push({
      sessionId,
      workspace,
      title,
      dynamicTitle,
      resolvedTitle,
      lastActivity,
      isActive,
    });
  }

  rows.sort((left, right) => parseSortKey(right.lastActivity) - parseSortKey(left.lastActivity));
  return rows;
}

export function filterSessionRows(rows, query) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const normalizedQuery = asNonEmptyString(query).toLowerCase();
  if (!normalizedQuery) {
    return normalizedRows;
  }

  return normalizedRows.filter((row) => {
    const workspace = asNonEmptyString(row?.workspace).toLowerCase();
    const title = asNonEmptyString(row?.resolvedTitle).toLowerCase();
    return workspace.includes(normalizedQuery) || title.includes(normalizedQuery);
  });
}

export function workspaceLabel(workspace) {
  const cleaned = asNonEmptyString(workspace);
  return cleaned || "(no workspace)";
}

export function formatWorkspaceAndTitle(workspace, title) {
  const cleanedWorkspace = asNonEmptyString(workspace);
  const cleanedTitle = asNonEmptyString(title);
  const safeTitle = cleanedTitle || "(no title)";
  if (!cleanedWorkspace) {
    return safeTitle;
  }
  return `${cleanedWorkspace}, ${safeTitle}`;
}

export function buildSessionDispatchCustomMessage(
  message,
  instruction = SESSION_DISPATCH_VOICE_INSTRUCTION,
) {
  const trimmedMessage = asNonEmptyString(message);
  if (!trimmedMessage) {
    return "";
  }

  if (trimmedMessage.toLowerCase().includes("agent-voice-adapter-cli skill")) {
    return trimmedMessage;
  }

  const trimmedInstruction = asNonEmptyString(instruction);
  if (!trimmedInstruction) {
    return trimmedMessage;
  }

  return `${trimmedMessage}\n\n${trimmedInstruction}`;
}
