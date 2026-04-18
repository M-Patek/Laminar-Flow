import { EventEmitter } from "node:events";
import { MAX_RECENT_EVENTS, MAX_RECENT_MESSAGES } from "../../config/defaults.ts";
import type { AgentId, AgentSessionState, AgentStatus } from "../../types/agent.ts";
import type { AppEvent, AppSnapshot, UiEventRecord } from "../../types/app.ts";
import type { CoordinatorMode, CoordinatorState, CoordinatorStatus } from "../../types/coordinator.ts";
import type { Message } from "../../types/message.ts";
import { createId } from "../../utils/id.ts";
import { EventLog } from "./EventLog.ts";
import { SnapshotStore } from "./SnapshotStore.ts";

type StoreListener = (snapshot: AppSnapshot) => void;

export class StateStore {
  private readonly emitter = new EventEmitter();
  private snapshot: AppSnapshot;
  private readonly eventLog: EventLog;
  private readonly snapshotStore: SnapshotStore;

  constructor(snapshot: AppSnapshot, eventLog: EventLog, snapshotStore: SnapshotStore) {
    snapshot.recentMessages ??= [];
    snapshot.recentEvents ??= [];
    this.snapshot = snapshot;
    this.eventLog = eventLog;
    this.snapshotStore = snapshotStore;
  }

  getSnapshot(): AppSnapshot {
    return structuredClone(this.snapshot);
  }

  subscribe(listener: StoreListener): () => void {
    this.emitter.on("change", listener);
    return () => {
      this.emitter.off("change", listener);
    };
  }

  async addMessage(message: Message): Promise<void> {
    this.snapshot.recentMessages.push(message);
    if (this.snapshot.recentMessages.length > MAX_RECENT_MESSAGES) {
      this.snapshot.recentMessages.splice(0, this.snapshot.recentMessages.length - MAX_RECENT_MESSAGES);
    }

    await this.commit({
      type: "message.created",
      payload: message
    });
  }

  async patchAgent(agentId: AgentId, patch: Partial<AgentSessionState>): Promise<void> {
    const current = this.snapshot.agents[agentId];
    const previousStatus = current.status;
    Object.assign(current, patch);

    if (patch.status && patch.status !== previousStatus) {
      const event: AppEvent = {
        type: "agent.status_changed",
        payload: {
          agentId,
          from: previousStatus,
          to: patch.status
        }
      };
      await this.eventLog.append(event);
      this.pushUiEvent(describeEvent(event));
    }

    await this.persist();
  }

  async setAgentStatus(agentId: AgentId, status: AgentStatus, extras: Partial<AgentSessionState> = {}): Promise<void> {
    await this.patchAgent(agentId, {
      ...extras,
      status
    });
  }

  async updateQueuedMessages(agentId: AgentId, queuedMessages: number): Promise<void> {
    await this.patchAgent(agentId, { queuedMessages });
  }

  async incrementAgentRound(agentId: AgentId): Promise<number> {
    const agent = this.snapshot.agents[agentId];
    agent.round += 1;
    const event: AppEvent = {
      type: "agent.run_started",
      payload: {
        agentId,
        round: agent.round
      }
    };
    await this.eventLog.append(event);
    this.pushUiEvent(describeEvent(event));
    await this.persist();
    return agent.round;
  }

  async recordAgentCompletion(agentId: AgentId, output: string): Promise<void> {
    const agent = this.snapshot.agents[agentId];
    agent.lastOutput = output;
    agent.lastActionAt = new Date().toISOString();

    await this.commit({
      type: "agent.run_completed",
      payload: {
        agentId,
        round: agent.round,
        output
      }
    });
  }

  async patchCoordinator(patch: Partial<CoordinatorState>): Promise<void> {
    Object.assign(this.snapshot.coordinator, patch);
    await this.persist();
  }

  async setCoordinatorMode(mode: CoordinatorMode): Promise<void> {
    const previous = this.snapshot.coordinator.mode;
    this.snapshot.coordinator.mode = mode;
    this.snapshot.coordinator.status = "active";

    await this.commit({
      type: "coordinator.mode_changed",
      payload: {
        from: previous,
        to: mode
      }
    });
  }

  async setCoordinatorStatus(status: CoordinatorStatus, extras: Partial<CoordinatorState> = {}): Promise<void> {
    Object.assign(this.snapshot.coordinator, extras, { status });

    if (status === "halted" && extras.haltReason) {
      const event: AppEvent = {
        type: "coordinator.halted",
        payload: {
          kind: extras.haltKind,
          reason: extras.haltReason
        }
      };
      await this.eventLog.append(event);
      this.pushUiEvent(describeEvent(event));
    }

    await this.persist();
  }

  async recordSystemError(scope: string, message: string): Promise<void> {
    await this.commit({
      type: "system.error",
      payload: {
        scope,
        message
      }
    });
  }

  async addUiEvent(scope: UiEventRecord["scope"], message: string): Promise<void> {
    this.pushUiEvent({
      id: createId("evt"),
      at: new Date().toISOString(),
      scope,
      message
    });
    await this.persist();
  }

  async clearUiEvents(): Promise<void> {
    this.snapshot.recentEvents = [];
    await this.persist();
  }

  async recordHandoff(from: AgentId, to: AgentId, messageId: string): Promise<void> {
    await this.commit({
      type: "handoff.created",
      payload: {
        from,
        to,
        messageId
      }
    });
  }

  private async commit(event: AppEvent): Promise<void> {
    await this.eventLog.append(event);
    this.pushUiEvent(describeEvent(event));
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.snapshot.updatedAt = new Date().toISOString();
    await this.snapshotStore.save(this.snapshot);
    this.emitter.emit("change", this.getSnapshot());
  }

  private pushUiEvent(event: UiEventRecord): void {
    this.snapshot.recentEvents.push(event);
    if (this.snapshot.recentEvents.length > MAX_RECENT_EVENTS) {
      this.snapshot.recentEvents.splice(0, this.snapshot.recentEvents.length - MAX_RECENT_EVENTS);
    }
  }
}

function describeEvent(event: AppEvent): UiEventRecord {
  const at = new Date().toISOString();

  switch (event.type) {
    case "message.created":
      return {
        id: createId("evt"),
        at,
        scope: "message",
        message: `${event.payload.kind} ${event.payload.from} -> ${event.payload.to}`
      };
    case "agent.status_changed":
      return {
        id: createId("evt"),
        at,
        scope: "agent",
        message: `${event.payload.agentId} status ${event.payload.from} -> ${event.payload.to}`
      };
    case "agent.run_started":
      return {
        id: createId("evt"),
        at,
        scope: "agent",
        message: `${event.payload.agentId} started round ${event.payload.round}`
      };
    case "agent.run_completed":
      return {
        id: createId("evt"),
        at,
        scope: "agent",
        message: `${event.payload.agentId} completed round ${event.payload.round}`
      };
    case "handoff.created":
      return {
        id: createId("evt"),
        at,
        scope: "coordinator",
        message: `handoff ${event.payload.from} -> ${event.payload.to}`
      };
    case "coordinator.mode_changed":
      return {
        id: createId("evt"),
        at,
        scope: "coordinator",
        message: `mode ${event.payload.from} -> ${event.payload.to}`
      };
    case "coordinator.halted":
      return {
        id: createId("evt"),
        at,
        scope: "coordinator",
        message: event.payload.kind
          ? `halted [${event.payload.kind}]: ${event.payload.reason}`
          : `halted: ${event.payload.reason}`
      };
    case "system.error":
      return {
        id: createId("evt"),
        at,
        scope: "system",
        message: `${event.payload.scope}: ${event.payload.message}`
      };
  }
}
