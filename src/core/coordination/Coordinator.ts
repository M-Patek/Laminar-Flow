import type { AgentId } from "../../types/agent.ts";
import type { Message } from "../../types/message.ts";
import { createId } from "../../utils/id.ts";
import { AgentRegistry } from "../agents/AgentRegistry.ts";
import type { AgentRunResult } from "../agents/AgentSession.ts";
import { StateStore } from "../state/StateStore.ts";
import { evaluateAutoTurnStreak, evaluateGuardrails } from "./Guardrails.ts";
import { createHandoffDraft } from "./HandoffPolicy.ts";

export class Coordinator {
  private readonly agents: AgentRegistry;
  private readonly store: StateStore;

  constructor(agents: AgentRegistry, store: StateStore) {
    this.agents = agents;
    this.store = store;
  }

  async sendUserMessage(target: AgentId, body: string): Promise<string> {
    const snapshot = this.store.getSnapshot();
    const coordinatorState = snapshot.coordinator;
    const message: Message = {
      id: createId("msg"),
      kind: "user",
      from: "user",
      to: target,
      body,
      round: snapshot.agents[target].round,
      createdAt: new Date().toISOString(),
      requiresHuman: false
    };

    await this.store.addMessage(message);
    await this.agents.get(target).enqueue(message);
    await this.store.setAgentStatus(target, "waiting_message", {
      currentIntent: "Queued a user instruction."
    });

    if (isTakenOver(coordinatorState, target)) {
      return `Queued for ${target}; ${target} is under manual takeover.`;
    }

    if (coordinatorState.mode === "step") {
      return `Queued for ${target}; use /step ${target} when ready.`;
    }

    if (coordinatorState.status !== "active") {
      return `Queued for ${target}; coordinator is ${coordinatorState.status}.`;
    }

    const advanceResult = await this.advanceAgent(target, "manual");
    return advanceResult === `Advanced ${target}.` ? `Sent to ${target}.` : advanceResult;
  }

  async broadcast(body: string): Promise<string> {
    await this.sendUserMessage("left", body);
    await this.sendUserMessage("right", body);
    return "Broadcast queued for both agents.";
  }

  async advanceAgent(agentId: AgentId, source: "manual" | "auto" = "manual"): Promise<string> {
    const snapshot = this.store.getSnapshot();
    const coordinator = snapshot.coordinator;
    if (coordinator.status === "paused") {
      return "Coordinator is paused. Use /resume or send a manual handoff later.";
    }

    if (source === "auto" && isTakenOver(coordinator, agentId)) {
      const reason = `${agentId} is under manual takeover. Use /step ${agentId} to continue there.`;
      await this.store.patchCoordinator({
        lastDecision: reason
      });
      return reason;
    }

    if (coordinator.maxTurns > 0 && coordinator.turnCount >= coordinator.maxTurns) {
      const reason = `Reached max turns (${coordinator.maxTurns}).`;
      await this.store.setCoordinatorStatus("halted", {
        haltKind: "turn_limit",
        haltReason: reason,
        lastDecision: reason
      });
      return reason;
    }

    if (source === "auto") {
      const streak = evaluateAutoTurnStreak(snapshot, agentId);
      if (!streak.ok) {
        await this.store.setCoordinatorStatus("halted", {
          haltKind: streak.code === "auto_turn_limit" ? "auto_turn_limit" : undefined,
          haltReason: streak.reason,
          lastDecision: streak.reason
        });
        return streak.reason;
      }
    }

    const session = this.agents.get(agentId);
    const result = await session.advance();
    if (!result) {
      const latest = this.store.getSnapshot().agents[agentId];
      if (latest.status === "error") {
        return `Advance failed for ${agentId}; queued work was preserved.`;
      }

      return `No queued work for ${agentId}.`;
    }

    if (source === "auto") {
      const sameAgent = snapshot.coordinator.autoTurnStreakAgent === agentId;
      await this.store.patchCoordinator({
        autoTurnStreakAgent: agentId,
        autoTurnStreakCount: sameAgent ? snapshot.coordinator.autoTurnStreakCount + 1 : 1,
        turnCount: snapshot.coordinator.turnCount + 1,
        activeAgent: agentId
      });
    } else {
      await this.store.patchCoordinator({
        autoTurnStreakAgent: undefined,
        autoTurnStreakCount: 0,
        turnCount: snapshot.coordinator.turnCount + 1,
        activeAgent: agentId
      });
    }

    await this.store.addMessage(result.outputMessage);
    await this.handleAgentCompletion(agentId, result);
    return `Advanced ${agentId}.`;
  }

  async retryAgent(target?: AgentId): Promise<string> {
    const snapshot = this.store.getSnapshot();
    const agentId = target ?? pickRetryTarget(snapshot);
    if (!agentId) {
      return "No retryable agent found.";
    }

    const agent = snapshot.agents[agentId];
    if (agent.status === "error" || agent.status === "needs_human") {
      await this.resumeAgent(agentId);
    }

    const result = await this.advanceAgent(agentId, "manual");
    return target ? result : `Retry target ${agentId}: ${result}`;
  }

  async takeoverAgent(agentId: AgentId): Promise<string> {
    const snapshot = this.store.getSnapshot();
    if (isTakenOver(snapshot.coordinator, agentId)) {
      return `${agentId} is already under manual takeover.`;
    }

    await this.store.patchCoordinator({
      takenOverAgents: [...snapshot.coordinator.takenOverAgents, agentId],
      lastDecision: `Manual takeover enabled for ${agentId}.`
    });
    await this.store.addUiEvent("coordinator", `Manual takeover enabled for ${agentId}.`);
    await this.store.patchAgent(agentId, {
      currentIntent: "Under manual takeover. Use /step, /handoff, /resume, or /reset."
    });
    return `Manual takeover enabled for ${agentId}.`;
  }

  async releaseAgent(agentId: AgentId): Promise<string> {
    const snapshot = this.store.getSnapshot();
    if (!isTakenOver(snapshot.coordinator, agentId)) {
      return `${agentId} is not under manual takeover.`;
    }

    const remaining = snapshot.coordinator.takenOverAgents.filter((value) => value !== agentId);
    await this.store.patchCoordinator({
      takenOverAgents: remaining,
      lastDecision: `Manual takeover released for ${agentId}.`
    });
    await this.store.addUiEvent("coordinator", `Manual takeover released for ${agentId}.`);
    await this.store.patchAgent(agentId, {
      currentIntent: buildReleasedIntent(snapshot, agentId)
    });
    return `Manual takeover released for ${agentId}.`;
  }

  async resumeAgent(agentId: AgentId): Promise<string> {
    const nextStatus = await this.agents.get(agentId).resumeFromIntervention();
    await this.store.addUiEvent("agent", `${agentId} resumed to ${nextStatus}.`);
    return `${agentId} resumed to ${nextStatus}.`;
  }

  async resetAgent(agentId: AgentId): Promise<string> {
    await this.agents.get(agentId).reset();
    const snapshot = this.store.getSnapshot();
    if (snapshot.coordinator.status === "halted") {
      await this.store.setCoordinatorStatus("active", {
        haltKind: undefined,
        haltReason: undefined,
        autoTurnStreakAgent: undefined,
        autoTurnStreakCount: 0,
        lastDecision: `Reset ${agentId} after halt.`
      });
    } else {
      await this.store.patchCoordinator({
        activeAgent: snapshot.coordinator.activeAgent === agentId ? undefined : snapshot.coordinator.activeAgent,
        lastDecision: `Reset ${agentId}.`
      });
    }

    await this.store.addUiEvent("agent", `${agentId} session and local state were reset.`);
    return `${agentId} reset complete.`;
  }

  async handoff(from: AgentId): Promise<string> {
    const snapshot = this.store.getSnapshot();
    const fromState = snapshot.agents[from];
    const to = from === "left" ? "right" : "left";
    const toState = snapshot.agents[to];

    if (!fromState.lastOutput) {
      return `No output available on ${from}.`;
    }

    const draft = createHandoffDraft(from, to, fromState.role, toState.role, fromState.lastOutput);
    if (draft.requiresHuman) {
      await this.store.setCoordinatorStatus("halted", {
        haltKind: "human_confirmation",
        haltReason: draft.reason,
        lastDecision: draft.reason
      });
      await this.store.setAgentStatus(from, "needs_human", {
        currentIntent: "Waiting for a human decision before handoff.",
        lastErrorKind: "human_confirmation"
      });
      return draft.reason;
    }

    const guardrail = evaluateGuardrails(snapshot, draft.summary);
    if (!guardrail.ok) {
      await this.store.setCoordinatorStatus("halted", {
        haltKind:
          guardrail.code === "handoff_limit"
            ? "handoff_limit"
            : guardrail.code === "repeated_handoff"
              ? "repeated_handoff"
              : undefined,
        haltReason: guardrail.reason,
        lastDecision: guardrail.reason,
        repetitionCount: guardrail.repeated ? snapshot.coordinator.repetitionCount + 1 : snapshot.coordinator.repetitionCount
      });
      return guardrail.reason;
    }

    const handoffMessage: Message = {
      id: createId("msg"),
      kind: "handoff",
      from,
      to,
      body: draft.body,
      summary: draft.summary,
      round: snapshot.agents[from].round,
      createdAt: new Date().toISOString(),
      requiresHuman: false
    };

    await this.store.addMessage(handoffMessage);
    await this.store.recordHandoff(from, to, handoffMessage.id);
    await this.store.patchCoordinator({
      handoffCount: snapshot.coordinator.handoffCount + 1,
      repetitionCount: 0,
      lastDecision: `Handoff ${from} -> ${to}`,
      lastHandoffFrom: from,
      lastHandoffTo: to,
      lastHandoffSummary: draft.summary,
      lastHandoffAsk: draft.ask,
      lastHandoffRisk: draft.risk,
      activeAgent: to
    });

    await this.agents.get(to).enqueue(handoffMessage);
    await this.store.setAgentStatus(to, "waiting_message", {
      currentIntent: isTakenOver(snapshot.coordinator, to)
        ? `Queued a handoff from ${from}. Manual takeover is holding ${to}.`
        : `Queued a handoff from ${from}.`
    });

    await this.store.setAgentStatus(from, "waiting_handoff", {
      currentIntent: `Last output handed off to ${to}.`
    });

    if (
      this.store.getSnapshot().coordinator.mode === "auto" &&
      this.store.getSnapshot().coordinator.status === "active" &&
      !isTakenOver(this.store.getSnapshot().coordinator, to)
    ) {
      await this.advanceAgent(to, "auto");
    }

    return `Handed off ${from} -> ${to}.`;
  }

  async setMode(mode: "manual" | "step" | "auto"): Promise<string> {
    await this.store.setCoordinatorMode(mode);
    await this.store.patchCoordinator({
      haltKind: undefined,
      haltReason: undefined,
      autoTurnStreakAgent: undefined,
      autoTurnStreakCount: 0
    });
    return `Coordinator mode set to ${mode}.`;
  }

  async setMaxTurns(value: number): Promise<string> {
    const snapshot = this.store.getSnapshot();
    await this.store.patchCoordinator({
      maxTurns: value,
      lastDecision: value > 0 ? `Max turns set to ${value}.` : "Max turns disabled."
    });
    await this.store.addUiEvent("coordinator", value > 0 ? `Max turns set to ${value}.` : "Max turns disabled.");

    if (value > 0 && snapshot.coordinator.turnCount >= value) {
      const reason = `Reached max turns (${value}).`;
      await this.store.setCoordinatorStatus("halted", {
        haltKind: "turn_limit",
        haltReason: reason,
        lastDecision: reason
      });
      return `${reason} Use /max-turns <larger> then /resume to continue.`;
    }

    return value > 0 ? `Max turns set to ${value}.` : "Max turns disabled.";
  }

  async turns(): Promise<string> {
    const coordinator = this.store.getSnapshot().coordinator;
    return `turns=${coordinator.turnCount} | max=${coordinator.maxTurns > 0 ? coordinator.maxTurns : "unlimited"}`;
  }

  async pause(): Promise<string> {
    await this.store.setCoordinatorStatus("paused", {
      lastDecision: "Paused by user."
    });
    await this.store.addUiEvent("coordinator", "Coordinator paused by user.");
    return "Coordinator paused.";
  }

  async resume(): Promise<string> {
    await this.store.setCoordinatorStatus("active", {
      haltKind: undefined,
      haltReason: undefined,
      repetitionCount: 0,
      autoTurnStreakAgent: undefined,
      autoTurnStreakCount: 0,
      lastDecision: "Resumed by user."
    });
    await this.store.addUiEvent("coordinator", "Coordinator resumed by user.");
    return "Coordinator resumed.";
  }

  async status(): Promise<string> {
    const snapshot = this.store.getSnapshot();
    const left = snapshot.agents.left;
    const right = snapshot.agents.right;
    const coordinator = snapshot.coordinator;

    return [
      `mode=${coordinator.mode}`,
      `status=${coordinator.status}`,
      `turns=${coordinator.turnCount}/${coordinator.maxTurns > 0 ? coordinator.maxTurns : "inf"}`,
      `left=${left.status} q=${left.queuedMessages} round=${left.round}`,
      `right=${right.status} q=${right.queuedMessages} round=${right.round}`,
      coordinator.takenOverAgents.length > 0 ? `takeover=${coordinator.takenOverAgents.join(",")}` : null,
      left.sessionId ? `leftSession=${shortSession(left.sessionId)}` : null,
      right.sessionId ? `rightSession=${shortSession(right.sessionId)}` : null,
      coordinator.lastHandoffFrom && coordinator.lastHandoffTo
        ? `handoff=${coordinator.lastHandoffFrom}->${coordinator.lastHandoffTo}`
        : null,
      coordinator.haltKind ? `haltKind=${coordinator.haltKind}` : null,
      coordinator.lastHandoffRisk ? `risk=${coordinator.lastHandoffRisk}` : null,
      coordinator.haltReason ? `halt=${coordinator.haltReason}` : null
    ]
      .filter(Boolean)
      .join(" | ");
  }

  async events(): Promise<string> {
    const events = this.store
      .getSnapshot()
      .recentEvents.slice(-6)
      .map((event) => `[${formatClock(event.at)}] ${event.scope}: ${event.message}`);

    return events.length > 0 ? events.join(" | ") : "No recent events.";
  }

  async clearEvents(): Promise<string> {
    await this.store.clearUiEvents();
    return "Event feed cleared.";
  }

  private async handleAgentCompletion(agentId: AgentId, result: AgentRunResult): Promise<void> {
    const coordinator = this.store.getSnapshot().coordinator;
    if (coordinator.mode === "auto" && result.noProgress) {
      const reason = `Detected no-progress repeat from ${agentId}.`;
      await this.store.setCoordinatorStatus("halted", {
        haltKind: "no_progress",
        haltReason: reason,
        lastDecision: reason
      });
      await this.store.setAgentStatus(agentId, "needs_human", {
        currentIntent: "Output repeated without progress. Inspect before continuing.",
        lastError: reason,
        lastErrorKind: "no_progress"
      });
      return;
    }

    await this.store.setAgentStatus(agentId, "waiting_handoff", {
      currentIntent: result.noProgress
        ? "Repeated output detected. Review before handing off."
        : "Finished a round. Ready for handoff."
    });

    if (coordinator.mode === "auto" && isTakenOver(coordinator, agentId)) {
      await this.store.patchCoordinator({
        lastDecision: `${agentId} is under manual takeover; auto handoff paused.`
      });
      return;
    }

    if (coordinator.mode === "auto" && coordinator.status === "active") {
      await this.handoff(agentId);
    }
  }
}

function pickRetryTarget(snapshot: ReturnType<StateStore["getSnapshot"]>): AgentId | undefined {
  const preferred = snapshot.coordinator.activeAgent;
  const candidates: AgentId[] = preferred ? [preferred, "left", "right"] : ["left", "right"];

  for (const agentId of candidates) {
    const agent = snapshot.agents[agentId];
    if (agent.queuedMessages > 0 || agent.status === "error" || agent.status === "needs_human") {
      return agentId;
    }
  }

  return undefined;
}

function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function isTakenOver(
  coordinator: Pick<ReturnType<StateStore["getSnapshot"]>["coordinator"], "takenOverAgents">,
  agentId: AgentId
): boolean {
  return coordinator.takenOverAgents.includes(agentId);
}

function buildReleasedIntent(snapshot: ReturnType<StateStore["getSnapshot"]>, agentId: AgentId): string {
  const agent = snapshot.agents[agentId];
  if (agent.status === "error") {
    return "Manual takeover released. Use /resume <agent> or /retry <agent>.";
  }

  if (agent.queuedMessages > 0) {
    return "Manual takeover released. Queued work is ready.";
  }

  if (agent.lastOutput) {
    return "Manual takeover released. Last output can be handed off.";
  }

  return "Manual takeover released. Waiting for the next instruction.";
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleTimeString("en-GB", { hour12: false });
}
