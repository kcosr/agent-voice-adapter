package com.agentvoiceadapter.android

object SessionFilterUtils {
  const val GLOBAL_FILTER_ID = ""
  data class SessionMessageRemovalResult(
    val keptMessages: List<String>,
    val removedCount: Int,
  )

  fun normalizeFilterId(filterId: String?): String {
    return filterId?.trim().orEmpty()
  }

  fun shouldDisplayBubble(
    selectedFilterId: String,
    bubbleSessionId: String,
  ): Boolean {
    val normalizedSelected = normalizeFilterId(selectedFilterId)
    if (normalizedSelected.isEmpty()) {
      return true
    }
    return normalizeFilterId(bubbleSessionId) == normalizedSelected
  }

  fun shiftFilterId(
    currentFilterId: String,
    orderedFilterIds: List<String>,
    direction: Int,
  ): String? {
    if (direction == 0 || orderedFilterIds.isEmpty()) {
      return null
    }

    val normalizedIds = orderedFilterIds.map { normalizeFilterId(it) }
    val currentIndex = normalizedIds.indexOf(normalizeFilterId(currentFilterId)).let { index ->
      if (index >= 0) index else 0
    }
    val delta = if (direction > 0) 1 else -1
    val nextIndex = (currentIndex + delta).coerceIn(0, normalizedIds.lastIndex)
    if (nextIndex == currentIndex) {
      return null
    }
    return normalizedIds[nextIndex]
  }

  fun isNonVisibleActiveSession(
    selectedFilterId: String,
    activeSessionId: String,
  ): Boolean {
    val normalizedSelected = normalizeFilterId(selectedFilterId)
    val normalizedActive = normalizeFilterId(activeSessionId)
    return normalizedSelected.isNotEmpty() &&
      normalizedActive.isNotEmpty() &&
      normalizedSelected != normalizedActive
  }

  fun isActiveSessionFilterChip(
    filterId: String,
    activeSessionId: String,
  ): Boolean {
    val normalizedFilterId = normalizeFilterId(filterId)
    if (normalizedFilterId.isEmpty()) {
      return false
    }
    return normalizedFilterId == normalizeFilterId(activeSessionId)
  }

  fun removeMessagesForSession(
    messages: List<String>,
    targetSessionId: String,
    resolveSessionId: (String) -> String,
  ): SessionMessageRemovalResult {
    val normalizedTarget = normalizeFilterId(targetSessionId)
    if (normalizedTarget.isEmpty()) {
      return SessionMessageRemovalResult(
        keptMessages = messages,
        removedCount = 0,
      )
    }

    var removed = 0
    val kept = buildList(messages.size) {
      for (message in messages) {
        val resolvedSessionId = normalizeFilterId(resolveSessionId(message))
        if (resolvedSessionId == normalizedTarget) {
          removed += 1
        } else {
          add(message)
        }
      }
    }
    return SessionMessageRemovalResult(
      keptMessages = kept,
      removedCount = removed,
    )
  }
}
