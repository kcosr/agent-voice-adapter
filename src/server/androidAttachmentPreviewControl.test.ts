import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android attachment preview controls", () => {
  test("forwards turn attachment payload into service bubble events with base64 contract", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain("attachment: JSONObject? = null");
    expect(serviceKt).toContain('val attachment = payload.optJSONObject("attachment")');
    expect(serviceKt).toContain(
      'val attachmentDataBase64 = attachment.optString("dataBase64", "").trim()',
    );
    expect(serviceKt).toContain(
      'val attachmentContentType = attachment.optString("contentType", "").trim()',
    );
    expect(serviceKt).toContain('.put("dataBase64", attachmentDataBase64)');
    expect(serviceKt).toContain('.put("contentType", attachmentContentType)');
    expect(serviceKt).toContain('payload.put("attachment", normalizedAttachment)');
    expect(serviceKt).not.toContain('.put("text", attachmentText)');
  });

  test("implements attachment decode states, preview routing, and invalid download fallback in main activity", () => {
    const activityKt = readAndroidFile("java/com/agentvoiceadapter/android/MainActivity.kt");

    expect(activityKt).toContain(
      'internal const val ATTACHMENT_DECODE_STATE_INVALID_BASE64 = "invalid_base64"',
    );
    expect(activityKt).toContain(
      'internal const val ATTACHMENT_DECODE_STATE_PREVIEW_UNAVAILABLE = "preview_unavailable"',
    );
    expect(activityKt).toContain(
      "internal fun resolveAttachmentPreviewMode(fileName: String, contentType: String): String {",
    );
    expect(activityKt).toContain(
      "internal fun decodeAttachmentDataBase64(dataBase64: String): ByteArray? {",
    );
    expect(activityKt).toContain(
      "internal fun decodeAttachmentPreviewText(bytes: ByteArray): String? {",
    );
    expect(activityKt).toContain(
      "internal fun buildInvalidAttachmentFileName(fileName: String): String {",
    );
    expect(activityKt).toContain(
      'addActionLink("Download invalid file") { downloadAttachment(normalizedAttachment) }',
    );
    expect(activityKt).toContain('text = "Preview unavailable"');
    expect(activityKt).toContain('text = "Invalid attachment encoding."');
    expect(activityKt).toContain("attachment.dataBase64.toByteArray(Charsets.UTF_8)");
    expect(activityKt).toContain("buildInvalidAttachmentFileName(normalizedFileName)");
    expect(activityKt).toContain("attachment.decodedBytes");
    expect(activityKt).toContain(
      'attachment.previewMode == "markdown" || attachment.previewMode == "text"',
    );
    expect(activityKt).toContain("openHtmlAttachmentInBrowser(normalizedAttachment)");
    expect(activityKt).not.toContain("attachment.text");
  });
});
