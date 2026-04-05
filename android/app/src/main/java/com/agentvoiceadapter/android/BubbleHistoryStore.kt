package com.agentvoiceadapter.android

import android.content.Context
import org.json.JSONArray

object BubbleHistoryStore {
  private const val FILE_NAME = "agent_voice_adapter_bubble_history"
  private const val KEY_MESSAGES = "messages"
  const val MAX_BUBBLES = 100

  fun append(context: Context, message: String) {
    if (message.isBlank()) {
      return
    }

    synchronized(this) {
      val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
      val updated = (readMessages(prefs.getString(KEY_MESSAGES, null)) + message).takeLast(MAX_BUBBLES)
      prefs.edit().putString(KEY_MESSAGES, JSONArray(updated).toString()).commit()
    }
  }

  fun readAll(context: Context): List<String> {
    synchronized(this) {
      val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
      return readMessages(prefs.getString(KEY_MESSAGES, null)).takeLast(MAX_BUBBLES)
    }
  }

  fun replaceAll(context: Context, messages: List<String>) {
    synchronized(this) {
      val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
      val updated = messages.map { it.trim() }.filter { it.isNotEmpty() }.takeLast(MAX_BUBBLES)
      if (updated.isEmpty()) {
        prefs.edit().remove(KEY_MESSAGES).commit()
      } else {
        prefs.edit().putString(KEY_MESSAGES, JSONArray(updated).toString()).commit()
      }
    }
  }

  fun clear(context: Context) {
    synchronized(this) {
      val prefs = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
      prefs.edit().remove(KEY_MESSAGES).apply()
    }
  }

  private fun readMessages(raw: String?): List<String> {
    if (raw.isNullOrBlank()) {
      return emptyList()
    }

    return runCatching {
      val json = JSONArray(raw)
      buildList(json.length()) {
        for (i in 0 until json.length()) {
          val entry = json.optString(i, "").trim()
          if (entry.isNotEmpty()) {
            add(entry)
          }
        }
      }
    }.getOrDefault(emptyList())
  }
}
