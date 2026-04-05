package com.agentvoiceadapter.android

object BubbleHeaderTextColorResolver {
  fun resolve(
    role: String,
    noWait: Boolean,
    assistantHeaderColor: Int,
    assistantNoWaitHeaderColor: Int,
    userHeaderColor: Int,
    systemHeaderColor: Int,
  ): Int {
    return when (role) {
      "assistant" -> if (noWait) assistantHeaderColor else assistantNoWaitHeaderColor
      "user" -> userHeaderColor
      else -> systemHeaderColor
    }
  }
}
