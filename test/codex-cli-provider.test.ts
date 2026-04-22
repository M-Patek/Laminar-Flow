import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStateStore } from "../src/state/SessionStateStore.ts";
import { InteractiveSessionStateStore } from "../src/backends/InteractiveSessionState.ts";
import { ClaudeCliProvider } from "../src/providers/ClaudeCliProvider.ts";
import { CodexCliProvider } from "../src/providers/CodexCliProvider.ts";
import { GeminiCliProvider } from "../src/providers/GeminiCliProvider.ts";
import type { ProviderInput, ProviderResult } from "../src/providers/Provider.ts";
import { createProvider } from "../src/providers/createProvider.ts";

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

test("GeminiCliProvider reuses the stored session id on later sends", async (t) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "duplex-gemini-provider-test-"));
  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const provider = new GeminiCliProvider(process.cwd(), runtimeDir);
  const callSessionIds: Array<string | undefined> = [];
  provider["execute"] = async (_input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> => {
    callSessionIds.push(sessionId);
    return {
      output: "ok",
      exitCode: 0,
      sessionId: FIRST_SESSION_ID
    };
  };

  await provider.send(createInput(1));
  await provider.send(createInput(2));
  const info = await provider.getSessionInfo("left");

  assert.deepEqual(callSessionIds, [undefined, FIRST_SESSION_ID]);
  assert.equal(info?.sessionId, FIRST_SESSION_ID);
});

test("ClaudeCliProvider reuses the stored session id on later sends", async (t) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "duplex-claude-provider-test-"));
  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const provider = new ClaudeCliProvider(process.cwd(), runtimeDir);
  const callSessionIds: Array<string | undefined> = [];
  provider["execute"] = async (_input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> => {
    callSessionIds.push(sessionId);
    return {
      output: "ok",
      exitCode: 0,
      sessionId: SECOND_SESSION_ID
    };
  };

  await provider.send(createInput(1));
  await provider.send(createInput(2));
  const info = await provider.getSessionInfo("left");

  assert.deepEqual(callSessionIds, [undefined, SECOND_SESSION_ID]);
  assert.equal(info?.sessionId, SECOND_SESSION_ID);
});

test("createProvider selects codex, gemini, and claude backends", () => {
  assert.equal(createProvider(process.cwd(), undefined, { DUPLEX_PROVIDER: "codex" }).name, "codex");
  assert.equal(createProvider(process.cwd(), undefined, { DUPLEX_PROVIDER: "gemini" }).name, "gemini");
  assert.equal(createProvider(process.cwd(), undefined, { DUPLEX_PROVIDER: "claude" }).name, "claude");
  assert.ok(createProvider(process.cwd(), undefined, { DUPLEX_PROVIDER: "gemini" }) instanceof GeminiCliProvider);
  assert.ok(createProvider(process.cwd(), undefined, { DUPLEX_PROVIDER: "claude" }) instanceof ClaudeCliProvider);
});

test("SessionStateStore reads legacy provider-agent session documents", async (t) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "duplex-session-store-provider-"));
  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const filePath = path.join(runtimeDir, "codex-sessions.json");
  await writeFile(
    filePath,
    JSON.stringify({
      agents: {
        left: {
          sessionId: FIRST_SESSION_ID,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    }),
    "utf8"
  );

  const store = new SessionStateStore(filePath, "provider-agent");
  const document = await store.load();

  assert.equal(document.scope, "provider-agent");
  assert.equal(document.entries.left?.ownerId, "left");
  assert.equal(document.entries.left?.sessionId, FIRST_SESSION_ID);
});

test("InteractiveSessionStateStore reads legacy pane session documents", async (t) => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "duplex-session-store-interactive-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const filePath = path.join(workspaceDir, ".duplex", "interactive-sessions.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      panes: {
        left: {
          backend: "claude",
          sessionId: SECOND_SESSION_ID,
          updatedAt: "2026-01-02T00:00:00.000Z"
        }
      }
    }),
    "utf8"
  );

  const store = new InteractiveSessionStateStore(workspaceDir);
  const state = await store.load();

  assert.equal(state.panes.left?.backend, "claude");
  assert.equal(state.panes.left?.sessionId, SECOND_SESSION_ID);
});
