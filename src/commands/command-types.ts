import type { AgentId } from "../types/agent.ts";
import type { UiEventScope } from "../types/app.ts";
import type { CoordinatorMode } from "../types/coordinator.ts";

export type ParsedCommand =
  | { type: "send"; target: AgentId; body: string }
  | { type: "broadcast"; body: string }
  | { type: "focus"; target: AgentId | "next" }
  | { type: "inputMode"; mode: "direct" | "command" }
  | { type: "step"; target: AgentId }
  | { type: "takeover"; target: AgentId }
  | { type: "release"; target: AgentId }
  | { type: "retry"; target?: AgentId }
  | { type: "resumeAgent"; target: AgentId }
  | { type: "reset"; target: AgentId }
  | { type: "handoff"; from: AgentId }
  | { type: "mode"; mode: CoordinatorMode }
  | { type: "maxTurns"; value: number }
  | { type: "turns" }
  | { type: "eventFilter"; scope: UiEventScope | "all" }
  | { type: "eventOpen"; rank: number }
  | { type: "eventClose" }
  | { type: "eventNext" }
  | { type: "eventPrev" }
  | { type: "handoffDetails"; mode: "toggle" | "show" | "hide" }
  | { type: "handoffOpen"; rank: number }
  | { type: "handoffClose" }
  | { type: "reports" }
  | { type: "reportOpen"; rank: number }
  | { type: "reportClose" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "events" }
  | { type: "clearEvents" }
  | { type: "status" }
  | { type: "help" }
  | { type: "quit" };
