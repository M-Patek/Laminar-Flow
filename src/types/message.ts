import type { AgentId } from "./agent.ts";

export type MessageKind =
  | "user"
  | "agent_output"
  | "handoff"
  | "system"
  | "warning";

export type MessageEndpoint = AgentId | "user" | "system" | "coordinator" | "broadcast";

export interface Message {
  id: string;
  kind: MessageKind;
  from: MessageEndpoint;
  to: MessageEndpoint;
  body: string;
  summary?: string;
  round: number;
  createdAt: string;
  requiresHuman: boolean;
  sourceEventId?: string;
}
