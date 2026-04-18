import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDefaultSnapshot } from "../src/config/defaults.ts";
import { AgentRegistry } from "../src/core/agents/AgentRegistry.ts";
import { AgentSession } from "../src/core/agents/AgentSession.ts";
import { Coordinator } from "../src/core/coordination/Coordinator.ts";
import { EventLog } from "../src/core/state/EventLog.ts";
import { SnapshotStore } from "../src/core/state/SnapshotStore.ts";
import { StateStore } from "../src/core/state/StateStore.ts";
import type { AppSnapshot } from "../src/types/app.ts";
import type { AgentProvider } from "../src/providers/Provider.ts";

export interface StoreFixture {
  rootDir: string;
  store: StateStore;
  cleanup: () => Promise<void>;
}

export interface CoordinatorFixture extends StoreFixture {
  coordinator: Coordinator;
  agents: AgentRegistry;
}

export async function createStoreFixture(
  mutateSnapshot?: (snapshot: AppSnapshot) => void
): Promise<StoreFixture> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "duplex-codex-test-"));
  const snapshot = createDefaultSnapshot();
  mutateSnapshot?.(snapshot);
  const store = new StateStore(
    snapshot,
    new EventLog(rootDir, "events.jsonl"),
    new SnapshotStore(rootDir, "session.json")
  );

  return {
    rootDir,
    store,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    }
  };
}

export async function createCoordinatorFixture(
  provider: AgentProvider,
  mutateSnapshot?: (snapshot: AppSnapshot) => void
): Promise<CoordinatorFixture> {
  const storeFixture = await createStoreFixture(mutateSnapshot);
  const snapshot = storeFixture.store.getSnapshot();
  const agents = new AgentRegistry({
    left: new AgentSession("left", snapshot.agents.left.role, provider, storeFixture.store),
    right: new AgentSession("right", snapshot.agents.right.role, provider, storeFixture.store)
  });

  return {
    ...storeFixture,
    agents,
    coordinator: new Coordinator(agents, storeFixture.store)
  };
}
