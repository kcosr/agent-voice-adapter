package com.agentvoiceadapter.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MicCaptureSessionGateTest {
  @Test
  fun tryStart_blocksSecondConcurrentSession() {
    val gate = MicCaptureSessionGate()

    val first = gate.tryStart("turn-1")
    val second = gate.tryStart("turn-2")

    assertNotNull(first)
    assertNull(second)
  }

  @Test
  fun requestStop_rejectsMismatchedRequestId() {
    val gate = MicCaptureSessionGate()
    val token = gate.tryStart("turn-1")
    assertNotNull(token)

    val stopToken = gate.requestStop("other-turn")

    assertNull(stopToken)
    assertTrue(gate.shouldContinue(token!!))
  }

  @Test
  fun requestStop_marksActiveSessionAsStopped() {
    val gate = MicCaptureSessionGate()
    val token = gate.tryStart("turn-1")
    assertNotNull(token)

    val stopped = gate.requestStop("turn-1")

    assertNotNull(stopped)
    assertFalse(gate.shouldContinue(token!!))
    assertFalse(gate.isRunningFor("turn-1"))
  }

  @Test
  fun finish_allowsNewSessionAndPreventsOldTokenReuse() {
    val gate = MicCaptureSessionGate()
    val first = gate.tryStart("turn-1")
    assertNotNull(first)

    gate.requestStop("turn-1")
    assertTrue(gate.finish(first!!))

    val second = gate.tryStart("turn-2")
    assertNotNull(second)
    assertFalse(gate.shouldContinue(first))
    assertTrue(gate.shouldContinue(second!!))
  }

  @Test
  fun finish_isIdempotent() {
    val gate = MicCaptureSessionGate()
    val token = gate.tryStart("turn-1")
    assertNotNull(token)

    assertTrue(gate.finish(token!!))
    assertFalse(gate.finish(token))
  }
}
