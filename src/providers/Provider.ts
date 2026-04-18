import type { AgentId, AgentRole } from "../types/agent.ts";

export interface ProviderInput {
  agentId: AgentId;
  role: AgentRole;
  prompt: string;
  round: number;
}

export interface ProviderResult {
  output: string;
  exitCode: number;
  sessionId?: string;
  rawStdout?: string;
  rawStderr?: string;
}

export interface ProviderSessionInfo {
  sessionId?: string;
  updatedAt?: string;
}

export interface AgentProvider {
  readonly name: string;
  send(input: ProviderInput): Promise<ProviderResult>;
  getSessionInfo?(agentId: AgentId): Promise<ProviderSessionInfo | null>;
  resetSession?(agentId: AgentId): Promise<void>;
}
