package com.agentvoiceadapter.android

internal class MicCaptureSessionGate {
  data class Token internal constructor(
    val requestId: String,
    val sequence: Long,
  )

  private data class SessionState(
    val token: Token,
    var stopRequested: Boolean = false,
  )

  private val lock = Any()
  private val sessionsBySequence = mutableMapOf<Long, SessionState>()
  private var activeSequence: Long? = null
  private var nextSequence: Long = 1L

  fun tryStart(requestId: String): Token? = synchronized(lock) {
    if (activeSequence != null) {
      return null
    }
    val token = Token(requestId = requestId, sequence = nextSequence++)
    sessionsBySequence[token.sequence] = SessionState(token)
    activeSequence = token.sequence
    token
  }

  fun isRunningFor(requestId: String): Boolean = synchronized(lock) {
    val active = activeSessionLocked() ?: return false
    active.token.requestId == requestId && !active.stopRequested
  }

  fun requestStop(requestId: String? = null): Token? = synchronized(lock) {
    val active = activeSessionLocked() ?: return null
    if (requestId != null && requestId != active.token.requestId) {
      return null
    }
    active.stopRequested = true
    active.token
  }

  fun shouldContinue(token: Token): Boolean = synchronized(lock) {
    val session = sessionsBySequence[token.sequence] ?: return false
    activeSequence == token.sequence && !session.stopRequested
  }

  fun finish(token: Token): Boolean = synchronized(lock) {
    val removed = sessionsBySequence.remove(token.sequence) ?: return false
    if (activeSequence == removed.token.sequence) {
      activeSequence = null
    }
    true
  }

  private fun activeSessionLocked(): SessionState? {
    val sequence = activeSequence ?: return null
    return sessionsBySequence[sequence]
  }
}
