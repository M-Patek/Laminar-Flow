import readline from "node:readline";
import type { AgentId } from "../types/agent.ts";
import type { AppSnapshot } from "../types/app.ts";
import type { StateStore } from "../core/state/StateStore.ts";
import type { CommandExecutionResult, UiEffect } from "../commands/executeCommand.ts";
import { buildFrame } from "./format.ts";
import {
  selectEventByOffset,
  selectEventByRank,
  selectHandoffByOffset,
  selectHandoffByRank,
  type SelectedUiEntry
} from "./inspection.ts";
import {
  selectReportByOffset,
  selectReportByRank,
  type VerificationReportEntry
} from "./reports.ts";

export interface TerminalUiOptions {
  onSubmit: (input: string, focusedPane: AgentId) => Promise<CommandExecutionResult>;
  onExit: () => Promise<void>;
}

interface TerminalUiState {
  focusedPane: AgentId;
  eventFilter: "all" | AppSnapshot["recentEvents"][number]["scope"];
  eventPage: number;
  showHandoffDetails: boolean;
  inputMode: "direct" | "command";
  reports: VerificationReportEntry[];
  selectedEvent?: SelectedUiEntry;
  selectedHandoff?: SelectedUiEntry;
  selectedReport?: SelectedUiEntry;
}

export class TerminalUi {
  private commandBuffer = "";
  private readonly drafts: Record<AgentId, string> = {
    left: "",
    right: ""
  };
  private notice = "Tab focus | F2 input mode | F3/F4/F7 open | F5/F6 browse | PgUp/PgDn events.";
  private snapshot: AppSnapshot;
  private readonly unsubscribe: () => void;
  private readonly options: TerminalUiOptions;
  private readonly closed: Promise<void>;
  private closeResolver!: () => void;
  private readonly uiState: TerminalUiState = {
    focusedPane: "left",
    eventFilter: "all",
    eventPage: 0,
    showHandoffDetails: false,
    inputMode: "direct",
    reports: [],
    selectedEvent: undefined,
    selectedHandoff: undefined,
    selectedReport: undefined
  };

  constructor(store: StateStore, options: TerminalUiOptions) {
    this.options = options;
    this.snapshot = store.getSnapshot();
    this.closed = new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
    this.unsubscribe = store.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.render();
    });
  }

  start(): void {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.resume();
    process.stdin.on("keypress", this.handleKeypress);
    process.stdout.on("resize", this.handleResize);
    this.render();
  }

  async stop(): Promise<void> {
    this.unsubscribe();
    process.stdin.off("keypress", this.handleKeypress);
    process.stdout.off("resize", this.handleResize);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    process.stdin.pause();
    process.stdout.write("\u001B[?25h\u001B[0m\n");
    await this.options.onExit();
    this.closeResolver();
  }

  waitUntilClosed(): Promise<void> {
    return this.closed;
  }

  private readonly handleResize = (): void => {
    this.render();
  };

  private readonly handleKeypress = async (_: string, key: readline.Key): Promise<void> => {
    if (key.ctrl && key.name === "c") {
      await this.shutdown();
      return;
    }

    if (key.name === "f2") {
      this.uiState.inputMode = this.uiState.inputMode === "direct" ? "command" : "direct";
      this.notice = `Input mode switched to ${this.uiState.inputMode}.`;
      this.render();
      return;
    }

    if (key.name === "f3") {
      this.notice = this.toggleEventInspection();
      this.render();
      return;
    }

    if (key.name === "f4") {
      this.notice = this.toggleHandoffInspection();
      this.render();
      return;
    }

    if (key.name === "f5") {
      this.notice = this.moveInspection(1);
      this.render();
      return;
    }

    if (key.name === "f6") {
      this.notice = this.moveInspection(-1);
      this.render();
      return;
    }

    if (key.name === "f7") {
      this.notice = this.toggleReportInspection();
      this.render();
      return;
    }

    if (key.name === "pageup") {
      this.uiState.eventPage += 1;
      this.notice = "Moved to an older event page.";
      this.render();
      return;
    }

    if (key.name === "pagedown") {
      this.uiState.eventPage = Math.max(0, this.uiState.eventPage - 1);
      this.notice = this.uiState.eventPage === 0 ? "Moved to the newest event page." : "Moved to a newer event page.";
      this.render();
      return;
    }

    if (key.name === "return") {
      const currentInput = this.getActiveBuffer().trim();
      if (!currentInput) {
        return;
      }

      if (this.uiState.inputMode === "command" && !currentInput.startsWith("/")) {
        this.notice = "Command mode expects /commands. Use /input-mode direct to send plain text.";
        this.render();
        return;
      }

      try {
        const result = await this.options.onSubmit(currentInput, this.uiState.focusedPane);
        this.clearActiveBuffer();
        const noticeOverride = this.applyUiEffects(result.uiEffects ?? []);
        this.notice = noticeOverride ?? result.message;
        this.render();
        if (result.shouldExit) {
          await this.shutdown();
        }
      } catch (error) {
        this.notice = error instanceof Error ? error.message : String(error);
        this.render();
      }
      return;
    }

    if (key.name === "backspace") {
      this.setActiveBuffer(this.getActiveBuffer().slice(0, -1));
      this.render();
      return;
    }

    if (key.name === "tab") {
      this.uiState.focusedPane = nextPane(this.uiState.focusedPane);
      this.notice = `Focused ${this.uiState.focusedPane} pane.`;
      this.render();
      return;
    }

    if (key.name === "escape") {
      if (this.getActiveBuffer()) {
        this.clearActiveBuffer();
        this.notice = "Cleared current input.";
      } else if (this.uiState.selectedEvent) {
        this.uiState.selectedEvent = undefined;
        this.notice = "Closed event detail.";
      } else if (this.uiState.showHandoffDetails) {
        this.uiState.selectedHandoff = undefined;
        this.uiState.showHandoffDetails = false;
        this.notice = "Closed handoff detail.";
      } else if (this.uiState.selectedReport) {
        this.uiState.selectedReport = undefined;
        this.notice = "Closed report detail.";
      } else {
        this.notice = "Nothing to clear.";
      }
      this.render();
      return;
    }

    if (key.sequence && !key.ctrl && !key.meta && key.sequence >= " ") {
      this.setActiveBuffer(`${this.getActiveBuffer()}${key.sequence}`);
      this.render();
    }
  };

  private async shutdown(): Promise<void> {
    await this.stop();
    process.exit(0);
  }

  private render(): void {
    const frame = buildFrame(
      this.snapshot,
      {
        ...this.uiState,
        drafts: this.drafts,
        commandBuffer: this.commandBuffer
      },
      this.notice,
      process.stdout.columns || 120,
      process.stdout.rows || 32
    );
    process.stdout.write(frame);
  }

  private applyUiEffects(effects: UiEffect[]): string | undefined {
    let noticeOverride: string | undefined;

    for (const effect of effects) {
      switch (effect.type) {
        case "setEventFilter":
          this.uiState.eventFilter = effect.scope;
          this.uiState.eventPage = 0;
          break;
        case "openEvent": {
          const selection = selectEventByRank(this.snapshot, this.uiState.eventFilter, effect.rank);
          if (selection) {
            this.uiState.selectedEvent = selection;
          } else {
            noticeOverride = `No event #${effect.rank} exists for filter ${this.uiState.eventFilter}.`;
          }
          break;
        }
        case "closeEvent":
          this.uiState.selectedEvent = undefined;
          break;
        case "changeEventPage":
          this.uiState.eventPage = Math.max(0, this.uiState.eventPage + effect.delta);
          break;
        case "toggleHandoffDetails":
          if (effect.mode === "show") {
            this.uiState.showHandoffDetails = true;
            this.uiState.selectedHandoff = undefined;
          } else if (effect.mode === "hide") {
            this.uiState.showHandoffDetails = false;
            this.uiState.selectedHandoff = undefined;
          } else {
            this.uiState.showHandoffDetails = !this.uiState.showHandoffDetails;
          }
          break;
        case "openHandoff": {
          const selection = selectHandoffByRank(this.snapshot, effect.rank);
          if (selection) {
            this.uiState.selectedHandoff = selection;
            this.uiState.showHandoffDetails = true;
          } else {
            noticeOverride = `No handoff #${effect.rank} is available yet.`;
          }
          break;
        }
        case "closeHandoff":
          this.uiState.selectedHandoff = undefined;
          this.uiState.showHandoffDetails = false;
          break;
        case "setReports":
          this.uiState.reports = effect.reports;
          if (
            this.uiState.selectedReport &&
            !this.uiState.reports.some((report) => report.id === this.uiState.selectedReport?.id)
          ) {
            this.uiState.selectedReport = undefined;
          }
          break;
        case "openReport": {
          const selection = selectReportByRank(this.uiState.reports, effect.rank);
          if (selection) {
            this.uiState.selectedReport = selection;
          } else {
            noticeOverride = `No report #${effect.rank} is available yet.`;
          }
          break;
        }
        case "closeReport":
          this.uiState.selectedReport = undefined;
          break;
        case "setFocus":
          this.uiState.focusedPane =
            effect.target === "next" ? nextPane(this.uiState.focusedPane) : effect.target;
          break;
        case "setInputMode":
          this.uiState.inputMode = effect.mode;
          break;
      }
    }

    return noticeOverride;
  }

  private getActiveBuffer(): string {
    return this.uiState.inputMode === "command"
      ? this.commandBuffer
      : this.drafts[this.uiState.focusedPane];
  }

  private setActiveBuffer(value: string): void {
    if (this.uiState.inputMode === "command") {
      this.commandBuffer = value;
      return;
    }

    this.drafts[this.uiState.focusedPane] = value;
  }

  private clearActiveBuffer(): void {
    this.setActiveBuffer("");
  }

  private toggleEventInspection(): string {
    if (this.uiState.selectedEvent) {
      this.uiState.selectedEvent = undefined;
      return "Closed event detail.";
    }

    const selection = selectEventByRank(this.snapshot, this.uiState.eventFilter, 1);
    if (!selection) {
      return `No event is available for filter ${this.uiState.eventFilter}.`;
    }

    this.uiState.selectedEvent = selection;
    return `Inspecting newest ${this.uiState.eventFilter} event.`;
  }

  private toggleHandoffInspection(): string {
    if (this.uiState.showHandoffDetails) {
      this.uiState.selectedHandoff = undefined;
      this.uiState.showHandoffDetails = false;
      return "Closed handoff detail.";
    }

    const selection = selectHandoffByRank(this.snapshot, 1);
    if (!selection) {
      return "No handoff is available yet.";
    }

    this.uiState.selectedHandoff = selection;
    this.uiState.showHandoffDetails = true;
    return "Inspecting newest handoff.";
  }

  private moveInspection(offset: -1 | 1): string {
    if (this.uiState.selectedEvent) {
      const nextSelection = selectEventByOffset(
        this.snapshot,
        this.uiState.eventFilter,
        this.uiState.selectedEvent.rank,
        offset
      );
      if (!nextSelection) {
        return offset > 0 ? "Already at the oldest matching event." : "Already at the newest matching event.";
      }

      this.uiState.selectedEvent = nextSelection;
      return `Inspecting event #${nextSelection.rank}.`;
    }

    if (this.uiState.showHandoffDetails) {
      const currentRank = this.uiState.selectedHandoff?.rank ?? 1;
      const nextSelection = selectHandoffByOffset(this.snapshot, currentRank, offset);
      if (!nextSelection) {
        return offset > 0 ? "Already at the oldest handoff." : "Already at the newest handoff.";
      }

      this.uiState.selectedHandoff = nextSelection;
      return `Inspecting handoff #${nextSelection.rank}.`;
    }

    if (this.uiState.selectedReport) {
      const nextSelection = selectReportByOffset(this.uiState.reports, this.uiState.selectedReport.rank, offset);
      if (!nextSelection) {
        return offset > 0 ? "Already at the oldest report." : "Already at the newest report.";
      }

      this.uiState.selectedReport = nextSelection;
      return `Inspecting report #${nextSelection.rank}.`;
    }

    return "No inspection panel is open.";
  }

  private toggleReportInspection(): string {
    if (this.uiState.selectedReport) {
      this.uiState.selectedReport = undefined;
      return "Closed report detail.";
    }

    const selection = selectReportByRank(this.uiState.reports, 1);
    if (!selection) {
      return "No verification report is available yet. Use /reports to refresh the index.";
    }

    this.uiState.selectedReport = selection;
    return "Inspecting newest verification report.";
  }
}

function nextPane(current: AgentId): AgentId {
  return current === "left" ? "right" : "left";
}
