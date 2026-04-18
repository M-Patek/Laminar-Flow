import type { AgentId } from "../types/agent.ts";
import type { UiEventScope } from "../types/app.ts";
import type { CoordinatorMode } from "../types/coordinator.ts";
import type { ParsedCommand } from "./command-types.ts";

export function parseCommand(input: string, defaultTarget: AgentId = "left"): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty command.");
  }

  if (!trimmed.startsWith("/")) {
    return {
      type: "send",
      target: defaultTarget,
      body: trimmed
    };
  }

  const [command, ...rest] = trimmed.slice(1).split(" ");
  const body = rest.join(" ").trim();

  switch (command) {
    case "left":
    case "right":
      ensureBody(body, command);
      return {
        type: "send",
        target: command as AgentId,
        body
      };
    case "both":
      ensureBody(body, command);
      return {
        type: "broadcast",
        body
      };
    case "focus":
      return {
        type: "focus",
        target: ensureFocusTarget(rest[0])
      };
    case "input-mode":
      return {
        type: "inputMode",
        mode: ensureInputMode(rest[0])
      };
    case "step":
      ensureAgent(rest[0], "/step");
      return {
        type: "step",
        target: rest[0] as AgentId
      };
    case "takeover":
      ensureAgent(rest[0], "/takeover");
      return {
        type: "takeover",
        target: rest[0] as AgentId
      };
    case "release":
      ensureAgent(rest[0], "/release");
      return {
        type: "release",
        target: rest[0] as AgentId
      };
    case "retry":
      if (rest[0]) {
        ensureAgent(rest[0], "/retry");
        return {
          type: "retry",
          target: rest[0] as AgentId
        };
      }
      return {
        type: "retry"
      };
    case "continue":
      return {
        type: "retry"
      };
    case "reset":
      ensureAgent(rest[0], "/reset");
      return {
        type: "reset",
        target: rest[0] as AgentId
      };
    case "handoff":
      ensureAgent(rest[0], "/handoff");
      return {
        type: "handoff",
        from: rest[0] as AgentId
      };
    case "mode":
      ensureMode(rest[0]);
      return {
        type: "mode",
        mode: rest[0] as CoordinatorMode
      };
    case "event-filter":
      return {
        type: "eventFilter",
        scope: ensureEventScope(rest[0])
      };
    case "event-open":
      return {
        type: "eventOpen",
        rank: ensurePositiveInteger(rest[0], "/event-open")
      };
    case "event-close":
      return { type: "eventClose" };
    case "event-next":
      return { type: "eventNext" };
    case "event-prev":
      return { type: "eventPrev" };
    case "handoff-details":
      return {
        type: "handoffDetails",
        mode: ensureToggleMode(rest[0])
      };
    case "handoff-open":
      return {
        type: "handoffOpen",
        rank: rest[0] ? ensurePositiveInteger(rest[0], "/handoff-open") : 1
      };
    case "handoff-close":
      return { type: "handoffClose" };
    case "reports":
      return { type: "reports" };
    case "report-open":
      return {
        type: "reportOpen",
        rank: rest[0] ? ensurePositiveInteger(rest[0], "/report-open") : 1
      };
    case "report-close":
      return { type: "reportClose" };
    case "max-turns":
      return {
        type: "maxTurns",
        value: ensureNonNegativeInteger(rest[0], "/max-turns")
      };
    case "turns":
      return { type: "turns" };
    case "pause":
      return { type: "pause" };
    case "resume":
      if (rest[0]) {
        ensureAgent(rest[0], "/resume");
        return {
          type: "resumeAgent",
          target: rest[0] as AgentId
        };
      }
      return { type: "resume" };
    case "events":
      return { type: "events" };
    case "clear-events":
      return { type: "clearEvents" };
    case "status":
      return { type: "status" };
    case "help":
      return { type: "help" };
    case "quit":
      return { type: "quit" };
    default:
      throw new Error(`Unknown command: /${command}`);
  }
}

function ensureBody(body: string, command: string): void {
  if (!body) {
    throw new Error(`/${command} requires text.`);
  }
}

function ensureAgent(value: string | undefined, command: string): void {
  if (value !== "left" && value !== "right") {
    throw new Error(`${command} requires 'left' or 'right'.`);
  }
}

function ensureMode(value: string | undefined): void {
  if (value !== "manual" && value !== "step" && value !== "auto") {
    throw new Error("/mode requires manual, step, or auto.");
  }
}

function ensureNonNegativeInteger(value: string | undefined, command: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${command} requires a non-negative integer.`);
  }

  return Number.parseInt(value, 10);
}

function ensurePositiveInteger(value: string | undefined, command: string): number {
  const parsed = ensureNonNegativeInteger(value, command);
  if (parsed < 1) {
    throw new Error(`${command} requires an integer greater than 0.`);
  }

  return parsed;
}

function ensureEventScope(value: string | undefined): UiEventScope | "all" {
  if (!value || value === "all" || value === "system" || value === "agent" || value === "coordinator" || value === "message") {
    return (value ?? "all") as UiEventScope | "all";
  }

  throw new Error("/event-filter requires all, system, agent, coordinator, or message.");
}

function ensureToggleMode(value: string | undefined): "toggle" | "show" | "hide" {
  if (!value || value === "toggle") {
    return "toggle";
  }

  if (value === "show" || value === "hide") {
    return value;
  }

  throw new Error("/handoff-details accepts show, hide, or no value.");
}

function ensureFocusTarget(value: string | undefined): AgentId | "next" {
  if (!value || value === "next") {
    return "next";
  }

  if (value === "left" || value === "right") {
    return value;
  }

  throw new Error("/focus accepts left, right, or next.");
}

function ensureInputMode(value: string | undefined): "direct" | "command" {
  if (value === "direct" || value === "command") {
    return value;
  }

  throw new Error("/input-mode requires direct or command.");
}
