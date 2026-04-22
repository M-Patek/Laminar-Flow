import pty from "node-pty";
import xtermHeadless from "@xterm/headless";
import type { BrokerClient, DuplexMessage } from "../app/brokerClient.ts";
import {
  createInteractiveBackend,
  type InteractiveBackendId,
  type InteractiveCliBackend
} from "../backends/interactiveCliBackend.ts";
import type { InteractiveSessionState } from "../backends/InteractiveSessionState.ts";

const { Terminal } = xtermHeadless;

export type PaneId = "left" | "right";
export type PaneRole = "lead" | "support";
export type PaneStatus = "starting" | "running" | "exited";

export interface PaneHandle {
  id: PaneId;
  role: PaneRole;
  terminal: InstanceType<typeof Terminal>;
  pty: pty.IPty;
  status: PaneStatus;
  exitCode?: number;
  writeQueue: Promise<void>;
  pendingOutput: string;
  flushTimer?: NodeJS.Timeout;
}

interface DuplexRuntimeMutableState {
  panes: Map<PaneId, PaneHandle>;
  paneBackends: Map<PaneId, InteractiveCliBackend>;
  mailboxDeliveryInFlight: Set<string>;
  idleTimers: Partial<Record<PaneId, NodeJS.Timeout>>;
  paneSessionDiscoveryInFlight: Set<PaneId>;
  paneSessionDiscoveryQueue: Partial<Record<InteractiveBackendId, Promise<void>>>;
  paneSessionIds: Partial<Record<PaneId, string>>;
  paneSessionBaselines: Partial<Record<PaneId, string[]>>;
  recentPaneActivityAt: Record<PaneId, number>;
  recentUserInputAt: Record<PaneId, number>;
}

interface DuplexRuntimeCallbacks {
  getInteractiveSessionState(): InteractiveSessionState;
  setInteractiveSessionState(state: InteractiveSessionState): void;
  saveInteractiveSessionState(state: InteractiveSessionState): Promise<void>;
  getDeliveryPaused(): boolean;
  setDeliveryPaused(value: boolean): void;
  getDeliveredTurns(): number;
  setDeliveredTurns(value: number): void;
  getMaxTurns(): number;
  getRecentMailboxDeliveryAt(): number;
  setRecentMailboxDeliveryAt(value: number): void;
  setMailboxCache(value: { at: number; leftUnread: number; rightUnread: number }): void;
  getMailboxCache(): { at: number; leftUnread: number; rightUnread: number };
  setBrokerHint(value: string): void;
  getLatestLineIndex(id: PaneId): number;
  preserveScrolledViewport(id: PaneId, previousLatestLine: number): void;
  queueRender(): void;
  renderNow(): void;
  reportError(scope: string, error: unknown): void;
  setNotice(message: string): void;
  getPaneDimensions(): { paneCols: number; paneRows: number };
}

export class DuplexRuntime {
  private readonly options: {
    workspaceDir: string;
    newSession: boolean;
    toolBinDir: string;
    broker: BrokerClient;
    defaultInteractiveBackendId?: InteractiveBackendId;
    explicitPaneBackendIds: Partial<Record<PaneId, InteractiveBackendId>>;
    paneRoles: Record<PaneId, PaneRole>;
    state: DuplexRuntimeMutableState;
    callbacks: DuplexRuntimeCallbacks;
  };

  constructor(options: {
    workspaceDir: string;
    newSession: boolean;
    toolBinDir: string;
    defaultInteractiveBackendId?: InteractiveBackendId;
    explicitPaneBackendIds: Partial<Record<PaneId, InteractiveBackendId>>;
    paneRoles: Record<PaneId, PaneRole>;
    state: DuplexRuntimeMutableState;
    callbacks: DuplexRuntimeCallbacks;
  }) {
    this.options = options;
  }

  restartPane(id: PaneId): void {
    const oldPane = this.options.state.panes.get(id);
    if (oldPane) {
      void this.interruptAndKillPane(oldPane);
    }

    const { paneCols, paneRows } = this.options.callbacks.getPaneDimensions();
    void this.startPane(id, paneCols, paneRows).then(() => {
      this.options.callbacks.queueRender();
    });
  }

  async startPane(id: PaneId, cols: number, rows: number): Promise<void> {
    const backend = this.resolvePaneBackend(id);
    const stored = this.options.callbacks.getInteractiveSessionState().panes[id];
    const resume =
      !this.options.newSession &&
      stored?.backend === backend.id &&
      backend.supportsSessionResume &&
      backend.autoResumeOnWorkspaceRestore;
    const assignedSessionId =
      !resume && backend.supportsAssignedSessionId ? backend.createAssignedSessionId?.() : undefined;
    const launchSessionId = resume ? stored?.sessionId : assignedSessionId;
    const persistedSessionId = launchSessionId;

    this.options.state.paneBackends.set(id, backend);
    this.options.state.paneSessionIds[id] = launchSessionId;
    if (backend.discoverSessionId) {
      this.options.state.paneSessionBaselines[id] = this.collectKnownSessionIds(backend.id);
    } else {
      delete this.options.state.paneSessionBaselines[id];
    }

    this.options.state.panes.set(id, this.spawnPane(id, backend, cols, rows, {
      resume,
      sessionId: launchSessionId
    }));

    void this.persistPaneSession(id, backend.id, persistedSessionId).catch((error) => {
      this.options.callbacks.reportError(`persist-pane-session:${id}`, error);
    });
  }

  resolvePaneBackend(id: PaneId): InteractiveCliBackend {
    const explicit = this.options.explicitPaneBackendIds[id];
    if (explicit) {
      return createInteractiveBackend(explicit);
    }

    if (this.options.defaultInteractiveBackendId) {
      return createInteractiveBackend(this.options.defaultInteractiveBackendId);
    }

    const stored = this.options.callbacks.getInteractiveSessionState().panes[id]?.backend;
    if (stored) {
      return createInteractiveBackend(stored);
    }

    return createInteractiveBackend(undefined);
  }

  async persistPaneSession(id: PaneId, backendId: InteractiveBackendId, sessionId: string | undefined): Promise<void> {
    const state = this.options.callbacks.getInteractiveSessionState();
    state.panes[id] = {
      backend: backendId,
      sessionId,
      updatedAt: new Date().toISOString()
    };
    this.options.callbacks.setInteractiveSessionState(state);
    await this.options.callbacks.saveInteractiveSessionState(state);
  }

  async capturePaneSessionId(id: PaneId, data: string): Promise<void> {
    const backend = this.options.state.paneBackends.get(id);
    if (!backend) {
      return;
    }

    if (!this.options.state.paneSessionIds[id] && backend.extractSessionIdFromOutput) {
      const parsed = backend.extractSessionIdFromOutput(data);
      if (parsed) {
        this.options.state.paneSessionIds[id] = parsed;
        await this.persistPaneSession(id, backend.id, parsed);
        return;
      }
    }

    if (
      !this.options.state.paneSessionIds[id] &&
      backend.discoverSessionId &&
      backend.autoResumeOnWorkspaceRestore &&
      this.options.state.panes.get(id)?.status === "running" &&
      !this.options.state.paneSessionDiscoveryInFlight.has(id)
    ) {
      this.options.state.paneSessionDiscoveryInFlight.add(id);
      const previous = this.options.state.paneSessionDiscoveryQueue[backend.id] ?? Promise.resolve();
      const task = previous
        .catch(() => undefined)
        .then(async () => {
          if (this.options.state.paneSessionIds[id]) {
            return;
          }

          const baseline = this.options.state.paneSessionBaselines[id] ?? [];
          const known = [...new Set([...baseline, ...this.collectKnownSessionIds(backend.id)])];
          const discovered = backend.discoverSessionId?.(this.options.workspaceDir, known);
          if (!discovered || this.collectKnownSessionIds(backend.id).includes(discovered)) {
            this.options.state.paneSessionBaselines[id] = known;
            return;
          }

          this.options.state.paneSessionIds[id] = discovered;
          await this.persistPaneSession(id, backend.id, discovered);
          this.options.state.paneSessionBaselines[id] = [...new Set([...known, discovered])];
        })
        .finally(() => {
          this.options.state.paneSessionDiscoveryInFlight.delete(id);
          if (this.options.state.paneSessionDiscoveryQueue[backend.id] === task) {
            delete this.options.state.paneSessionDiscoveryQueue[backend.id];
          }
        });
      this.options.state.paneSessionDiscoveryQueue[backend.id] = task;
      await task;
    }
  }

  async interruptAndKillPane(pane: PaneHandle): Promise<void> {
    if (pane.flushTimer) {
      clearTimeout(pane.flushTimer);
      pane.flushTimer = undefined;
    }

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

  readMailboxUnreadCounts(): { leftUnread: number; rightUnread: number } {
    return this.options.callbacks.getMailboxCache();
  }

  async refreshBrokerCache(): Promise<void> {
    try {
      const counts = await this.options.broker.getUnreadCounts();
      const diagnostics = await this.options.broker.getBrokerDiagnostics({
        cooldownMs: 1200,
        lastDeliveryAt: this.options.callbacks.getRecentMailboxDeliveryAt()
      });
      this.options.callbacks.setMailboxCache({
        at: Date.now(),
        leftUnread: counts.left,
        rightUnread: counts.right
      });
      this.options.callbacks.setBrokerHint(formatBrokerHint(diagnostics, {
        maxTurns: this.options.callbacks.getMaxTurns(),
        deliveredTurns: this.options.callbacks.getDeliveredTurns()
      }));
      this.options.callbacks.renderNow();
    } catch (error) {
      this.options.callbacks.reportError("broker-cache", error);
    }
  }

  async notePeerActivity(id: PaneId, status: "busy" | "idle" | "waiting" | "integrating"): Promise<void> {
    this.options.state.recentPaneActivityAt[id] = Date.now();
    try {
      const existing = this.options.state.idleTimers[id];
      if (existing) {
        clearTimeout(existing);
        delete this.options.state.idleTimers[id];
      }

      await this.options.broker.upsertPeerState({
        id,
        role: this.options.paneRoles[id],
        status
      });

      if (status === "busy" || status === "integrating") {
        this.options.state.idleTimers[id] = setTimeout(() => {
          delete this.options.state.idleTimers[id];
          void this.options.broker.upsertPeerState({
            id,
            role: this.options.paneRoles[id],
            status: "idle"
          });
        }, 1800);
      }
    } catch {
      // Ignore peer-state bookkeeping failures in the UI loop.
    }
  }

  async pollMailboxDeliveries(): Promise<void> {
    try {
      if (this.options.callbacks.getDeliveryPaused()) {
        await this.refreshBrokerCache();
        return;
      }

      if (this.options.callbacks.getMaxTurns() > 0 && this.options.callbacks.getDeliveredTurns() >= this.options.callbacks.getMaxTurns()) {
        this.options.callbacks.setDeliveryPaused(true);
        this.options.callbacks.setNotice(
          `Turn limit reached (${this.options.callbacks.getDeliveredTurns()}/${this.options.callbacks.getMaxTurns()}). Use /resume after raising the limit if you want to continue.`
        );
        await this.refreshBrokerCache();
        return;
      }

      if (Date.now() - this.options.callbacks.getRecentMailboxDeliveryAt() < 1200) {
        await this.refreshBrokerCache();
        return;
      }

      const snapshot = await this.options.broker.readBrokerSnapshot();
      const message = snapshot.messages.find(
        (entry) =>
          !entry.deliveredAt &&
          !this.options.state.mailboxDeliveryInFlight.has(entry.id) &&
          (entry.to === "left" || entry.to === "right")
      );
      if (!message) {
        return;
      }

      const target = message.to as PaneId;
      const pane = this.options.state.panes.get(target);
      if (!pane || pane.status === "exited") {
        return;
      }

      if (!this.isPaneReadyForDelivery(target)) {
        await this.refreshBrokerCache();
        return;
      }

      this.options.state.mailboxDeliveryInFlight.add(message.id);
      try {
        await this.notePeerActivity(target, target === "left" ? "integrating" : "busy");
        await this.typeSubmittedMessageIntoPane(pane, formatInjectedMessage(message, this.options.paneRoles[target]));
        if (!message.id.includes("__merge__")) {
          await this.options.broker.markMessageDelivered(message.id);
        }
        this.options.callbacks.setRecentMailboxDeliveryAt(Date.now());
        this.options.callbacks.setDeliveredTurns(this.options.callbacks.getDeliveredTurns() + 1);
        this.options.callbacks.setNotice(`Delivered ${message.kind} from ${message.from} to ${message.to}.`);
        await this.refreshBrokerCache();
        this.options.callbacks.renderNow();
      } finally {
        this.options.state.mailboxDeliveryInFlight.delete(message.id);
      }
    } catch (error) {
      this.options.callbacks.reportError("mailbox-delivery", error);
    }
  }

  private spawnPane(
    id: PaneId,
    backend: InteractiveCliBackend,
    cols: number,
    rows: number,
    options: { resume: boolean; sessionId?: string }
  ): PaneHandle {
    const launch = resolvePaneLaunch(backend.command, backend.buildInteractiveArgs({
      sessionId: options.sessionId,
      resume: options.resume
    }));

    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true
    });

    const child = pty.spawn(launch.command, launch.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.options.workspaceDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PATH: buildPanePath(this.options.toolBinDir, backend.extraPath, process.env.PATH)
      }
    });

    const pane: PaneHandle = {
      id,
      role: this.options.paneRoles[id],
      terminal,
      pty: child,
      status: "starting",
      writeQueue: Promise.resolve(),
      pendingOutput: ""
    };

    child.onData((data) => {
      pane.status = "running";
      this.options.state.recentPaneActivityAt[id] = Date.now();
      void this.capturePaneSessionId(id, data);
      pane.pendingOutput += data;
      if (pane.flushTimer) {
        return;
      }

      pane.flushTimer = setTimeout(() => {
        pane.flushTimer = undefined;
        const buffered = pane.pendingOutput;
        if (!buffered) {
          return;
        }
        pane.pendingOutput = "";
        const previousLatestLine = this.options.callbacks.getLatestLineIndex(id);
        pane.writeQueue = pane.writeQueue
          .then(
            () =>
              new Promise<void>((resolve) => {
                pane.terminal.write(buffered, resolve);
              })
          )
          .then(() => {
            this.options.callbacks.preserveScrolledViewport(id, previousLatestLine);
            this.options.callbacks.queueRender();
          })
          .catch((error) => {
            this.options.callbacks.reportError("pty-write:" + id, error);
          });
      }, 12);
    });

    child.onExit(({ exitCode }) => {
      pane.status = "exited";
      pane.exitCode = exitCode;
      void this.notePeerActivity(id, "waiting");
      this.options.callbacks.setNotice(`${id} exited with code ${exitCode}. Use F1 then /restart ${id}.`);
      this.options.callbacks.queueRender();
    });

    return pane;
  }

  private collectKnownSessionIds(backendId: InteractiveBackendId): string[] {
    return Object.values(this.options.callbacks.getInteractiveSessionState().panes)
      .filter((pane): pane is NonNullable<typeof pane> => Boolean(pane))
      .filter((pane) => pane.backend === backendId && Boolean(pane.sessionId))
      .map((pane) => pane.sessionId!);
  }

  private isPaneReadyForDelivery(id: PaneId): boolean {
    const pane = this.options.state.panes.get(id);
    if (!pane || pane.status === "exited") {
      return false;
    }

    const lastActivityAt = this.options.state.recentPaneActivityAt[id] ?? 0;
    if (lastActivityAt === 0) {
      return true;
    }

    return Date.now() - lastActivityAt >= 1800;
  }

  private async typeSubmittedMessageIntoPane(pane: PaneHandle, message: string): Promise<void> {
    this.options.state.recentUserInputAt[pane.id] = Date.now();
    for (const char of message) {
      pane.pty.write(char);
      await delay(18);
    }
    await delay(120);
    pane.pty.write("\r");
  }
}

function buildPanePath(toolBinDir: string, backendBinDir: string | undefined, existingPath: string | undefined): string {
  const segments = [toolBinDir];
  if (backendBinDir) {
    segments.push(backendBinDir);
  }
  if (existingPath) {
    segments.push(existingPath);
  }
  return segments.join(";");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function formatBrokerHint(diagnostics: {
  peers: Record<PaneId, { status: string }>;
  pending: Record<PaneId, number>;
  blockedReason: "none" | "cooldown" | "no_pending";
  cooldownRemainingMs: number;
  quietRemainingMs: Record<PaneId, number>;
  nextTarget?: PaneId;
}, turns: {
  maxTurns: number;
  deliveredTurns: number;
}): string {
  if (turns.maxTurns > 0 && turns.deliveredTurns >= turns.maxTurns) {
    return `broker:L${diagnostics.peers.left.status}/R${diagnostics.peers.right.status} qL${diagnostics.pending.left} qR${diagnostics.pending.right} next:turn_limit`;
  }
  const next = diagnostics.nextTarget
    ? diagnostics.nextTarget
    : diagnostics.blockedReason === "cooldown"
      ? `cooldown:${diagnostics.cooldownRemainingMs}ms`
      : diagnostics.blockedReason;
  return `broker:L${diagnostics.peers.left.status}/R${diagnostics.peers.right.status} qL${diagnostics.pending.left} qR${diagnostics.pending.right} next:${next}`;
}

function resolvePaneLaunch(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }

  const extension = command.toLowerCase().slice(command.lastIndexOf("."));
  if (extension === ".exe") {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", quoteCmdCommand(command, args)]
  };
}

function quoteCmdCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCmdArg).join(" ");
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}
