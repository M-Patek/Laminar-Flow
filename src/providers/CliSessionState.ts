import path from "node:path";
import type { AgentId } from "../types/agent.ts";
import { SessionStateStore } from "../state/SessionStateStore.ts";

export interface CliAgentSessionRef {
  sessionId: string;
  updatedAt: string;
}

export interface CliSessionState {
  agents: Partial<Record<AgentId, CliAgentSessionRef>>;
}

export class CliSessionStateStore {
  private readonly store: SessionStateStore;

  constructor(runtimeDir: string, fileName: string) {
    this.store = new SessionStateStore(path.join(runtimeDir, fileName), "provider-agent");
  }

  async load(): Promise<CliSessionState> {
    const document = await this.store.load();
    return {
      agents: Object.fromEntries(
        Object.entries(document.entries).map(([ownerId, entry]) => [
          ownerId,
          {
            sessionId: entry.sessionId ?? "",
            updatedAt: entry.updatedAt
          } satisfies CliAgentSessionRef
        ])
      )
    };
  }

  async save(state: CliSessionState): Promise<void> {
    await this.store.save({
      scope: "provider-agent",
      entries: Object.fromEntries(
        Object.entries(state.agents)
          .filter(([, agent]) => Boolean(agent))
          .map(([ownerId, agent]) => [
            ownerId,
            {
              ownerId,
              sessionId: agent?.sessionId,
              updatedAt: agent?.updatedAt ?? new Date().toISOString()
            }
          ])
      )
    });
  }
}
