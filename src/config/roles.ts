import type { AgentId, AgentRole } from "../types/agent.ts";

export const DEFAULT_ROLES: Record<AgentId, AgentRole> = {
  left: "builder",
  right: "reviewer"
};
