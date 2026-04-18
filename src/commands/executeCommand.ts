import type { Coordinator } from "../core/coordination/Coordinator.ts";
import type { UiEventScope } from "../types/app.ts";
import type { VerificationReportEntry } from "../ui/reports.ts";
import { loadVerificationReports } from "../ui/reports.ts";
import type { ParsedCommand } from "./command-types.ts";

export interface CommandExecutionResult {
  message: string;
  shouldExit: boolean;
  uiEffects?: UiEffect[];
}

export type UiEffect =
  | { type: "setEventFilter"; scope: UiEventScope | "all" }
  | { type: "openEvent"; rank: number }
  | { type: "closeEvent" }
  | { type: "changeEventPage"; delta: number }
  | { type: "toggleHandoffDetails"; mode: "toggle" | "show" | "hide" }
  | { type: "openHandoff"; rank: number }
  | { type: "closeHandoff" }
  | { type: "setReports"; reports: VerificationReportEntry[] }
  | { type: "openReport"; rank: number }
  | { type: "closeReport" }
  | { type: "setFocus"; target: "left" | "right" | "next" }
  | { type: "setInputMode"; mode: "direct" | "command" };

const HELP_TEXT = [
  "/left <text>",
  "/right <text>",
  "/both <text>",
  "/focus [left|right|next]",
  "/input-mode direct|command",
  "/step left|right",
  "/takeover left|right",
  "/release left|right",
  "/retry [left|right]",
  "/continue",
  "/reset left|right",
  "/handoff left|right",
  "/mode manual|step|auto",
  "/event-filter [all|system|agent|coordinator|message]",
  "/event-open <n>",
  "/event-close",
  "/event-next",
  "/event-prev",
  "/handoff-details [show|hide]",
  "/handoff-open [n]",
  "/handoff-close",
  "/reports",
  "/report-open [n]",
  "/report-close",
  "/max-turns <n>",
  "/turns",
  "/pause",
  "/resume",
  "/resume left|right",
  "/events",
  "/clear-events",
  "/status",
  "/help",
  "/quit"
].join(" | ");

export async function executeCommand(
  coordinator: Coordinator,
  command: ParsedCommand,
  options?: {
    workspaceDir?: string;
  }
): Promise<CommandExecutionResult> {
  const workspaceDir = options?.workspaceDir ?? process.cwd();

  switch (command.type) {
    case "send":
      return {
        message: await coordinator.sendUserMessage(command.target, command.body),
        shouldExit: false
      };
    case "broadcast":
      return {
        message: await coordinator.broadcast(command.body),
        shouldExit: false
      };
    case "focus":
      return {
        message:
          command.target === "next"
            ? "Moved focus to the other pane."
            : `Focused ${command.target} pane.`,
        shouldExit: false,
        uiEffects: [{ type: "setFocus", target: command.target }]
      };
    case "inputMode":
      return {
        message: `Input mode set to ${command.mode}.`,
        shouldExit: false,
        uiEffects: [{ type: "setInputMode", mode: command.mode }]
      };
    case "step":
      return {
        message: await coordinator.advanceAgent(command.target),
        shouldExit: false
      };
    case "takeover":
      return {
        message: await coordinator.takeoverAgent(command.target),
        shouldExit: false,
        uiEffects: [
          { type: "setFocus", target: command.target },
          { type: "setInputMode", mode: "direct" }
        ]
      };
    case "release":
      return {
        message: await coordinator.releaseAgent(command.target),
        shouldExit: false
      };
    case "retry":
      return {
        message: await coordinator.retryAgent(command.target),
        shouldExit: false
      };
    case "resumeAgent":
      return {
        message: await coordinator.resumeAgent(command.target),
        shouldExit: false
      };
    case "reset":
      return {
        message: await coordinator.resetAgent(command.target),
        shouldExit: false
      };
    case "handoff":
      return {
        message: await coordinator.handoff(command.from),
        shouldExit: false
      };
    case "mode":
      return {
        message: await coordinator.setMode(command.mode),
        shouldExit: false
      };
    case "eventFilter":
      return {
        message: `Event filter set to ${command.scope}.`,
        shouldExit: false,
        uiEffects: [{ type: "setEventFilter", scope: command.scope }]
      };
    case "eventOpen":
      return {
        message: `Inspecting event #${command.rank}.`,
        shouldExit: false,
        uiEffects: [{ type: "openEvent", rank: command.rank }]
      };
    case "eventClose":
      return {
        message: "Closed event detail view.",
        shouldExit: false,
        uiEffects: [{ type: "closeEvent" }]
      };
    case "eventNext":
      return {
        message: "Moved to older event page.",
        shouldExit: false,
        uiEffects: [{ type: "changeEventPage", delta: 1 }]
      };
    case "eventPrev":
      return {
        message: "Moved to newer event page.",
        shouldExit: false,
        uiEffects: [{ type: "changeEventPage", delta: -1 }]
      };
    case "handoffDetails":
      return {
        message:
          command.mode === "show"
            ? "Expanded handoff details."
            : command.mode === "hide"
              ? "Collapsed handoff details."
              : "Toggled handoff details.",
        shouldExit: false,
        uiEffects: [{ type: "toggleHandoffDetails", mode: command.mode }]
      };
    case "handoffOpen":
      return {
        message: `Inspecting handoff #${command.rank}.`,
        shouldExit: false,
        uiEffects: [{ type: "openHandoff", rank: command.rank }]
      };
    case "handoffClose":
      return {
        message: "Closed handoff detail view.",
        shouldExit: false,
        uiEffects: [{ type: "closeHandoff" }]
      };
    case "reports": {
      const reports = await loadVerificationReports(workspaceDir);
      return {
        message:
          reports.length === 0
            ? "No verification reports found."
            : `Reports: ${reports
                .slice(0, 4)
                .map((report, index) => `[#${index + 1}] ${report.name} (${report.kind})`)
                .join(" | ")}`,
        shouldExit: false,
        uiEffects: [{ type: "setReports", reports }]
      };
    }
    case "reportOpen": {
      const reports = await loadVerificationReports(workspaceDir);
      return {
        message:
          reports.length === 0
            ? "No verification reports found."
            : `Inspecting report #${command.rank}.`,
        shouldExit: false,
        uiEffects:
          reports.length === 0
            ? [{ type: "setReports", reports }]
            : [{ type: "setReports", reports }, { type: "openReport", rank: command.rank }]
      };
    }
    case "reportClose":
      return {
        message: "Closed report detail view.",
        shouldExit: false,
        uiEffects: [{ type: "closeReport" }]
      };
    case "maxTurns":
      return {
        message: await coordinator.setMaxTurns(command.value),
        shouldExit: false
      };
    case "turns":
      return {
        message: await coordinator.turns(),
        shouldExit: false
      };
    case "pause":
      return {
        message: await coordinator.pause(),
        shouldExit: false
      };
    case "resume":
      return {
        message: await coordinator.resume(),
        shouldExit: false
      };
    case "status":
      return {
        message: await coordinator.status(),
        shouldExit: false
      };
    case "events":
      return {
        message: await coordinator.events(),
        shouldExit: false
      };
    case "clearEvents":
      return {
        message: await coordinator.clearEvents(),
        shouldExit: false
      };
    case "help":
      return {
        message: HELP_TEXT,
        shouldExit: false
      };
    case "quit":
      return {
        message: "Shutting down.",
        shouldExit: true
      };
  }
}
