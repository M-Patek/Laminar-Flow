import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexCliProvider } from "../src/providers/CodexCliProvider.ts";
import type { ProviderInput, ProviderResult } from "../src/providers/Provider.ts";

const FIRST_SESSION_ID = "11111111-1111-1111-1111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-2222-2222-222222222222";

function createInput(round: number): ProviderInput {
  return {
    agentId: "left",
    role: "builder",
    prompt: `round ${round}`,
    round
  };
}

async function createProviderFixture(): Promise<{
  provider: CodexCliProvider;
  cleanup: () => Promise<void>;
}> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "duplex-codex-provider-test-"));
  const provider = new CodexCliProvider(process.cwd(), runtimeDir);

  return {
    provider,
    cleanup: async () => {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  };
}

test("CodexCliProvider reuses the stored session id on later sends", async (t) => {
  const fixture = await createProviderFixture();
  t.after(fixture.cleanup);

  const callSessionIds: Array<string | undefined> = [];
  fixture.provider["runCodex"] = async (_input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> => {
    callSessionIds.push(sessionId);
    return {
      output: "ok",
      exitCode: 0,
      sessionId: sessionId ?? FIRST_SESSION_ID
    };
  };

  await fixture.provider.send(createInput(1));
  await fixture.provider.send(createInput(2));
  const info = await fixture.provider.getSessionInfo("left");

  assert.deepEqual(callSessionIds, [undefined, FIRST_SESSION_ID]);
  assert.equal(info?.sessionId, FIRST_SESSION_ID);
});

test("CodexCliProvider clears a stale session and retries without resume on failure", async (t) => {
  const fixture = await createProviderFixture();
  t.after(fixture.cleanup);

  await fixture.provider["sessionStateStore"].save({
    agents: {
      left: {
        sessionId: FIRST_SESSION_ID,
        updatedAt: new Date().toISOString()
      }
    }
  });

  const callSessionIds: Array<string | undefined> = [];
  fixture.provider["runCodex"] = async (_input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> => {
    callSessionIds.push(sessionId);
    if (callSessionIds.length === 1) {
      return {
        output: "",
        exitCode: 1,
        sessionId: FIRST_SESSION_ID,
        rawStderr: "resume failed"
      };
    }

    return {
      output: "fresh output",
      exitCode: 0,
      sessionId: SECOND_SESSION_ID
    };
  };

  const result = await fixture.provider.send(createInput(1));
  const info = await fixture.provider.getSessionInfo("left");

  assert.deepEqual(callSessionIds, [FIRST_SESSION_ID, undefined]);
  assert.equal(result.sessionId, SECOND_SESSION_ID);
  assert.equal(info?.sessionId, SECOND_SESSION_ID);
});
