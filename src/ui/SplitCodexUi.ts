import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import {
  createConfiguredBrokerClient
} from "../app/brokerClient.ts";
import type { BrokerClient, DuplexMessage } from "../app/brokerClient.ts";

const { Terminal } = xtermHeadless;

type FocusTarget = "left" | "right" | "control";
type PaneId = "left" | "right";
type PaneStatus = "starting" | "running" | "exited";
type PaneRole = "lead" | "support";
type MouseMode = "ui" | "select";

interface SplitCodexUiOptions {
  workspaceDir: string;
  maxTurns?: number;
  leftPrompt?: string;
  rightPrompt?: string;
  onExit?: () => Promise<void>;
}

interface PaneHandle {
  id: PaneId;
  role: PaneRole;
  terminal: Terminal;
  pty: pty.IPty;
  status: PaneStatus;
  exitCode?: number;
  writeQueue: Promise<void>;
}

interface RenderLine {
  text: string;
  cursorCol?: number;
}

export class SplitCodexUi {
  private readonly workspaceDir: string;
  private readonly onExit?: () => Promise<void>;
  private readonly broker: BrokerClient;
  private readonly initialPrompts: Partial<Record<PaneId, string>>;
  private readonly closed: Promise<void>;
  private closeResolver!: () => void;
  private readonly panes = new Map<PaneId, PaneHandle>();
  private readonly codexCommand = process.platform === "win32" ? resolveWindowsCodexCommand() ?? "codex.cmd" : "codex";
  private readonly codexBinDir = process.platform === "win32" ? resolveWindowsCodexBinDir() : undefined;
  private readonly toolBinDir = resolveToolBinDir();
  private readonly paneRoles: Record<PaneId, PaneRole> = {
    left: "lead",
    right: "support"
  };
  private readonly paneOffsets: Record<PaneId, number> = {
    left: 0,
    right: 0
  };
  private focus: FocusTarget = "left";
  private lastPaneFocus: PaneId = "left";
  private commandBuffer = "";
  private notice = "Click switch panes | Right-click paste | Tab select text | F1 control | Wheel/PgUp/PgDn scroll";
  private renderQueued = false;
  private stopped = false;
  private lastFrame = "";
  private suppressMouseKeypressUntil = 0;
  private mailboxTimer?: NodeJS.Timeout;
  private readonly mailboxDeliveryInFlight = new Set<string>();
  private readonly initialPromptInjected = new Set<PaneId>();
  private recentMailboxDeliveryAt = 0;
  private readonly idleTimers: Partial<Record<PaneId, NodeJS.Timeout>> = {};
  private maxTurns = 8;
  private deliveredTurns = 0;
  private mailboxCache = {
    at: 0,
    leftUnread: 0,
    rightUnread: 0
  };
  private brokerHint = "broker:pending none";
  private mouseMode: MouseMode = "ui";

  constructor(options: SplitCodexUiOptions) {
    this.workspaceDir = options.workspaceDir;
    this.onExit = options.onExit;
    this.broker = createConfiguredBrokerClient(this.workspaceDir);
    this.initialPrompts = {
      left: options.leftPrompt,
      right: options.rightPrompt
    };
    if (options.maxTurns !== undefined) {
      this.maxTurns = options.maxTurns;
    }
    this.closed = new Promise<void>((resolve) => {
      this.closeResolver = resolve;
    });
  }

  async start(): Promise<void> {
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
    await this.broker.resetBrokerState();
    this.mailboxCache = { at: Date.now(), leftUnread: 0, rightUnread: 0 };
    this.deliveredTurns = 0;
    await this.broker.upsertPeerState({ id: "left", role: this.paneRoles.left, status: "idle" });
    await this.broker.upsertPeerState({ id: "right", role: this.paneRoles.right, status: "idle" });
    this.mailboxTimer = setInterval(() => {
      void this.refreshBrokerCache();
      void this.pollMailboxDeliveries();
    }, 700);

    const { paneCols, paneRows } = this.getPaneDimensions();
    this.panes.set("left", this.spawnPane("left", paneCols, paneRows));
    this.panes.set("right", this.spawnPane("right", paneCols, paneRows));
    this.injectInitialPrompts();
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
    await this.broker.resetBrokerState();
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

    if (key.name === "tab") {
      this.toggleMouseMode();
      return;
    }


    if (key.name === "f1") {
      if (this.focus === "control") {
        this.focus = this.lastPaneFocus;
        this.notice = `Returned to ${this.focus}.`;
      } else {
        this.focus = "control";
        this.notice = "Control focus. /help for commands. Tab returns to the last pane.";
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

        const step = Math.max(3, Math.floor(this.getScrollStep() / 2));
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
        this.notice =
          "/focus left|right | /restart left|right|both | /max-turns <n> | /turns | /status | /quit | left=lead right=support";
        return;
      case "quit":
        this.notice = "Shutting down.";
        this.safeRender();
        await this.stop();
        process.exit(0);
        return;
      case "focus":
        if (arg === "left" || arg === "right") {
          this.focus = arg;
          this.lastPaneFocus = arg;
          this.notice = `Focused ${arg} pane.`;
          return;
        }
        this.notice = "/focus requires left or right.";
        return;
      case "restart":
        if (arg === "left" || arg === "right") {
          this.restartPane(arg);
          this.notice = `Restarted ${arg} pane.`;
          return;
        }
        if (arg === "both") {
          this.restartPane("left");
          this.restartPane("right");
          this.notice = "Restarted both panes.";
          return;
        }
        this.notice = "/restart requires left, right, or both.";
        return;
      case "status":
        this.notice = await this.buildRuntimeStatus();
        return;
      case "max-turns": {
        if (!arg) {
          this.notice = "/max-turns requires a non-negative integer.";
          return;
        }
        const value = Number.parseInt(arg, 10);
        if (!Number.isFinite(value) || value < 0) {
          this.notice = "/max-turns requires a non-negative integer.";
          return;
        }
        this.maxTurns = value;
        this.notice = value === 0 ? "Turn limit disabled." : `Turn limit set to ${value}.`;
        await this.refreshBrokerCache();
        return;
      }
      case "turns":
        this.notice = this.buildTurnSummary();
        return;
      default:
        this.notice = `Unknown control command: /${name}`;
    }
  }

  private restartPane(id: PaneId): void {
    const oldPane = this.panes.get(id);
    if (oldPane) {
      void this.interruptAndKillPane(oldPane);
    }

    const { paneCols, paneRows } = this.getPaneDimensions();
    this.paneOffsets[id] = 0;
    this.initialPromptInjected.delete(id);
    this.panes.set(id, this.spawnPane(id, paneCols, paneRows));
    this.safeRender();
  }

  private spawnPane(id: PaneId, cols: number, rows: number): PaneHandle {
    const shell = this.codexCommand;
    const args = ["--no-alt-screen"];

    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true
    });

    const child = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.workspaceDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PATH: buildPanePath(this.toolBinDir, this.codexBinDir, process.env.PATH)
      }
    });

    const pane: PaneHandle = {
      id,
      role: this.paneRoles[id],
      terminal,
      pty: child,
      status: "starting",
      writeQueue: Promise.resolve()
    };

    child.onData((data) => {
      pane.status = "running";
      this.maybeInjectInitialPrompt(id);
      void this.notePeerActivity(id, "busy");
      pane.writeQueue = pane.writeQueue
        .then(
          () =>
            new Promise<void>((resolve) => {
              pane.terminal.write(data, resolve);
            })
        )
        .then(() => {
          this.queueRender();
        })
        .catch((error) => {
          this.reportError(`pty-write:${id}`, error);
        });
    });

    child.onExit(({ exitCode }) => {
      pane.status = "exited";
      pane.exitCode = exitCode;
      void this.notePeerActivity(id, "waiting");
      this.notice = `${id} exited with code ${exitCode}. Use F1 then /restart ${id}.`;
      this.safeRender();
    });

    return pane;
  }

  private injectInitialPrompts(): void {
    for (const id of ["left", "right"] as const) {
      this.maybeInjectInitialPrompt(id);
    }
  }

  private maybeInjectInitialPrompt(id: PaneId): void {
    if (this.initialPromptInjected.has(id)) {
      return;
    }
    const prompt = this.initialPrompts[id];
    const pane = this.panes.get(id);
    if (!prompt || !pane || pane.status !== "running") {
      return;
    }

    this.initialPromptInjected.add(id);
    setTimeout(() => {
      if (this.stopped || pane.status === "exited") {
        return;
      }
      void this.notePeerActivity(id, "busy");
      pane.pty.write(normalizePromptForPty(prompt));
    }, id === "left" ? 350 : 650);
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
    const rows = Math.max(process.stdout.rows || 32, 8);
    const topRows = Math.max(4, rows - 3);
    const leftWidth = Math.floor((columns - 1) / 2);
    const rightWidth = columns - 1 - leftWidth;
    const leftLines = this.getPaneLines("left", leftWidth, topRows);
    const rightLines = this.getPaneLines("right", rightWidth, topRows);
    const status = colorizeStatusLine(padPlain(this.buildStatusLine(), columns), this.focus);
    const control = colorizeControlLine(padPlain(this.buildControlLine(), columns), this.focus === "control");
    const output: string[] = [];
    const divider = colorizeDivider("|", this.focus);

    for (let row = 0; row < topRows; row += 1) {
      output.push(
        `${formatPaneLine(leftLines[row], leftWidth, this.focus === "left" ? ANSI.red : undefined)}${divider}${formatPaneLine(
          rightLines[row],
          rightWidth,
          this.focus === "right" ? ANSI.green : undefined
        )}`
      );
    }

    output.push(colorText("-".repeat(columns), ANSI.dim));
    output.push(status);
    output.push(control);

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
      const latestLine = this.getLatestLineIndex(id);
      const maxOffset = this.getMaxOffset(id, height);
      const offset = Math.min(this.paneOffsets[id], maxOffset);
      const start = Math.max(0, latestLine - height + 1 - offset);
      const lines: RenderLine[] = [];
      const cursorLine = buffer.baseY + buffer.cursorY;
      const cursorCol = buffer.cursorX;

      for (let index = 0; index < height; index += 1) {
        const lineIndex = start + index;
        const line = buffer.getLine(start + index);
        lines.push({
          text: sanitizeLine(line?.translateToString(true) ?? "", width),
          cursorCol:
            this.focus === id && lineIndex === cursorLine && this.focus !== "control" ? Math.min(cursorCol, Math.max(0, width - 1)) : undefined
        });
      }

      return lines;
    } catch (error) {
      this.reportError(`buffer:${id}`, error);
      return fillRenderLines(height, "");
    }
  }

  private buildStatusLine(): string {
    const left = this.panes.get("left");
    const right = this.panes.get("right");
    const mailbox = this.readMailboxUnreadCounts();
    const leftMark = this.focus === "left" ? "LEFT*" : "left ";
    const rightMark = this.focus === "right" ? "RIGHT*" : "right ";
    const controlMark = this.focus === "control" ? "CTRL*" : "ctrl ";

    return [
      `${leftMark}:${left?.role ?? this.paneRoles.left}:${left?.status ?? "starting"}${formatOffset(this.paneOffsets.left)}`,
      `${rightMark}:${right?.role ?? this.paneRoles.right}:${right?.status ?? "starting"}${formatOffset(this.paneOffsets.right)}`,
      `${controlMark}`,
      `turns:${this.formatTurns()}`,
      `mail:L${mailbox.leftUnread}|R${mailbox.rightUnread}`,
      this.brokerHint,
      "provider:codex",
      `mouse:${this.mouseMode}`,
      "Click:focus",
      "RightClick:paste",
      "Tab:select",
      "F1:control",
      "PgUp/PgDn:scroll",
      "Ctrl+C:quit"
    ].join(" | ");
  }

  private buildTurnSummary(): string {
    return `turns:${this.formatTurns()} | delivered:${this.deliveredTurns} | max:${this.maxTurns === 0 ? "unlimited" : this.maxTurns}`;
  }

  private formatTurns(): string {
    return this.maxTurns === 0 ? `${this.deliveredTurns}/inf` : `${this.deliveredTurns}/${this.maxTurns}`;
  }

  private async buildRuntimeStatus(): Promise<string> {
    try {
      const [counts, diagnostics] = await Promise.all([
        this.broker.getUnreadCounts(),
        this.broker.getBrokerDiagnostics({
          cooldownMs: 1200,
          lastDeliveryAt: this.recentMailboxDeliveryAt
        })
      ]);
      const next = diagnostics.nextTarget
        ? `${diagnostics.nextTarget}${diagnostics.nextMerged ? "+merge" : ""}`
        : diagnostics.blockedReason;
      const wait =
        diagnostics.blockedReason === "cooldown"
          ? `wait:${diagnostics.cooldownRemainingMs}ms`
          : diagnostics.blockedReason === "left_busy"
            ? `wait:L${diagnostics.quietRemainingMs.left}ms`
            : diagnostics.blockedReason === "right_busy"
              ? `wait:R${diagnostics.quietRemainingMs.right}ms`
              : "wait:none";
      const nextInfo = diagnostics.nextMessage
        ? `${next}:${diagnostics.nextMessage.kind}:${diagnostics.nextMessage.from}->${diagnostics.nextMessage.to}`
        : next;
      return [
        `focus:${this.focus}`,
        `left:${this.panes.get("left")?.status ?? "starting"}/${this.paneRoles.left}`,
        `right:${this.panes.get("right")?.status ?? "starting"}/${this.paneRoles.right}`,
        `peer:L${diagnostics.peers.left.status}/R${diagnostics.peers.right.status}`,
        `turns:${this.formatTurns()}`,
        `mail:L${counts.left}|R${counts.right}`,
        `broker:${formatBlockedReason(diagnostics.blockedReason)}`,
        wait,
        `next:${nextInfo}`,
        "provider:codex"
      ].join(" | ");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `status unavailable: ${message}`;
    }
  }

  private buildControlLine(): string {
    if (this.focus === "control") {
      return `control> ${this.commandBuffer}`;
    }

    return `focus:${this.focus} | ${this.notice}`;
  }

  private getPaneDimensions(): { paneCols: number; paneRows: number } {
    const columns = Math.max(process.stdout.columns || 120, 40);
    const rows = Math.max(process.stdout.rows || 32, 8);
    const paneCols = Math.floor((columns - 1) / 2);
    const paneRows = Math.max(4, rows - 3);
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

  private adjustPaneOffset(id: PaneId, delta: number, direction: "older" | "newer"): void {
    const { paneRows } = this.getPaneDimensions();
    const maxOffset = this.getMaxOffset(id, paneRows);
    const next = Math.max(0, Math.min(maxOffset, this.paneOffsets[id] + delta));
    this.paneOffsets[id] = next;
    this.notice =
      next === 0
        ? `${id} is at the latest content.`
        : `${id} scrolled ${direction} (${next}/${maxOffset}).`;
    this.safeRender();
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

    void this.notePeerActivity(this.focus, "busy");
    pane.pty.write(normalizeClipboardForPty(text));
    this.notice = `Pasted clipboard into ${this.focus} pane.`;
    this.safeRender();
  }
  private toggleMouseMode(): void {
    const nextMode: MouseMode = this.mouseMode === "ui" ? "select" : "ui";
    this.setMouseMode(nextMode);
    this.notice =
      nextMode === "select"
        ? "Selection mode enabled. Drag to select text. Press Tab to restore click focus, wheel scroll, and right-click paste."
        : "UI mouse mode enabled. Click focuses panes, wheel scrolls, and right-click pastes clipboard.";
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
    return this.mailboxCache;
  }

  private async refreshBrokerCache(): Promise<void> {
    try {
      const counts = await this.broker.getUnreadCounts();
      const diagnostics = await this.broker.getBrokerDiagnostics({
        cooldownMs: 1200,
        lastDeliveryAt: this.recentMailboxDeliveryAt
      });
      this.mailboxCache = {
        at: Date.now(),
        leftUnread: counts.left,
        rightUnread: counts.right
      };
      this.brokerHint = formatBrokerHint(diagnostics, {
        maxTurns: this.maxTurns,
        deliveredTurns: this.deliveredTurns
      });
      this.safeRender();
    } catch (error) {
      this.reportError("broker-cache", error);
    }
  }

  private async notePeerActivity(id: PaneId, status: "busy" | "idle" | "waiting" | "integrating"): Promise<void> {
    try {
      const existing = this.idleTimers[id];
      if (existing) {
        clearTimeout(existing);
        delete this.idleTimers[id];
      }

      await this.broker.upsertPeerState({
        id,
        role: this.paneRoles[id],
        status
      });

      if (status === "busy" || status === "integrating") {
        this.idleTimers[id] = setTimeout(() => {
          delete this.idleTimers[id];
          void this.broker.upsertPeerState({
            id,
            role: this.paneRoles[id],
            status: "idle"
          });
        }, 3200);
      }
    } catch {
      // Ignore peer-state bookkeeping failures in the UI loop.
    }
  }

  private async pollMailboxDeliveries(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      if (this.maxTurns > 0 && this.deliveredTurns >= this.maxTurns) {
        this.notice = `Turn limit reached (${this.deliveredTurns}/${this.maxTurns}).`;
        await this.refreshBrokerCache();
        return;
      }

      const candidate = await this.broker.getNextDeliveryCandidate({
        cooldownMs: 1200,
        lastDeliveryAt: this.recentMailboxDeliveryAt
      });
      if (!candidate || candidate.message.deliveredAt || this.mailboxDeliveryInFlight.has(candidate.message.id)) {
        return;
      }

      const { message, target } = candidate;
      const pane = this.panes.get(target);
      if (!pane || pane.status === "exited") {
        return;
      }

      this.mailboxDeliveryInFlight.add(message.id);
      try {
        await this.notePeerActivity(target, target === "left" ? "integrating" : "busy");
        await this.typeSubmittedMessageIntoPane(pane, formatInjectedMessage(message, this.paneRoles[target]));
        if (!message.id.includes("__merge__")) {
          await this.broker.markMessageDelivered(message.id);
        }
        this.recentMailboxDeliveryAt = Date.now();
        this.deliveredTurns += 1;
        this.notice = `Delivered ${message.kind} from ${message.from} to ${message.to}.`;
        await this.refreshBrokerCache();
        this.safeRender();
      } finally {
        this.mailboxDeliveryInFlight.delete(message.id);
      }
    } catch (error) {
      this.reportError("mailbox-delivery", error);
    }
  }

  private async typeSubmittedMessageIntoPane(pane: PaneHandle, message: string): Promise<void> {
    for (const char of message) {
      pane.pty.write(char);
      await delay(18);
    }
    await delay(120);
    pane.pty.write("\r");
  }

  private async interruptAndKillPane(pane: PaneHandle): Promise<void> {
    try {
      pane.pty.write("\u0003");
    } catch {
      // Ignore interruption failures.
    }

    await delay(80);

    try {
      pane.pty.kill();
    } catch {
      // Ignore child teardown races.
    }
  }

  private toPaneId(value: string): PaneId | undefined {
    if (value === "left" || value === "right") {
      return value;
    }
    return undefined;
  }
}

function resolveWindowsCodexBinDir(): string | undefined {
  const command = resolveWindowsCodexCommand();
  if (command) {
    return path.dirname(command);
  }

  return undefined;
}

function resolveToolBinDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
}

function buildPanePath(toolBinDir: string, codexBinDir: string | undefined, existingPath: string | undefined): string {
  const segments = [toolBinDir];
  if (codexBinDir) {
    segments.push(codexBinDir);
  }
  if (existingPath) {
    segments.push(existingPath);
  }
  return segments.join(";");
}

function resolveWindowsCodexCommand(): string | undefined {
  const whereResult = spawnSync("where.exe", ["codex.cmd"], {
    encoding: "utf8",
    windowsHide: true
  });

  if (whereResult.status === 0) {
    const first = whereResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }

  const userProfile = process.env.USERPROFILE ?? "";
  const candidates = [
    path.join(userProfile, "anaconda3", "codex.cmd"),
    path.join(userProfile, "AppData", "Roaming", "npm", "codex.cmd")
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  return match;
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

function sanitizeLine(value: string, width: number): string {
  return truncateToWidth(stripAnsi(value).replace(/\t/g, "    "), width);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function padPlain(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  const visibleWidth = getDisplayWidth(truncated);
  if (visibleWidth >= width) {
    return truncated;
  }

  return `${truncated}${" ".repeat(width - visibleWidth)}`;
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
  output = output.replace("provider:codex", colorText("provider:codex", ANSI.blue));
  output = output.replace(/mail:L\d+\|R\d+/g, (value) => colorText(value, ANSI.magenta));
  output = output.replace(/broker:[^|]+/g, (value) => colorText(value, ANSI.yellow));
  output = output.replace("Click:focus", colorText("Click:focus", ANSI.cyan));
  output = output.replace("RightClick:paste", colorText("RightClick:paste", ANSI.cyan));
  output = output.replace("Tab:select", colorText("Tab:select", ANSI.cyan));
  output = output.replace("F1:control", colorText("F1:control", ANSI.cyan));
  output = output.replace("PgUp/PgDn:scroll", colorText("PgUp/PgDn:scroll", ANSI.cyan));
  output = output.replace("Ctrl+C:quit", colorText("Ctrl+C:quit", ANSI.red));
  output = output.replace("mouse:ui", colorText("mouse:ui", ANSI.cyan));
  output = output.replace("mouse:select", colorText("mouse:select", ANSI.yellow));
  output = output.replace(
    focus === "left" ? "LEFT*" : "left ",
    focus === "left" ? colorText("LEFT*", ANSI.reverse + ANSI.red) : colorText("left ", ANSI.brightBlack)
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
  if (focus === "control") {
    return colorText(divider, ANSI.yellow);
  }
  if (focus === "left") {
    return colorText(divider, ANSI.red);
  }
  if (focus === "right") {
    return colorText(divider, ANSI.green);
  }
  return colorText(divider, ANSI.brightCyan);
}

function colorText(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

function formatInjectedMessage(message: DuplexMessage, targetRole: PaneRole): string {
  const refs = message.refs.length > 0 ? message.refs.join(", ") : "(none)";
  const singleLine = [
    `[${message.from}->${message.to}][${message.kind}][target:${targetRole}]`,
    `summary: ${message.summary}`,
    `ask: ${message.ask}`,
    `refs: ${refs}`
  ].join(" | ");
  return `${singleLine}\r`;
}

function normalizePromptForPty(prompt: string): string {
  const trimmed = prompt.replace(/\s+$/u, "");
  return `${trimmed.replace(/\r?\n/g, "\r")}\r`;
}

function normalizeClipboardForPty(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function formatBrokerHint(diagnostics: {
  peers: Record<PaneId, { status: string }>;
  pending: Record<PaneId, number>;
  blockedReason: string;
  cooldownRemainingMs: number;
  quietRemainingMs: Record<PaneId, number>;
  nextTarget?: PaneId;
  nextMerged: boolean;
}, turns: {
  maxTurns: number;
  deliveredTurns: number;
}): string {
  if (turns.maxTurns > 0 && turns.deliveredTurns >= turns.maxTurns) {
    return `broker:L${diagnostics.peers.left.status}/R${diagnostics.peers.right.status} qL${diagnostics.pending.left} qR${diagnostics.pending.right} next:turn_limit`;
  }
  const next = diagnostics.nextTarget
    ? `${diagnostics.nextTarget}${diagnostics.nextMerged ? "+merge" : ""}`
    : diagnostics.blockedReason === "cooldown"
      ? `cooldown:${diagnostics.cooldownRemainingMs}ms`
      : diagnostics.blockedReason === "left_busy"
        ? `left_busy:${diagnostics.quietRemainingMs.left}ms`
        : diagnostics.blockedReason === "right_busy"
          ? `right_busy:${diagnostics.quietRemainingMs.right}ms`
          : diagnostics.blockedReason;
  return `broker:L${diagnostics.peers.left.status}/R${diagnostics.peers.right.status} qL${diagnostics.pending.left} qR${diagnostics.pending.right} next:${next}`;
}

function formatBlockedReason(reason: "none" | "cooldown" | "left_busy" | "right_busy" | "no_pending"): string {
  switch (reason) {
    case "none":
      return "ready";
    case "cooldown":
      return "cooldown";
    case "left_busy":
      return "left-busy";
    case "right_busy":
      return "right-busy";
    case "no_pending":
      return "idle";
    default:
      return reason;
  }
}

function fillRenderLines(count: number, value: string): RenderLine[] {
  return Array.from({ length: count }, () => ({ text: value }));
}

function formatOffset(offset: number): string {
  return offset > 0 ? `@-${offset}` : "";
}

function formatPaneLine(line: RenderLine | undefined, width: number, focusColor?: string): string {
  const padded = padPlain(line?.text ?? "", width);
  if (line?.cursorCol === undefined || focusColor === undefined) {
    return padded;
  }

  return highlightCursorColumn(padded, line.cursorCol, focusColor);
}

function highlightCursorColumn(value: string, column: number, color: string): string {
  const safeColumn = Math.max(0, column);
  let displayWidth = 0;
  let index = 0;

  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    const charWidth = getCharWidth(char);
    if (displayWidth + charWidth > safeColumn) {
      break;
    }
    displayWidth += charWidth;
    index += char.length;
  }

  if (index >= value.length) {
    return value;
  }

  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) {
    return value;
  }

  const char = String.fromCodePoint(codePoint);
  const before = value.slice(0, index);
  const after = value.slice(index + char.length);
  return `${before}${ANSI.reverse}${color}${char}${ANSI.reset}${after}`;
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


function truncateToWidth(value: string, width: number): string {
  let result = "";
  let consumed = 0;

  for (const char of value) {
    const charWidth = getCharWidth(char);
    if (consumed + charWidth > width) {
      break;
    }

    result += char;
    consumed += charWidth;
  }

  return result;
}

function getDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += getCharWidth(char);
  }

  return width;
}

function getCharWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;

  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    (codePoint >= 0x300 && codePoint <= 0x36f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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