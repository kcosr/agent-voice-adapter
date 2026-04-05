package com.agentvoiceadapter.android

object BubbleHeaderTypographyResolver {
  private const val mediumFontFamily = "sans-serif-medium"
  private const val defaultFontFamily = "sans-serif"

  fun resolveHeaderFontFamily(role: String): String {
    return when (role.lowercase()) {
      "assistant", "user", "system" -> mediumFontFamily
      else -> defaultFontFamily
    }
  }
}
