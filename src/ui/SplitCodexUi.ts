import readline from "node:readline";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConfiguredBrokerClient
} from "../app/brokerClient.ts";
import {
  type InteractiveBackendId,
  type InteractiveCliBackend
} from "../backends/interactiveCliBackend.ts";
import { InteractiveSessionStateStore, type InteractiveSessionState } from "../backends/InteractiveSessionState.ts";
import type { BrokerClient } from "../app/brokerClient.ts";
import { buildPaneLines, fillRenderLines, formatPaneLine, padPlain, type RenderLine } from "./render/PaneRenderer.ts";
import { DuplexRuntime, type PaneHandle, type PaneId, type PaneRole } from "../runtime/DuplexRuntime.ts";

type FocusTarget = "left" | "right" | "control";
type MouseMode = "ui" | "select";

interface SplitCodexUiOptions {
  workspaceDir: string;
  maxTurns?: number;
  newSession?: boolean;
  interactiveBackend?: InteractiveBackendId;
  leftInteractiveBackend?: InteractiveBackendId;
  rightInteractiveBackend?: InteractiveBackendId;
  onExit?: () => Promise<void>;
}

export class SplitCodexUi {
  private readonly workspaceDir: string;
  private readonly onExit?: () => Promise<void>;
  private readonly broker: BrokerClient;
  private readonly newSession: boolean;
  private readonly defaultInteractiveBackendId?: InteractiveBackendId;
  private readonly explicitPaneBackendIds: Partial<Record<PaneId, InteractiveBackendId>>;
  private readonly sessionStateStore: InteractiveSessionStateStore;
  private readonly closed: Promise<void>;
  private closeResolver!: () => void;
  private readonly panes = new Map<PaneId, PaneHandle>();
  private readonly toolBinDir = resolveToolBinDir();
  private readonly paneBackends = new Map<PaneId, InteractiveCliBackend>();
  private readonly paneRoles: Record<PaneId, PaneRole> = {
    left: "lead",
    right: "support"
  };
  private readonly paneOffsets: Record<PaneId, number> = {
    left: 0,
    right: 0
  };
  private readonly pinnedViewportStart: Partial<Record<PaneId, number>> = {};
  private focus: FocusTarget = "left";
  private lastPaneFocus: PaneId = "left";
  private commandBuffer = "";
  private controlNotice = "";
  private notice = "Click switch panes | Right-click/Ctrl+V paste | Tab select text | F1 control | Wheel/PgUp/PgDn scroll";
  private renderQueued = false;
  private stopped = false;
  private lastFrame = "";
  private suppressMouseKeypressUntil = 0;
  private mailboxTimer?: NodeJS.Timeout;
  private readonly mailboxDeliveryInFlight = new Set<string>();
  private readonly paneSessionDiscoveryInFlight = new Set<PaneId>();
  private readonly paneSessionDiscoveryQueue: Partial<Record<InteractiveBackendId, Promise<void>>> = {};
  private readonly paneSessionIds: Partial<Record<PaneId, string>> = {};
  private readonly paneSessionBaselines: Partial<Record<PaneId, string[]>> = {};
  private interactiveSessionState: InteractiveSessionState = { panes: {} };
  private readonly runtime: DuplexRuntime;
  private recentMailboxDeliveryAt = 0;
  private readonly idleTimers: Partial<Record<PaneId, NodeJS.Timeout>> = {};
  private readonly recentPaneActivityAt: Record<PaneId, number> = { left: 0, right: 0 };
  private readonly recentUserInputAt: Record<PaneId, number> = { left: 0, right: 0 };
  private maxTurns = 8;
  private deliveredTurns = 0;
  private mailboxCache = {
    at: 0,
    leftUnread: 0,
    rightUnread: 0
  };
  private brokerHint = "broker:pending none";
  private mouseMode: MouseMode = "ui";
  private deliveryPaused = true;

  constructor(options: SplitCodexUiOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onExit = options.onExit;
    this.broker = createConfiguredBrokerClient(this.workspaceDir);
    this.newSession = options.newSession ?? false;
    this.defaultInteractiveBackendId = options.interactiveBackend;
    this.explicitPaneBackendIds = {
      left: options.leftInteractiveBackend,
      right: options.rightInteractiveBackend
    };
    this.sessionStateStore = new InteractiveSessionStateStore(this.workspaceDir);
    if (options.maxTurns !== undefined) {
      this.maxTurns = options.maxTurns;
    }
    this.deliveryPaused = !this.newSession;
    this.runtime = new DuplexRuntime({
      workspaceDir: this.workspaceDir,
      newSession: this.newSession,
      toolBinDir: this.toolBinDir,
      broker: this.broker,
      defaultInteractiveBackendId: this.defaultInteractiveBackendId,
      explicitPaneBackendIds: this.explicitPaneBackendIds,
      paneRoles: this.paneRoles,
      state: {
        panes: this.panes,
        paneBackends: this.paneBackends,
        mailboxDeliveryInFlight: this.mailboxDeliveryInFlight,
        idleTimers: this.idleTimers,
        paneSessionDiscoveryInFlight: this.paneSessionDiscoveryInFlight,
        paneSessionDiscoveryQueue: this.paneSessionDiscoveryQueue,
        paneSessionIds: this.paneSessionIds,
        paneSessionBaselines: this.paneSessionBaselines,
        recentPaneActivityAt: this.recentPaneActivityAt,
        recentUserInputAt: this.recentUserInputAt
      },
      callbacks: {
        getInteractiveSessionState: () => this.interactiveSessionState,
        setInteractiveSessionState: (state) => {
          this.interactiveSessionState = state;
        },
        saveInteractiveSessionState: (state) => this.sessionStateStore.save(state),
        getDeliveryPaused: () => this.deliveryPaused,
        setDeliveryPaused: (value) => {
          this.deliveryPaused = value;
        },
        getDeliveredTurns: () => this.deliveredTurns,
        setDeliveredTurns: (value) => {
          this.deliveredTurns = value;
        },
        getMaxTurns: () => this.maxTurns,
        getRecentMailboxDeliveryAt: () => this.recentMailboxDeliveryAt,
        setRecentMailboxDeliveryAt: (value) => {
          this.recentMailboxDeliveryAt = value;
        },
        setMailboxCache: (value) => {
          this.mailboxCache = value;
        },
        getMailboxCache: () => this.mailboxCache,
        setBrokerHint: (value) => {
          this.brokerHint = value;
        },
        getLatestLineIndex: (id) => this.getLatestLineIndex(id),
        preserveScrolledViewport: (id, previousLatestLine) => this.preserveScrolledViewport(id, previousLatestLine),
        queueRender: () => this.queueRender(),
        renderNow: () => this.safeRender(),
        reportError: (scope, error) => this.reportError(scope, error),
        setNotice: (message) => {
          this.notice = message;
        },
        getPaneDimensions: () => this.getPaneDimensions()
      }
    });
    this.closed = new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
  }

  async start(): Promise<void> {
    this.interactiveSessionState = this.newSession ? { panes: {} } : await this.sessionStateStore.load();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdout.write("\u001B[?1049h\u001B[H\u001B[2J");
    this.setMouseMode("ui");
    process.stdin.resume();
    process.stdin.on("data", this.handleRawInput);
    process.stdin.on("keypress", this.handleKeypress);
    process.stdout.on("resize", this.handleResize);
    if (this.newSession) {
      await this.broker.resetBrokerState();
      this.deliveryPaused = false;
      await this.sessionStateStore.save(this.interactiveSessionState);
    }
    this.mailboxCache = { at: Date.now(), leftUnread: 0, rightUnread: 0 };
    this.deliveredTurns = 0;

    this.notice = this.deliveryPaused
      ? "Session restored. Delivery is paused; use /resume when you are ready."
      : "Automatic delivery is live.";

    const { paneCols, paneRows } = this.getPaneDimensions();
    this.render();
    await Promise.all([
      this.startPane("left", paneCols, paneRows),
      this.startPane("right", paneCols, paneRows)
    ]);
    this.mailboxTimer = setInterval(() => {
      void this.refreshBrokerCache();
      void this.pollMailboxDeliveries();
    }, 700);
    void Promise.all([
      this.broker.upsertPeerState({ id: "left", role: this.paneRoles.left, status: "idle" }),
      this.broker.upsertPeerState({ id: "right", role: this.paneRoles.right, status: "idle" })
    ]).catch((error) => {
      this.reportError("peer-state-init", error);
    });
    this.render();
  }

  waitUntilClosed(): Promise<void> {
    return this.closed;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    process.stdin.off("data", this.handleRawInput);
    process.stdin.off("keypress", this.handleKeypress);
    process.stdout.off("resize", this.handleResize);
    if (this.mailboxTimer) {
      clearInterval(this.mailboxTimer);
      this.mailboxTimer = undefined;
    }
    for (const timer of Object.values(this.idleTimers)) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    process.stdin.pause();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    await Promise.all(Array.from(this.panes.values(), (pane) => this.interruptAndKillPane(pane)));

    await this.broker.upsertPeerState({ id: "left", status: "waiting" });
    await this.broker.upsertPeerState({ id: "right", status: "waiting" });
    this.setMouseMode("select");
    process.stdout.write("\u001B[?25h\u001B[0m\u001B[?1049l");
    await this.onExit?.();
    this.closeResolver();
  }

  private readonly handleResize = (): void => {
    try {
      const { paneCols, paneRows } = this.getPaneDimensions();
      for (const pane of this.panes.values()) {
        try {
          pane.terminal.resize(paneCols, paneRows);
          pane.pty.resize(paneCols, paneRows);
          this.paneOffsets[pane.id] = Math.min(
            this.paneOffsets[pane.id],
            this.getMaxOffset(pane.id, paneRows)
          );
        } catch (error) {
          this.reportError(`resize:${pane.id}`, error);
        }
      }

      this.safeRender();
    } catch (error) {
      this.reportError("resize", error);
    }
  };

  private readonly handleKeypress = async (input: string, key: readline.Key): Promise<void> => {
    if (isMouseSequence(key.sequence ?? input)) {
      return;
    }

    if (this.shouldSuppressMouseLeak(input, key)) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      await this.stop();
      process.exit(0);
      return;
    }

    if (key.ctrl && key.name === "v") {
      this.pasteClipboardIntoFocus();
      return;
    }

    if (key.name === "tab" && key.shift && this.focus !== "control") {
      void this.notePeerActivity(this.focus, "busy");
      this.panes.get(this.focus)?.pty.write("\u001B[Z");
      return;
    }

    if (key.name === "tab") {
      this.toggleMouseMode();
      return;
    }

    if (this.mouseMode === "select" && this.focus !== "control" && (key.name === "up" || key.name === "down")) {
      return;
    }

    if (key.name === "f1") {
      if (this.focus === "control") {
        this.focus = this.lastPaneFocus;
        this.notice = `Returned to ${this.focus}.`;
      } else {
        this.focus = "control";
        this.controlNotice = this.controlNotice || "Control focus. /help shows commands.";
        this.notice = this.deliveryPaused ? "Control focus. Delivery is paused; use /resume when ready." : "Control focus. /help shows commands.";
      }
      this.safeRender();
      return;
    }

    if (this.focus === "control") {
      await this.handleControlKeypress(input, key);
      return;
    }

    if (key.name === "pageup") {
      this.adjustPaneOffset(this.focus, this.getScrollStep(), "older");
      return;
    }

    if (key.name === "pagedown") {
      this.adjustPaneOffset(this.focus, -this.getScrollStep(), "newer");
      return;
    }

    if (key.name === "home") {
      this.paneOffsets[this.focus] = this.getMaxOffset(this.focus, this.getPaneDimensions().paneRows);
      this.notice = `${this.focus} scrolled to the oldest buffered content.`;
      this.safeRender();
      return;
    }

    if (key.name === "end") {
      this.paneOffsets[this.focus] = 0;
      this.notice = `${this.focus} returned to the latest content.`;
      this.safeRender();
      return;
    }

    const sequence = toPtySequence(input, key);
    if (sequence) {
      this.recentUserInputAt[this.focus] = Date.now();
      void this.notePeerActivity(this.focus, "busy");
      this.panes.get(this.focus)?.pty.write(sequence);
    }
  };

  private readonly handleRawInput = (chunk: Buffer | string): void => {
    if (this.mouseMode !== "ui") {
      return;
    }

    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (containsMouseSequence(text)) {
      this.suppressMouseKeypressUntil = Date.now() + 80;
    }

    for (const event of parseMouseEvents(text)) {
      if (event.kind === "wheel") {
        const target = this.resolvePaneTarget(event.column, event.row);
        if (!target) {
          continue;
        }

        const step = 2;
        if (event.direction === "up") {
          this.adjustPaneOffset(target, step, "older");
        } else {
          this.adjustPaneOffset(target, -step, "newer");
        }
        continue;
      }

      if (event.kind === "click") {
        const focusTarget = this.resolvePaneTarget(event.column, event.row);
        if (!focusTarget) {
          continue;
        }

        this.focus = focusTarget;
        this.lastPaneFocus = focusTarget;
        this.notice = `Focused ${focusTarget} pane. F1 opens the control line.`;
        this.safeRender();
        continue;
      }

      if (event.kind === "rightClick") {
        this.pasteClipboardIntoFocus();
      }
    }
  };

  private async handleControlKeypress(input: string, key: readline.Key): Promise<void> {
    if (key.name === "f1") {
      this.focus = this.lastPaneFocus;
      this.notice = `Returned to ${this.focus}.`;
      this.safeRender();
      return;
    }

    if (key.name === "tab" && !key.shift) {
      this.focus = this.lastPaneFocus;
      this.notice = `Returned to ${this.focus}.`;
      this.safeRender();
      return;
    }

    if (key.name === "escape") {
      if (this.commandBuffer) {
        this.commandBuffer = "";
        this.notice = "Cleared control input.";
      } else {
        this.focus = this.lastPaneFocus;
        this.notice = `Returned to ${this.focus}.`;
      }
      this.safeRender();
      return;
    }

    if (key.name === "backspace") {
      this.commandBuffer = this.commandBuffer.slice(0, -1);
      this.safeRender();
      return;
    }

    if (key.name === "return") {
      await this.executeControlCommand(this.commandBuffer.trim());
      this.commandBuffer = "";
      this.safeRender();
      return;
    }

    if (key.sequence && !key.ctrl && !key.meta && key.sequence >= " ") {
      this.commandBuffer += key.sequence;
      this.safeRender();
    }
  }

  private async executeControlCommand(command: string): Promise<void> {
    if (!command) {
      this.notice = "Control line is empty.";
      return;
    }

    if (!command.startsWith("/")) {
      this.notice = "Control mode accepts /commands only.";
      return;
    }

    const [name, ...rest] = command.slice(1).split(" ");
    const arg = rest.join(" ").trim();

    switch (name) {
      case "help":
        this.controlNotice =
          "Commands: /resume | /pause | /clear-mail | /restart left|right|both | /max-turns <n> | /turns | /status | /quit";
        this.notice = this.controlNotice;
        return;
      case "quit":
        this.notice = "Shutting down.";
        this.safeRender();
        await this.stop();
        process.exit(0);
        return;

      case "restart":
        if (arg === "left" || arg === "right") {
          this.restartPane(arg);
          this.controlNotice = `Restarted ${arg} pane.`;
          this.notice = this.controlNotice;
          return;
        }
        if (arg === "both") {
          this.restartPane("left");
          this.restartPane("right");
          this.controlNotice = "Restarted both panes.";
          this.notice = this.controlNotice;
          return;
        }
        this.controlNotice = "/restart requires left, right, or both.";
        this.notice = this.controlNotice;
        return;
      case "status":
        this.controlNotice = await this.buildRuntimeStatus();
        this.notice = this.controlNotice;
        return;
      case "resume":
        this.deliveryPaused = false;
        this.controlNotice = "Automatic delivery resumed.";
        this.notice = this.controlNotice;
        await this.refreshBrokerCache();
        return;
      case "pause":
        this.deliveryPaused = true;
        this.controlNotice = "Automatic delivery paused. Pane work stays manual until /resume.";
        this.notice = this.controlNotice;
        await this.refreshBrokerCache();
        return;
      case "clear-mail":
        await this.broker.resetBrokerState();
        this.deliveredTurns = 0;
        this.deliveryPaused = true;
        this.mailboxCache = { at: Date.now(), leftUnread: 0, rightUnread: 0 };
        await this.broker.upsertPeerState({ id: "left", role: this.paneRoles.left, status: this.panes.get("left")?.status === "running" ? "idle" : "waiting" });
        await this.broker.upsertPeerState({ id: "right", role: this.paneRoles.right, status: this.panes.get("right")?.status === "running" ? "idle" : "waiting" });
        this.controlNotice = "Cleared broker messages for this workspace and paused delivery.";
        this.notice = this.controlNotice;
        await this.refreshBrokerCache();
        return;
      case "max-turns": {
        const normalizedArg = normalizeCliInteger(arg);
        if (!normalizedArg) {
          this.controlNotice = "/max-turns requires a non-negative integer.";
          this.notice = this.controlNotice;
          return;
        }
        const value = Number.parseInt(normalizedArg, 10);
        if (!Number.isFinite(value) || value < 0) {
          this.controlNotice = "/max-turns requires a non-negative integer.";
          this.notice = this.controlNotice;
          return;
        }
        this.maxTurns = value;
        this.controlNotice = value === 0 ? "Turn limit disabled." : `Turn limit set to ${value}.`;
        this.notice = this.controlNotice;
        await this.refreshBrokerCache();
        return;
      }
      case "turns":
        this.controlNotice = this.buildTurnSummary();
        this.notice = this.controlNotice;
        return;
      default:
        this.controlNotice = `Unknown control command: /${name}`;
        this.notice = this.controlNotice;
    }
  }

  private restartPane(id: PaneId): void {
    this.paneOffsets[id] = 0;
    this.runtime.restartPane(id);
  }

  private async startPane(id: PaneId, cols: number, rows: number): Promise<void> {
    await this.runtime.startPane(id, cols, rows);
  }

  private resolvePaneBackend(id: PaneId): InteractiveCliBackend {
    return this.runtime.resolvePaneBackend(id);
  }

  private async capturePaneSessionId(id: PaneId, data: string): Promise<void> {
    await this.runtime.capturePaneSessionId(id, data);
  }

  private queueRender(): void {
    if (this.renderQueued) {
      return;
    }

    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.safeRender();
    }, 16);
  }

  private render(): void {
    const columns = Math.max(process.stdout.columns || 120, 40);
    const rows = Math.max(process.stdout.rows || 32, 10);
    const topRows = Math.max(4, rows - 5);
    const leftWidth = Math.floor((columns - 1) / 2);
    const rightWidth = columns - 1 - leftWidth;
    const statusLines = this.buildStatusLines().map((line) => colorizeStatusLine(padPlain(line, columns), this.focus));
    const controlLines = this.buildControlLines().map((line, index) =>
      index === 0
        ? colorizeControlLine(padPlain(line, columns), this.focus === "control")
        : colorText(padPlain(line, columns), ANSI.dim)
    );
    const output: string[] = [];
    const selectPane = this.getSelectPaneId();

    if (selectPane) {
      const lines = this.getPaneLines(selectPane, columns, topRows);
      const color = selectPane === "left" ? ANSI.blue : ANSI.green;
      for (let row = 0; row < topRows; row += 1) {
        output.push(formatPaneLine(lines[row], columns, color));
      }
    } else {
      const leftLines = this.getPaneLines("left", leftWidth, topRows);
      const rightLines = this.getPaneLines("right", rightWidth, topRows);
      const divider = colorizeDivider("|", this.focus);

      for (let row = 0; row < topRows; row += 1) {
        output.push(
          `${formatPaneLine(leftLines[row], leftWidth, this.focus === "left" ? ANSI.blue : undefined)}${divider}${formatPaneLine(
            rightLines[row],
            rightWidth,
            this.focus === "right" ? ANSI.green : undefined
          )}`
        );
      }
    }

    output.push(colorText("-".repeat(columns), ANSI.dim));
    output.push(...statusLines);
    output.push(...controlLines);

    const frame = output.join("\n");
    if (frame === this.lastFrame) {
      return;
    }

    this.lastFrame = frame;
    process.stdout.write(`\u001B[?25l\u001B[H${frame}`);
  }

  private safeRender(): void {
    if (this.stopped) {
      return;
    }

    try {
      this.render();
    } catch (error) {
      this.reportError("render", error);
    }
  }

  private getPaneLines(id: PaneId, width: number, height: number): RenderLine[] {
    const pane = this.panes.get(id);
    if (!pane) {
      return fillRenderLines(height, "");
    }

    try {
      const buffer = pane.terminal.buffer.active;
      const backend = this.paneBackends.get(id) ?? this.resolvePaneBackend(id);
      const latestLine = this.getLatestLineIndex(id);
      const maxOffset = this.getMaxOffset(id, height);
      const offset = Math.min(this.paneOffsets[id], maxOffset);
      const start = this.resolvePaneStart(id, height, latestLine, offset);
      return buildPaneLines({
        buffer,
        backend,
        width,
        height,
        start,
        focusActive: this.focus === id && this.focus !== "control",
        recentActivityAt: this.recentPaneActivityAt[id] ?? 0
      });
    } catch (error) {
      this.reportError(`buffer:${id}`, error);
      return fillRenderLines(height, "");
    }
  }

  private buildStatusLines(): string[] {
    const left = this.panes.get("left");
    const right = this.panes.get("right");
    const leftBackend = this.paneBackends.get("left")?.id ?? this.resolvePaneBackend("left").id;
    const rightBackend = this.paneBackends.get("right")?.id ?? this.resolvePaneBackend("right").id;
    const mailbox = this.readMailboxUnreadCounts();
    const leftMark = this.focus === "left" ? "LEFT*" : "left ";
    const rightMark = this.focus === "right" ? "RIGHT*" : "right ";
    const controlMark = this.focus === "control" ? "CTRL*" : "ctrl ";

    const primary = [
      `${leftMark}:${left?.status ?? "starting"}${formatOffset(this.paneOffsets.left)}`,
      `${rightMark}:${right?.status ?? "starting"}${formatOffset(this.paneOffsets.right)}`,
      `${controlMark}`,
      `turns:${this.formatTurns()}`,
      `mail:L${mailbox.leftUnread}|R${mailbox.rightUnread}`,
      `delivery:${this.deliveryPaused ? "paused" : "live"}`,
      this.brokerHint,
      `backend:L${leftBackend}|R${rightBackend}`
    ].join(" | ");

    const secondary = [
      `mouse:${this.mouseMode}`,
      "Click:focus",
      "RightClick/Ctrl+V:paste",
      "Tab:select",
      "F1:control",
      "PgUp/PgDn:scroll",
      "Ctrl+C:quit"
    ].join(" | ");

    return [primary, secondary];
  }

  private buildTurnSummary(): string {
    return `turns:${this.formatTurns()} | delivered:${this.deliveredTurns} | max:${this.maxTurns === 0 ? "unlimited" : this.maxTurns}`;
  }

  private formatTurns(): string {
    return this.maxTurns === 0 ? `${this.deliveredTurns}/inf` : `${this.deliveredTurns}/${this.maxTurns}`;
  }

  private async buildRuntimeStatus(): Promise<string> {
    try {
      const leftBackend = this.paneBackends.get("left")?.id ?? this.resolvePaneBackend("left").id;
      const rightBackend = this.paneBackends.get("right")?.id ?? this.resolvePaneBackend("right").id;
      const [counts, diagnostics] = await Promise.all([
        this.broker.getUnreadCounts(),
        this.broker.getBrokerDiagnostics({
          cooldownMs: 1200,
          lastDeliveryAt: this.recentMailboxDeliveryAt
        })
      ]);
      const next = diagnostics.nextTarget ?? diagnostics.blockedReason;
      const wait =
        diagnostics.blockedReason === "cooldown"
          ? `wait:${diagnostics.cooldownRemainingMs}ms`
          : "wait:none";
      const nextInfo = diagnostics.nextMessage
        ? `${next}:${diagnostics.nextMessage.kind}:${diagnostics.nextMessage.from}->${diagnostics.nextMessage.to}`
        : next;
      return [
        `focus:${this.focus}`,
        `left:${this.panes.get("left")?.status ?? "starting"}`,
        `right:${this.panes.get("right")?.status ?? "starting"}`,
        `peer:L${diagnostics.peers.left.status}/R${diagnostics.peers.right.status}`,
        `turns:${this.formatTurns()}`,
        `mail:L${counts.left}|R${counts.right}`,
        `delivery:${this.deliveryPaused ? "paused" : "live"}`,
        `broker:${formatBlockedReason(diagnostics.blockedReason)}`,
        wait,
        `next:${nextInfo}`,
        `backend:L${leftBackend}|R${rightBackend}`
      ].join(" | ");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `status unavailable: ${message}`;
    }
  }

  private buildControlLines(): string[] {
    if (this.focus === "control") {
      const tail = this.commandBuffer || this.controlNotice || this.notice;
      return [
        `control> ${tail}`,
        "Enter:run | Esc:clear/return | F1:return"
      ];
    }

    return [
      `focus:${this.focus} | ${this.notice}`,
      this.mouseMode === "select"
        ? "Select mode: drag to select | PgUp/PgDn/Home/End scroll | Tab:ui | F1:control"
        : "Click:focus pane | Tab:select text | Shift+Tab:pass through | F1:control"
    ];
  }

  private getPaneDimensions(): { paneCols: number; paneRows: number } {
    const columns = Math.max(process.stdout.columns || 120, 40);
    const rows = Math.max(process.stdout.rows || 32, 10);
    const paneCols = Math.floor((columns - 1) / 2);
    const paneRows = Math.max(4, rows - 5);
    return { paneCols, paneRows };
  }

  private getLatestLineIndex(id: PaneId): number {
    const pane = this.panes.get(id);
    if (!pane) {
      return 0;
    }

    const buffer = pane.terminal.buffer.active;
    return Math.max(buffer.length - 1, buffer.baseY + buffer.cursorY);
  }

  private getMaxOffset(id: PaneId, paneRows: number): number {
    return Math.max(0, this.getLatestLineIndex(id) - paneRows + 1);
  }

  private getScrollStep(): number {
    return Math.max(1, this.getPaneDimensions().paneRows - 2);
  }

  private preserveScrolledViewport(id: PaneId, previousLatestLine: number): void {
    const frozenInSelect = this.mouseMode === "select" && this.getSelectPaneId() === id;
    if (this.paneOffsets[id] <= 0 && !frozenInSelect) {
      delete this.pinnedViewportStart[id];
      return;
    }

    const { paneRows } = this.getPaneDimensions();
    const latestLine = this.getLatestLineIndex(id);
    const maxStart = Math.max(0, latestLine - paneRows + 1);
    const pinned = this.pinnedViewportStart[id];
    if (pinned === undefined) {
      this.pinnedViewportStart[id] = Math.max(0, latestLine - paneRows + 1 - this.paneOffsets[id]);
      return;
    }

    this.pinnedViewportStart[id] = Math.min(pinned, maxStart);
  }

  private adjustPaneOffset(id: PaneId, delta: number, direction: "older" | "newer"): void {
    const { paneRows } = this.getPaneDimensions();
    const maxOffset = this.getMaxOffset(id, paneRows);
    const next = Math.max(0, Math.min(maxOffset, this.paneOffsets[id] + delta));
    this.paneOffsets[id] = next;
    if (next === 0) {
      delete this.pinnedViewportStart[id];
    } else {
      const latestLine = this.getLatestLineIndex(id);
      this.pinnedViewportStart[id] = Math.max(0, latestLine - paneRows + 1 - next);
    }
    this.notice =
      next === 0
        ? `${id} is at the latest content.`
        : `${id} scrolled ${direction} (${next}/${maxOffset}).`;
    this.safeRender();
  }

  private resolvePaneStart(id: PaneId, height: number, latestLine: number, offset: number): number {
    const frozenInSelect = this.mouseMode === "select" && this.getSelectPaneId() === id;
    if (offset <= 0 && !frozenInSelect) {
      delete this.pinnedViewportStart[id];
      return Math.max(0, latestLine - height + 1);
    }

    const maxStart = Math.max(0, latestLine - height + 1);
    const pinned = this.pinnedViewportStart[id];
    if (pinned === undefined) {
      const start = Math.max(0, latestLine - height + 1 - offset);
      this.pinnedViewportStart[id] = start;
      return start;
    }

    return Math.min(pinned, maxStart);
  }

  private getSelectPaneId(): PaneId | undefined {
    if (this.mouseMode !== "select") {
      return undefined;
    }

    return this.focus === "control" ? this.lastPaneFocus : this.focus;
  }

  private resolvePaneTarget(column: number, row: number): PaneId | undefined {
    const { paneCols, paneRows } = this.getPaneDimensions();
    if (row < 1 || row > paneRows) {
      return undefined;
    }

    if (column <= paneCols) {
      return "left";
    }

    if (column >= paneCols + 2) {
      return "right";
    }

    return this.focus === "right" ? "right" : "left";
  }

  private reportError(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.notice = `Error [${scope}]: ${message}`;
    try {
      process.stderr.write(`[duplex-codex] ${scope}: ${message}\n`);
    } catch {
      // Ignore stderr failures.
    }
  }

  private pasteClipboardIntoFocus(): void {
    const text = readClipboardText();
    if (!text) {
      this.notice = "Clipboard is empty.";
      this.safeRender();
      return;
    }

    if (this.focus === "control") {
      this.commandBuffer += text.replace(/\r?\n/g, " ");
      this.notice = "Pasted clipboard into control line.";
      this.safeRender();
      return;
    }

    const pane = this.panes.get(this.focus);
    if (!pane || pane.status === "exited") {
      this.notice = `Cannot paste into ${this.focus}; pane is not available.`;
      this.safeRender();
      return;
    }

    this.recentUserInputAt[this.focus] = Date.now();
    void this.notePeerActivity(this.focus, "busy");
    pane.pty.write("\u001B[200~" + normalizeClipboardForPty(text) + "\u001B[201~");
    this.notice = `Pasted clipboard into ${this.focus} pane.`;
    this.safeRender();
  }

  private toggleMouseMode(): void {
    const nextMode: MouseMode = this.mouseMode === "ui" ? "select" : "ui";
    const selectPane = this.focus === "control" ? this.lastPaneFocus : this.focus;
    if (nextMode === "select") {
      const { paneRows } = this.getPaneDimensions();
      const latestLine = this.getLatestLineIndex(selectPane);
      this.pinnedViewportStart[selectPane] = Math.max(0, latestLine - paneRows + 1 - this.paneOffsets[selectPane]);
    } else if (this.paneOffsets[selectPane] <= 0) {
      delete this.pinnedViewportStart[selectPane];
    }

    this.setMouseMode(nextMode);
    this.notice =
      nextMode === "select"
        ? `Selection mode enabled for ${selectPane}. Drag to select text. Use PgUp/PgDn/Home/End to scroll this pane. Press Tab to return to UI mode.`
        : "UI mouse mode enabled. Click focuses panes, wheel scrolls, and right-click or Ctrl+V pastes clipboard.";
    this.safeRender();
  }

  private setMouseMode(mode: MouseMode): void {
    this.mouseMode = mode;
    if (mode === "ui") {
      process.stdout.write("\u001B[?1000h\u001B[?1006h");
      return;
    }

    process.stdout.write("\u001B[?1000l\u001B[?1006l");
  }

  private shouldSuppressMouseLeak(input: string, key: readline.Key): boolean {
    if (Date.now() > this.suppressMouseKeypressUntil) {
      return false;
    }

    if (key.ctrl || key.meta) {
      return false;
    }

    if (key.name === "tab" || key.name === "escape" || key.name === "return" || key.name === "backspace") {
      return false;
    }

    const sequence = key.sequence ?? input;
    return Boolean(sequence && /[0-9;Mm<]/.test(sequence));
  }

  private readMailboxUnreadCounts(): { leftUnread: number; rightUnread: number } {
    return this.runtime.readMailboxUnreadCounts();
  }

  private async refreshBrokerCache(): Promise<void> {
    await this.runtime.refreshBrokerCache();
  }

  private async notePeerActivity(id: PaneId, status: "busy" | "idle" | "waiting" | "integrating"): Promise<void> {
    await this.runtime.notePeerActivity(id, status);
  }

  private async pollMailboxDeliveries(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.runtime.pollMailboxDeliveries();
  }

  private async interruptAndKillPane(pane: PaneHandle): Promise<void> {
    await this.runtime.interruptAndKillPane(pane);
  }

  private toPaneId(value: string): PaneId | undefined {
    if (value === "left" || value === "right") {
      return value;
    }
    return undefined;
  }
}

function resolveToolBinDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
}

function toPtySequence(input: string, key: readline.Key): string | undefined {
  if (key.ctrl && key.name === "c") {
    return "\u0003";
  }

  if (key.name === "return") {
    return "\r";
  }

  if (key.name === "backspace") {
    return "\u007F";
  }

  if (key.name === "delete") {
    return "\u001B[3~";
  }

  if (key.name === "up") {
    return "\u001B[A";
  }

  if (key.name === "down") {
    return "\u001B[B";
  }

  if (key.name === "right") {
    return "\u001B[C";
  }

  if (key.name === "left") {
    return "\u001B[D";
  }

  if (key.sequence) {
    return key.sequence;
  }

  if (input) {
    return input;
  }

  return undefined;
}

const ANSI = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  magenta: "\u001B[35m",
  cyan: "\u001B[36m",
  brightBlack: "\u001B[90m",
  brightCyan: "\u001B[96m",
  reverse: "\u001B[7m"
} as const;

function colorizeStatusLine(line: string, focus: FocusTarget): string {
  let output = line;
  output = output.replace(/backend:[^|]+/g, (value) => colorText(value, ANSI.blue));
  output = output.replace(/mail:L\d+\|R\d+/g, (value) => colorText(value, ANSI.magenta));
  output = output.replace(/broker:[^|]+/g, (value) => colorText(value, ANSI.yellow));
  output = output.replace("Click:focus", colorText("Click:focus", ANSI.cyan));
  output = output.replace("RightClick/Ctrl+V:paste", colorText("RightClick/Ctrl+V:paste", ANSI.cyan));
  output = output.replace("Tab:select", colorText("Tab:select", ANSI.cyan));
  output = output.replace("F1:control", colorText("F1:control", ANSI.cyan));
  output = output.replace("PgUp/PgDn:scroll", colorText("PgUp/PgDn:scroll", ANSI.cyan));
  output = output.replace("Ctrl+C:quit", colorText("Ctrl+C:quit", ANSI.red));
  output = output.replace("mouse:ui", colorText("mouse:ui", ANSI.cyan));
  output = output.replace("mouse:select", colorText("mouse:select", ANSI.yellow));
  output = output.replace(
    focus === "left" ? "LEFT*" : "left ",
    focus === "left" ? colorText("LEFT*", ANSI.reverse + ANSI.blue) : colorText("left ", ANSI.brightBlack)
  );
  output = output.replace(
    focus === "right" ? "RIGHT*" : "right ",
    focus === "right" ? colorText("RIGHT*", ANSI.reverse + ANSI.green) : colorText("right ", ANSI.brightBlack)
  );
  output = output.replace(
    focus === "control" ? "CTRL*" : "ctrl ",
    focus === "control" ? colorText("CTRL*", ANSI.reverse + ANSI.yellow) : colorText("ctrl ", ANSI.brightBlack)
  );
  output = output.replace(/lead/g, colorText("lead", ANSI.red));
  output = output.replace(/support/g, colorText("support", ANSI.green));
  output = output.replace(/running/g, colorText("running", ANSI.green));
  output = output.replace(/starting/g, colorText("starting", ANSI.yellow));
  output = output.replace(/exited/g, colorText("exited", ANSI.red));
  return output;
}

function colorizeControlLine(line: string, controlFocused: boolean): string {
  if (line.startsWith("control> ")) {
    const prefix = controlFocused
      ? colorText("control>", ANSI.reverse + ANSI.yellow)
      : colorText("control>", ANSI.yellow);
    return `${prefix}${line.slice("control>".length)}`;
  }

  if (line.includes("Error [")) {
    return colorText(line, ANSI.red);
  }

  if (line.includes("Focused ") || line.includes("Returned to ")) {
    return colorText(line, ANSI.green);
  }

  if (line.includes("Delivered ")) {
    return colorText(line, ANSI.magenta);
  }

  if (line.includes("/help") || line.includes("/restart") || line.includes("/status") || line.includes("/quit")) {
    return colorText(line, ANSI.cyan);
  }

  if (line.includes("duplex-msg") || line.includes("mailbox") || line.includes("inbox")) {
    return colorText(line, ANSI.magenta);
  }

  return colorText(line, ANSI.dim);
}

function colorizeDivider(divider: string, focus: FocusTarget): string {
  void focus;
  return colorText(divider, ANSI.brightBlack);
}

function colorText(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

function normalizeClipboardForPty(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function formatBlockedReason(reason: "none" | "cooldown" | "no_pending"): string {
  switch (reason) {
    case "none":
      return "ready";
    case "cooldown":
      return "cooldown";
    case "no_pending":
      return "idle";
    default:
      return reason;
  }
}

function formatOffset(offset: number): string {
  return offset > 0 ? `@-${offset}` : "";
}

function isMouseSequence(value: string | undefined): boolean {
  return Boolean(value && containsMouseSequence(value));
}

function containsMouseSequence(value: string): boolean {
  return /\x1b\[<\d+;\d+;\d+[mM]/.test(value) || /\x1b\[M.../.test(value);
}

function parseMouseEvents(input: string): Array<{
  kind: "wheel";
  direction: "up" | "down";
  column: number;
  row: number;
} | {
  kind: "click";
  column: number;
  row: number;
} | {
  kind: "rightClick";
  column: number;
  row: number;
}> {
  const events: Array<{
    kind: "wheel";
    direction: "up" | "down";
    column: number;
    row: number;
  } | {
    kind: "click";
    column: number;
    row: number;
  } | {
    kind: "rightClick";
    column: number;
    row: number;
  }> = [];
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    const button = Number.parseInt(match[1] ?? "", 10);
    const column = Number.parseInt(match[2] ?? "", 10);
    const row = Number.parseInt(match[3] ?? "", 10);
    if (!Number.isFinite(button) || !Number.isFinite(column) || !Number.isFinite(row)) {
      continue;
    }

    if ((button & 64) !== 0) {
      events.push({
        kind: "wheel",
        direction: (button & 1) === 0 ? "up" : "down",
        column,
        row
      });
      continue;
    }

    if (match[4] === "M" && (button & 3) === 0) {
      events.push({
        kind: "click",
        column,
        row
      });
      continue;
    }

    if (match[4] === "M" && (button & 3) === 2) {
      events.push({
        kind: "rightClick",
        column,
        row
      });
    }
  }

  return events;
}








function readClipboardText(): string {
  if (process.platform !== "win32") {
    return "";
  }

  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
      encoding: "utf8",
      windowsHide: true
    });

    if (result.status !== 0) {
      return "";
    }

    return (result.stdout ?? "").replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}
function normalizeCliInteger(value: string): string {
  return value
    .trim()
    .replace(/[<>]/g, "")
    .replace(/\u3000/g, " ")
    .replace(/[\uFF10-\uFF19]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, " ");
}









