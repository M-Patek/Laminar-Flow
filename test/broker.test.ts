import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  createMessage,
  getBrokerDiagnostics,
  getNextDeliveryCandidate,
  getUnreadCounts,
  upsertPeerState
} from "../src/app/broker.ts";
import { createConfiguredBrokerClient } from "../src/app/brokerClient.ts";
import { createDaemonBrokerTransport, resolveBrokerTransportMode } from "../src/app/brokerTransport.ts";

test("broker candidate selection is not blocked by peer busy state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "duplex-broker-"));
  await upsertPeerState(workspace, { id: "left", status: "busy" });
  await createMessage(workspace, {
    from: "right",
    to: "left",
    kind: "note",
    summary: "support found a risk",
    ask: "check null case"
  });

  const candidate = await getNextDeliveryCandidate(workspace, { cooldownMs: 0, lastDeliveryAt: 0 });
  assert.ok(candidate);
  assert.equal(candidate?.target, "left");
  assert.equal(candidate?.message.from, "right");
});

test("broker diagnostics reports quiet windows, cooldown, and next target", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "duplex-broker-"));
  let diagnostics = await getBrokerDiagnostics(workspace, { cooldownMs: 0, lastDeliveryAt: 0 });
  assert.equal(diagnostics.blockedReason, "no_pending");
  assert.equal(diagnostics.cooldownRemainingMs, 0);

  await upsertPeerState(workspace, { id: "left", status: "busy" });
  await createMessage(workspace, {
    from: "right",
    to: "left",
    kind: "note",
    summary: "support has input",
    ask: "pick it up"
  });

  diagnostics = await getBrokerDiagnostics(workspace, { cooldownMs: 0, lastDeliveryAt: 0 });
  assert.equal(diagnostics.blockedReason, "none");
  assert.ok(diagnostics.quietRemainingMs.left > 0);

  await upsertPeerState(workspace, {
    id: "left",
    status: "busy",
    lastActivityAt: new Date(Date.now() - 5_000).toISOString()
  });
  diagnostics = await getBrokerDiagnostics(workspace, { cooldownMs: 10_000, lastDeliveryAt: Date.now() });
  assert.equal(diagnostics.blockedReason, "cooldown");
  assert.ok(diagnostics.cooldownRemainingMs > 0);

  diagnostics = await getBrokerDiagnostics(workspace, { cooldownMs: 0, lastDeliveryAt: 0 });
  assert.equal(diagnostics.nextTarget, "left");
  assert.equal(diagnostics.nextMessage?.from, "right");
  assert.equal(diagnostics.nextMessage?.to, "left");
});

test("broker transport mode defaults to local and recognizes daemon", () => {
  assert.equal(resolveBrokerTransportMode({} as NodeJS.ProcessEnv), "local");
  assert.equal(resolveBrokerTransportMode({ DUPLEX_BROKER_TRANSPORT: "daemon" }), "daemon");
});

test("configured daemon broker client currently fails with a clear stub error", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "duplex-broker-"));
  const client = createConfiguredBrokerClient(workspace, { DUPLEX_BROKER_TRANSPORT: "daemon" });
  await assert.rejects(
    () => client.getUnreadCounts(),
    /Daemon broker transport is not implemented yet/
  );
  const transport = createDaemonBrokerTransport();
  await assert.rejects(
    () => transport.readBrokerSnapshot(),
    /Daemon broker transport is not implemented yet/
  );
});

test("broker recovers from a malformed state file", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "duplex-broker-"));
  const brokerDir = path.join(workspace, ".duplex", "broker");
  await mkdir(brokerDir, { recursive: true });
  await writeFile(path.join(brokerDir, "state.json"), "{\"messages\":", "utf8");

  const counts = await getUnreadCounts(workspace);
  assert.deepEqual(counts, { left: 0, right: 0 });
});
