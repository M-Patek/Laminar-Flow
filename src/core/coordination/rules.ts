import type { AgentRole } from "../../types/agent.ts";

export function defaultIntentForRole(role: AgentRole): string {
  switch (role) {
    case "builder":
      return "Waiting for a build task.";
    case "reviewer":
      return "Waiting for a handoff to review.";
    case "planner":
      return "Waiting for a planning task.";
    case "executor":
      return "Waiting for executable instructions.";
    default:
      return "Waiting for work.";
  }
}
