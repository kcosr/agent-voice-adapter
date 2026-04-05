package com.agentvoiceadapter.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MainActivityParsingUtilsTest {
  @Test
  fun `session dispatch normalization supports fallback title resolution`() {
    val rows = MainActivity.normalizeSessionDispatchRows(
      listOf(
        MainActivity.Companion.SessionDispatchRowRaw(
          sessionId = " session-a ",
          workspace = " dev ",
          title = "Primary Title",
          dynamicTitle = "Dynamic A",
        ),
        MainActivity.Companion.SessionDispatchRowRaw(
          sessionIdSnake = "session-b",
          dynamicTitleSnake = "Dynamic B",
        ),
        MainActivity.Companion.SessionDispatchRowRaw(
          sessionId = " ",
        ),
      ),
    )

    assertEquals(2, rows.size)
    assertEquals("session-a", rows[0].sessionId)
    assertEquals("dev", rows[0].workspace)
    assertEquals("Primary Title", rows[0].resolvedTitle)
    assertEquals("session-b", rows[1].sessionId)
    assertEquals("Dynamic B", rows[1].resolvedTitle)
  }

  @Test
  fun `session dispatch normalization falls back to session id as title`() {
    val rows = MainActivity.normalizeSessionDispatchRows(
      listOf(
        MainActivity.Companion.SessionDispatchRowRaw(
          sessionId = "session-c",
        ),
      ),
    )

    assertEquals(1, rows.size)
    assertEquals("session-c", rows[0].resolvedTitle)
  }

  @Test
  fun `server runtime settings value parser validates numeric bounds`() {
    val valid = MainActivity.parseServerRuntimeSettingsValues(
      asrListenStartTimeoutMs = 1000,
      asrListenCompletionTimeoutMs = 5000,
      asrRecognitionEndSilenceMs = 750,
      queueAdvanceDelayMs = 0,
      prependLinkedSessionLabelForTts = true,
    )
    assertEquals(1000, valid?.asrListenStartTimeoutMs)
    assertTrue(valid?.prependLinkedSessionLabelForTts == true)

    val invalid = MainActivity.parseServerRuntimeSettingsValues(
      asrListenStartTimeoutMs = 0,
      asrListenCompletionTimeoutMs = 5000,
      asrRecognitionEndSilenceMs = 750,
      queueAdvanceDelayMs = -1,
      prependLinkedSessionLabelForTts = false,
    )
    assertTrue(invalid == null)
  }

  @Test
  fun `runtime status merge trims fields and falls back for blank status values`() {
    val fallback = MainActivity.Companion.RuntimeStatusParsed(
      ws = "stopped",
      audio = "idle",
      media = "passthrough",
      music = "unknown",
      turnId = "fallback-turn",
    )

    val parsed = MainActivity.mergeRuntimeStatusPayload(
      ws = " connected ",
      audio = " ",
      media = "",
      music = " playback ",
      turnId = " turn-1 ",
      fallback = fallback,
    )

    assertEquals("connected", parsed.ws)
    assertEquals("idle", parsed.audio)
    assertEquals("passthrough", parsed.media)
    assertEquals("playback", parsed.music)
    assertEquals("turn-1", parsed.turnId)
  }

  @Test
  fun `active client merge applies fallback values when fields are missing`() {
    val parsed = MainActivity.mergeActiveClientStatePayload(
      active = true,
      activeClientConnected = null,
      connectedClients = 4,
      fallback = MainActivity.Companion.ActiveClientStateParsed(
        active = false,
        activeClientConnected = true,
        connectedClients = 1,
      ),
    )

    assertTrue(parsed.active)
    assertTrue(parsed.activeClientConnected)
    assertEquals(4, parsed.connectedClients)
  }

  @Test
  fun `runtime status merge uses fallback values when inputs are null or blank`() {
    val parsed = MainActivity.mergeRuntimeStatusPayload(
      ws = " ",
      audio = null,
      media = "",
      music = " unknown ",
      turnId = null,
      fallback = MainActivity.Companion.RuntimeStatusParsed(
        ws = "connected",
        audio = "idle",
        media = "passthrough",
        music = "start_active",
        turnId = "turn-fallback",
      ),
    )

    assertEquals("connected", parsed.ws)
    assertEquals("idle", parsed.audio)
    assertEquals("passthrough", parsed.media)
    assertEquals("unknown", parsed.music)
    assertEquals("", parsed.turnId)
  }

  @Test
  fun `markdown front matter normalization wraps yaml header in fenced block`() {
    val input = """
      ---
      title: Example
      description: Demo
      ---
      # Heading
    """.trimIndent()

    val normalized = MainActivity.normalizeMarkdownFrontMatterText(input)

    assertTrue(normalized.startsWith("```yaml\n"))
    assertTrue(normalized.contains("title: Example"))
    assertTrue(normalized.contains("\n```\n\n# Heading"))
  }

  @Test
  fun `markdown front matter normalization leaves non-yaml headers unchanged`() {
    val input = """
      ---
      just text
      ---
      body
    """.trimIndent()

    val normalized = MainActivity.normalizeMarkdownFrontMatterText(input)
    assertEquals(input, normalized)
  }

  @Test
  fun `markdown front matter normalization supports dot terminator and no body`() {
    val input = """
      ---
      title: Example
      ...
    """.trimIndent()

    val normalized = MainActivity.normalizeMarkdownFrontMatterText(input)

    assertEquals("```yaml\ntitle: Example\n```", normalized)
  }

  @Test
  fun `attachment preview mode routing follows locked mime policy`() {
    assertEquals("markdown", MainActivity.resolveAttachmentPreviewMode("notes.md", "text/markdown"))
    assertEquals("text", MainActivity.resolveAttachmentPreviewMode("notes.txt", "text/plain"))
    assertEquals("html", MainActivity.resolveAttachmentPreviewMode("index.html", "text/html"))
    assertEquals("none", MainActivity.resolveAttachmentPreviewMode("payload.json", "application/json"))
  }

  @Test
  fun `attachment base64 decoder returns null for invalid payload`() {
    assertNull(MainActivity.decodeAttachmentDataBase64("not base64 !!"))
    assertEquals(
      "hello",
      MainActivity.decodeAttachmentPreviewText("aGVsbG8=".let { java.util.Base64.getDecoder().decode(it) }),
    )
  }

  @Test
  fun `attachment preview decoder reports invalid utf8`() {
    assertNull(MainActivity.decodeAttachmentPreviewText(byteArrayOf(0xFF.toByte(), 0xFF.toByte())))
  }

  @Test
  fun `attachment filename sanitizer and invalid suffix are deterministic`() {
    assertEquals("foo_bar_.zip", MainActivity.sanitizeAttachmentFileName(" ../../foo:bar?.zip "))
    assertEquals("foobar.txt", MainActivity.sanitizeAttachmentFileName("foo\u0001bar.txt"))
    assertEquals("attachment", MainActivity.sanitizeAttachmentFileName("..."))
    assertEquals("bundle.zip.invalid", MainActivity.buildInvalidAttachmentFileName("bundle.zip"))
  }
}
