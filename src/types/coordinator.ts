import type { AgentId } from "./agent.ts";

export type CoordinatorMode = "manual" | "step" | "auto";
export type CoordinatorStatus = "active" | "paused" | "halted";
export type CoordinatorHaltKind =
  | "turn_limit"
  | "auto_turn_limit"
  | "handoff_limit"
  | "repeated_handoff"
  | "human_confirmation"
  | "no_progress";

export interface CoordinatorState {
  mode: CoordinatorMode;
  status: CoordinatorStatus;
  activeAgent?: AgentId;
  takenOverAgents: AgentId[];
  turnCount: number;
  maxTurns: number;
  handoffCount: number;
  repetitionCount: number;
  autoTurnStreakCount: number;
  autoTurnStreakAgent?: AgentId;
  lastDecision?: string;
  lastHandoffFrom?: AgentId;
  lastHandoffTo?: AgentId;
  lastHandoffSummary?: string;
  lastHandoffAsk?: string;
  lastHandoffRisk?: string;
  haltReason?: string;
  haltKind?: CoordinatorHaltKind;
}
