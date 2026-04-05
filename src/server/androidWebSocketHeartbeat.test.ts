import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

function readAndroidFile(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../android/app/src/main", relativePath), "utf8");
}

describe("android websocket heartbeat", () => {
  test("keeps transport ping disabled and runs non-fatal idle heartbeat probes", () => {
    const serviceKt = readAndroidFile("java/com/agentvoiceadapter/android/VoiceAdapterService.kt");

    expect(serviceKt).toContain(".pingInterval(0, TimeUnit.MILLISECONDS)");
    expect(serviceKt).toContain("WS_IDLE_HEARTBEAT_ENABLED = true");
    expect(serviceKt).toContain("WS_IDLE_HEARTBEAT_IDLE_MS = 20_000L");
    expect(serviceKt).toContain("WS_IDLE_HEARTBEAT_TIMEOUT_MS = 10_000L");
    expect(serviceKt).toContain("WS_IDLE_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 2");
    expect(serviceKt).toContain("idleHeartbeatRunnable");
    expect(serviceKt).toContain("runIdleHeartbeatCheck()");
    expect(serviceKt).toContain("shouldProbeHeartbeat(now)");
    expect(serviceKt).toContain("reconnectFromHeartbeatFailure");
    expect(serviceKt).toContain("ws_heartbeat_probe_invalidated");
    expect(serviceKt).toContain("ws_heartbeat_failure_reset");
    expect(serviceKt).toContain("ws_heartbeat_reconnect");
    expect(serviceKt).toContain(
      "if (!WS_IDLE_HEARTBEAT_ENABLED || !wsConnected || ws == null || stopping)",
    );
    expect(serviceKt).toContain('.put("type", "client_ping")');
    expect(serviceKt).toContain("ws_heartbeat_probe_sent");
    expect(serviceKt).toContain("ws_heartbeat_probe_timeout_nonfatal");
    expect(serviceKt).toContain("WebSocket heartbeat probe timed out; monitoring connection.");
    expect(serviceKt).toContain("ws_heartbeat_probe_send_failed_nonfatal");
    expect(serviceKt).toContain("WebSocket heartbeat send failed; monitoring connection.");
    expect(serviceKt).toContain("markSocketActivity(inbound = true)");
    expect(serviceKt).toContain('"server_pong"');
    expect(serviceKt).toContain("ws_heartbeat_pong");
    expect(serviceKt).toContain("WebSocket heartbeat degraded. Reconnecting.");
    expect(serviceKt).not.toContain("WebSocket heartbeat timed out. Reconnecting.");
  });

  test("server protocol supports ping/pong keepalive frames", () => {
    const serverTs = readFileSync(path.resolve(__dirname, "./server.ts"), "utf8");
    const protocolTs = readFileSync(path.resolve(__dirname, "./wsInboundProtocol.ts"), "utf8");

    expect(protocolTs).toContain('type: "client_ping"');
    expect(protocolTs).toContain("isClientPingMessage");
    expect(serverTs).toContain('type: "server_pong"');
    expect(serverTs).toContain("createPongMessage");
    expect(serverTs).toContain("isClientPingMessage(parsed)");
  });
});
