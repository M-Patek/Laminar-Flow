export type AgentId = "left" | "right";

export type AgentRole =
  | "builder"
  | "reviewer"
  | "planner"
  | "executor";

export type AgentStatus =
  | "idle"
  | "running"
  | "waiting_message"
  | "waiting_handoff"
  | "needs_human"
  | "error";

export type AgentIssueKind =
  | "provider_failure"
  | "interrupted_run"
  | "no_progress"
  | "human_confirmation";

export interface AgentSessionState {
  id: AgentId;
  role: AgentRole;
  status: AgentStatus;
  round: number;
  queuedMessages: number;
  lastActionAt?: string;
  lastOutput?: string;
  lastOutputSummary?: string;
  currentIntent?: string;
  lastError?: string;
  lastErrorKind?: AgentIssueKind;
  sessionId?: string;
  sessionUpdatedAt?: string;
}
