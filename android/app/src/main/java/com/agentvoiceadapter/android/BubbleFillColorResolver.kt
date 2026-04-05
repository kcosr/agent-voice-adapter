package com.agentvoiceadapter.android

object BubbleFillColorResolver {
  fun resolve(
    role: String,
    noWait: Boolean,
    assistantColor: Int,
    assistantNoWaitColor: Int,
    userColor: Int,
    systemColor: Int,
  ): Int {
    return when (role) {
      "assistant" -> if (noWait) assistantColor else assistantNoWaitColor
      "user" -> userColor
      else -> systemColor
    }
  }
}
