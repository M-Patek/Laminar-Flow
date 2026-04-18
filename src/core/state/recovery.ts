import type { AppSnapshot } from "../../types/app.ts";
import type { AgentStatus } from "../../types/agent.ts";
import { DEFAULT_MAX_TURNS } from "../../config/defaults.ts";

const INTERRUPTED_STATES = new Set<AgentStatus>(["running"]);

export function recoverSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const recovered: AppSnapshot = structuredClone(snapshot);
  recovered.updatedAt = new Date().toISOString();
  recovered.recentMessages ??= [];
  recovered.recentEvents ??= [];
  recovered.coordinator.takenOverAgents ??= [];
  recovered.coordinator.turnCount ??= Object.values(recovered.agents).reduce((sum, agent) => sum + agent.round, 0);
  recovered.coordinator.maxTurns ??= DEFAULT_MAX_TURNS;
  recovered.coordinator.handoffCount ??= 0;
  recovered.coordinator.repetitionCount ??= 0;
  recovered.coordinator.autoTurnStreakCount ??= 0;
  recovered.coordinator.lastHandoffRisk ??= undefined;
  recovered.coordinator.haltKind ??= undefined;

  for (const agent of Object.values(recovered.agents)) {
    if (INTERRUPTED_STATES.has(agent.status)) {
      agent.status = "needs_human";
      agent.lastError = "Recovered after an interrupted run. Confirm before continuing.";
      agent.lastErrorKind = "interrupted_run";
    }
  }

  return recovered;
}
