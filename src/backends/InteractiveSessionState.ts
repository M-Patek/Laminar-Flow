import path from "node:path";
import type { InteractiveBackendId } from "./interactiveCliBackend.ts";
import { SessionStateStore } from "../state/SessionStateStore.ts";

type PaneId = "left" | "right";

export interface InteractivePaneState {
  backend: InteractiveBackendId;
  sessionId?: string;
  updatedAt: string;
}

export interface InteractiveSessionState {
  panes: Partial<Record<PaneId, InteractivePaneState>>;
}

export class InteractiveSessionStateStore {
  private readonly store: SessionStateStore;

  constructor(workspaceDir: string) {
    this.store = new SessionStateStore(path.join(workspaceDir, ".duplex", "interactive-sessions.json"), "interactive-pane");
  }

  async load(): Promise<InteractiveSessionState> {
    const document = await this.store.load();
    return {
      panes: Object.fromEntries(
        Object.entries(document.entries).map(([ownerId, entry]) => [
          ownerId,
          {
            backend: (entry.backend ?? "codex") as InteractiveBackendId,
            sessionId: entry.sessionId,
            updatedAt: entry.updatedAt
          } satisfies InteractivePaneState
        ])
      )
    };
  }

  async save(state: InteractiveSessionState): Promise<void> {
    await this.store.save({
      scope: "interactive-pane",
      entries: Object.fromEntries(
        Object.entries(state.panes)
          .filter(([, pane]) => Boolean(pane))
          .map(([ownerId, pane]) => [
            ownerId,
            {
              ownerId,
              sessionId: pane?.sessionId,
              updatedAt: pane?.updatedAt ?? new Date().toISOString(),
              backend: pane?.backend
            }
          ])
      )
    });
  }
}
