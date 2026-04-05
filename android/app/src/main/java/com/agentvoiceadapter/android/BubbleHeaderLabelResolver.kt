package com.agentvoiceadapter.android

object BubbleHeaderLabelResolver {
  fun resolveHeaderTitle(
    role: String,
    linkedSessionLabel: String?,
    defaultRoleLabel: String,
  ): String {
    val normalizedRole = role.lowercase()
    val normalizedLinkedLabel = linkedSessionLabel?.trim().orEmpty()
    if ((normalizedRole == "assistant" || normalizedRole == "user") && normalizedLinkedLabel.isNotEmpty()) {
      return normalizedLinkedLabel
    }
    return defaultRoleLabel
  }
}
