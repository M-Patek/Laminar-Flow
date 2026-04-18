import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../src/core/agents/AgentSession.ts";
import type { AgentProvider, ProviderInput, ProviderResult } from "../src/providers/Provider.ts";
import type { Message } from "../src/types/message.ts";
import { createStoreFixture } from "./helpers.ts";

class SequenceProvider implements AgentProvider {
  readonly name = "sequence";
  readonly calls: ProviderInput[] = [];
  readonly resetCalls: string[] = [];
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

  async resetSession(agentId: "left" | "right"): Promise<void> {
    this.resetCalls.push(agentId);
  }
}

class ThrowingProvider implements AgentProvider {
  readonly name = "throwing";

  async send(_input: ProviderInput): Promise<ProviderResult> {
    throw new Error("spawn EPERM");
  }
}

function createMessage(body: string): Message {
  return {
    id: `msg-${Math.random()}`,
    kind: "user",
    from: "user",
    to: "left",
    body,
    round: 0,
    createdAt: new Date().toISOString(),
    requiresHuman: false
  };
}

test("AgentSession marks semantically repeated output as noProgress", async (t) => {
  const provider = new SequenceProvider([
    {
      output: [
        "Role: builder",
        "Round: 2",
        "Result:",
        "- UI coordination state provider layers",
        "- Next action: ask the reviewer for risk checks."
      ].join("\n"),
      exitCode: 0
    }
  ]);
  const fixture = await createStoreFixture((snapshot) => {
    snapshot.agents.left.lastOutput = [
      "Role: builder",
      "Round: 1",
      "Result:",
      "- UI coordination state provider layers",
      "- Next action: ask the reviewer for risk checks."
    ].join("\n");
  });
  t.after(fixture.cleanup);

  const session = new AgentSession("left", "builder", provider, fixture.store);
  await session.enqueue(createMessage("Repeat the latest summary."));
  const result = await session.advance();
  const snapshot = fixture.store.getSnapshot();

  assert.ok(result);
  assert.equal(result.noProgress, true);
  assert.match(snapshot.agents.left.lastOutputSummary ?? "", /UI coordination state provider layers/);
  assert.equal(snapshot.agents.left.queuedMessages, 0);
});

test("AgentSession resumeFromIntervention prefers queued work over last output", async (t) => {
  const provider = new SequenceProvider([]);
  const fixture = await createStoreFixture((snapshot) => {
    snapshot.agents.left.lastOutput = "Completed a previous review.";
    snapshot.agents.left.status = "error";
  });
  t.after(fixture.cleanup);

  const session = new AgentSession("left", "builder", provider, fixture.store);
  await session.enqueue(createMessage("Retry the failed step."));
  const nextStatus = await session.resumeFromIntervention();
  const snapshot = fixture.store.getSnapshot();

  assert.equal(nextStatus, "waiting_message");
  assert.equal(snapshot.agents.left.status, "waiting_message");
  assert.equal(snapshot.agents.left.currentIntent, "Queued work is ready to run.");
  assert.equal(snapshot.agents.left.lastError, undefined);
});

test("AgentSession reset clears local state and provider session metadata", async (t) => {
  const provider = new SequenceProvider([]);
  const fixture = await createStoreFixture((snapshot) => {
    snapshot.agents.left.status = "waiting_handoff";
    snapshot.agents.left.round = 3;
    snapshot.agents.left.lastOutput = "Latest output";
    snapshot.agents.left.lastOutputSummary = "Latest summary";
    snapshot.agents.left.lastError = "old error";
    snapshot.agents.left.currentIntent = "Waiting for handoff.";
    snapshot.agents.left.sessionId = "session-123";
    snapshot.agents.left.sessionUpdatedAt = new Date().toISOString();
  });
  t.after(fixture.cleanup);

  const session = new AgentSession("left", "builder", provider, fixture.store);
  await session.enqueue(createMessage("Pending work."));
  await session.reset();
  const snapshot = fixture.store.getSnapshot();

  assert.deepEqual(provider.resetCalls, ["left"]);
  assert.equal(snapshot.agents.left.status, "idle");
  assert.equal(snapshot.agents.left.round, 0);
  assert.equal(snapshot.agents.left.lastOutput, undefined);
  assert.equal(snapshot.agents.left.lastOutputSummary, undefined);
  assert.equal(snapshot.agents.left.lastError, undefined);
  assert.equal(snapshot.agents.left.sessionId, undefined);
  assert.equal(snapshot.agents.left.queuedMessages, 0);
});

test("AgentSession converts provider exceptions into recoverable error state", async (t) => {
  const provider = new ThrowingProvider();
  const fixture = await createStoreFixture();
  t.after(fixture.cleanup);

  const session = new AgentSession("left", "builder", provider, fixture.store);
  await session.enqueue(createMessage("Run through the real Codex provider."));
  const result = await session.advance();
  const snapshot = fixture.store.getSnapshot();

  assert.equal(result, null);
  assert.equal(snapshot.agents.left.status, "error");
  assert.equal(snapshot.agents.left.lastErrorKind, "provider_failure");
  assert.equal(snapshot.agents.left.lastError, "spawn EPERM");
  assert.equal(snapshot.agents.left.queuedMessages, 1);
  assert.match(
    snapshot.recentEvents.at(-1)?.message ?? "",
    /left status running -> error/
  );
});
