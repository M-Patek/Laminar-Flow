import test from "node:test";
import assert from "node:assert/strict";
import type { AgentProvider, ProviderInput, ProviderResult } from "../src/providers/Provider.ts";
import { createCoordinatorFixture } from "./helpers.ts";

class SequenceProvider implements AgentProvider {
  readonly name = "sequence";
  readonly calls: ProviderInput[] = [];
  private readonly results: ProviderResult[];

  constructor(results: ProviderResult[]) {
    this.results = [...results];
  }

  async send(input: ProviderInput): Promise<ProviderResult> {
    this.calls.push(input);
    const next = this.results.shift();
    if (!next) {
      throw new Error("No more provider results were configured.");
    }

    return next;
  }
}

class ThrowingProvider implements AgentProvider {
  readonly name = "throwing";

  async send(_input: ProviderInput): Promise<ProviderResult> {
    throw new Error("spawn EPERM");
  }
}

test("step mode queues work without auto-advancing", async (t) => {
  const provider = new SequenceProvider([
    {
      output: "unused",
      exitCode: 0
    }
  ]);
  const fixture = await createCoordinatorFixture(provider);
  t.after(fixture.cleanup);

  await fixture.coordinator.setMode("step");
  const message = await fixture.coordinator.sendUserMessage("left", "Design the pane layout.");
  const snapshot = fixture.store.getSnapshot();

  assert.equal(message, "Queued for left; use /step left when ready.");
  assert.equal(snapshot.agents.left.status, "waiting_message");
  assert.equal(snapshot.agents.left.round, 0);
  assert.equal(snapshot.agents.left.queuedMessages, 1);
  assert.equal(provider.calls.length, 0);
});

test("retry preserves queued work after a provider failure and advances on success", async (t) => {
  const provider = new SequenceProvider([
    {
      output: "",
      exitCode: 1,
      rawStderr: "mock failure"
    },
    {
      output: "Recovered implementation summary.",
      exitCode: 0
    }
  ]);
  const fixture = await createCoordinatorFixture(provider);
  t.after(fixture.cleanup);

  await fixture.coordinator.sendUserMessage("left", "Implement the command bar.");
  let snapshot = fixture.store.getSnapshot();
  assert.equal(snapshot.agents.left.status, "error");
  assert.equal(snapshot.agents.left.queuedMessages, 1);
  assert.equal(snapshot.agents.left.lastError, "mock failure");

  const retryMessage = await fixture.coordinator.retryAgent("left");
  snapshot = fixture.store.getSnapshot();

  assert.equal(retryMessage, "Advanced left.");
  assert.equal(snapshot.agents.left.status, "waiting_handoff");
  assert.equal(snapshot.agents.left.queuedMessages, 0);
  assert.equal(snapshot.agents.left.round, 2);
  assert.match(snapshot.agents.left.lastOutput ?? "", /Recovered implementation summary/);
});

test("sendUserMessage surfaces provider failure instead of claiming success", async (t) => {
  const provider = new SequenceProvider([
    {
      output: "",
      exitCode: 1,
      rawStderr: "provider down"
    }
  ]);
  const fixture = await createCoordinatorFixture(provider);
  t.after(fixture.cleanup);

  const message = await fixture.coordinator.sendUserMessage("left", "Run a failing provider call.");
  const snapshot = fixture.store.getSnapshot();

  assert.equal(message, "Advance failed for left; queued work was preserved.");
  assert.equal(snapshot.agents.left.status, "error");
  assert.equal(snapshot.agents.left.lastErrorKind, "provider_failure");
});

test("sendUserMessage degrades thrown provider errors into agent failure state", async (t) => {
  const provider = new ThrowingProvider();
  const fixture = await createCoordinatorFixture(provider);
  t.after(fixture.cleanup);

  const message = await fixture.coordinator.sendUserMessage("left", "Run the real codex subprocess.");
  const snapshot = fixture.store.getSnapshot();

  assert.equal(message, "Advance failed for left; queued work was preserved.");
  assert.equal(snapshot.agents.left.status, "error");
  assert.equal(snapshot.agents.left.lastError, "spawn EPERM");
  assert.equal(snapshot.agents.left.queuedMessages, 1);
});

test("auto advance stops at manual takeover boundaries", async (t) => {
  const provider = new SequenceProvider([
    {
      output: "This result should never run.",
      exitCode: 0
    }
  ]);
  const fixture = await createCoordinatorFixture(provider);
  t.after(fixture.cleanup);

  await fixture.coordinator.takeoverAgent("left");
  const message = await fixture.coordinator.advanceAgent("left", "auto");
  const snapshot = fixture.store.getSnapshot();

  assert.equal(message, "left is under manual takeover. Use /step left to continue there.");
  assert.equal(snapshot.coordinator.lastDecision, message);
  assert.equal(provider.calls.length, 0);
});

test("setting max turns below the current count halts the coordinator immediately", async (t) => {
  const provider = new SequenceProvider([]);
  const fixture = await createCoordinatorFixture(provider, (snapshot) => {
    snapshot.coordinator.turnCount = 3;
  });
  t.after(fixture.cleanup);

  const message = await fixture.coordinator.setMaxTurns(2);
  const snapshot = fixture.store.getSnapshot();

  assert.equal(message, "Reached max turns (2). Use /max-turns <larger> then /resume to continue.");
  assert.equal(snapshot.coordinator.status, "halted");
  assert.equal(snapshot.coordinator.haltReason, "Reached max turns (2).");
});

test("handoff stores a structured package with risk and ask metadata", async (t) => {
  const provider = new SequenceProvider([]);
  const fixture = await createCoordinatorFixture(provider, (snapshot) => {
    snapshot.agents.left.lastOutput = [
      "Result:",
      "- Built the split-pane UI and wired the command bar.",
      "- Primary risk: missing tests around auto handoff loops."
    ].join("\n");
    snapshot.agents.left.round = 1;
  });
  t.after(fixture.cleanup);

  const message = await fixture.coordinator.handoff("left");
  const snapshot = fixture.store.getSnapshot();
  const handoff = snapshot.recentMessages.at(-1);

  assert.equal(message, "Handed off left -> right.");
  assert.equal(snapshot.coordinator.lastHandoffFrom, "left");
  assert.equal(snapshot.coordinator.lastHandoffTo, "right");
  assert.match(snapshot.coordinator.lastHandoffRisk ?? "", /risk/i);
  assert.ok(handoff);
  assert.equal(handoff?.kind, "handoff");
  assert.match(handoff?.body ?? "", /Context:\n/);
  assert.match(handoff?.body ?? "", /\n\nResult:\n/);
  assert.match(handoff?.body ?? "", /\n\nRisk:\n/);
  assert.match(handoff?.body ?? "", /\n\nAsk:\n/);
});

test("nested auto handoffs do not overwrite a later needs_human state", async (t) => {
  const provider = new SequenceProvider([
    {
      output: "Builder created the initial split pane implementation.",
      exitCode: 0
    },
    {
      output: "Reviewer suggested checking auto handoff loops without changing the plan.",
      exitCode: 0
    },
    {
      output: "Builder created the initial split pane implementation.",
      exitCode: 0
    }
  ]);
  const fixture = await createCoordinatorFixture(provider);
  t.after(fixture.cleanup);

  await fixture.coordinator.setMode("auto");
  await fixture.coordinator.sendUserMessage("left", "Run the builder-reviewer loop.");
  const snapshot = fixture.store.getSnapshot();

  assert.equal(snapshot.coordinator.haltKind, "no_progress");
  assert.equal(snapshot.agents.left.status, "needs_human");
  assert.equal(snapshot.agents.left.lastErrorKind, "no_progress");
});
