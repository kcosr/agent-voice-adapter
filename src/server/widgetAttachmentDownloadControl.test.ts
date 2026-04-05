import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readPublicFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../public", relativePath), "utf8");
}

describe("widget attachment download control", () => {
  test("renders download action for file attachments in bubble and modal flows", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function downloadAttachmentFile(attachment)");
    expect(appJs).toContain("function downloadInvalidAttachmentFile(attachment)");
    expect(appJs).toContain("function buildAttachmentDownloadButton(attachment)");
    expect(appJs).toContain("function buildInvalidAttachmentDownloadButton(attachment)");
    expect(appJs).toContain(
      "if (!attachment.fileName || !(attachment.decodedBytes instanceof Uint8Array)) {",
    );
    expect(appJs).toContain(
      'if (!attachment.fileName || attachment.decodeState !== "invalid_base64") {',
    );
    expect(appJs).toContain("anchor.download = sanitizeAttachmentFileName(attachment.fileName)");
    expect(appJs).toContain("const downloadButton = buildAttachmentDownloadButton(attachment);");
    expect(appJs).toContain(
      "const invalidDownloadButton = buildInvalidAttachmentDownloadButton(attachment);",
    );
    expect(appJs).toContain("if (downloadButton) {");
  });

  test("prevents attachment clicks from bubbling into bubble turn actions", () => {
    const appJs = readPublicFile("app.js");

    expect(appJs).toContain("function stopEventPropagation(event)");
    expect(appJs).toContain("function suppressAttachmentBubbleClickThrough(section)");
    expect(appJs).toContain('section.addEventListener("pointerdown", stopEventPropagation)');
    expect(appJs).toContain('section.addEventListener("pointerup", stopEventPropagation)');
    expect(appJs).toContain('section.addEventListener("pointercancel", stopEventPropagation)');
    expect(appJs).toContain('section.addEventListener("click", stopEventPropagation)');
    expect(appJs).toContain("suppressAttachmentBubbleClickThrough(section);");
  });

  test("includes attachment action-row styling hooks", () => {
    const stylesCss = readPublicFile("styles.css");

    expect(stylesCss).toContain(".bubble-attachment-actions");
    expect(stylesCss).toContain("flex-wrap: nowrap");
    expect(stylesCss).toContain(".bubble-attachment-download");
  });
});
