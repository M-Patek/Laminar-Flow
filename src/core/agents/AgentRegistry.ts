import type { AgentId } from "../../types/agent.ts";
import { AgentSession } from "./AgentSession.ts";

export class AgentRegistry {
  private readonly sessions: Record<AgentId, AgentSession>;

  constructor(sessions: Record<AgentId, AgentSession>) {
    this.sessions = sessions;
  }

  get(agentId: AgentId): AgentSession {
    return this.sessions[agentId];
  }

  all(): AgentSession[] {
    return Object.values(this.sessions);
  }
}
