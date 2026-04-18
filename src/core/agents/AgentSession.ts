import type { AgentId, AgentRole } from "../../types/agent.ts";
import type { Message } from "../../types/message.ts";
import type { AgentProvider, ProviderResult } from "../../providers/Provider.ts";
import { createId } from "../../utils/id.ts";
import { defaultIntentForRole } from "../coordination/rules.ts";
import { StateStore } from "../state/StateStore.ts";

export interface AgentRunResult {
  outputMessage: Message;
  rawOutput: string;
  noProgress: boolean;
}

export class AgentSession {
  private readonly queue: Message[] = [];
  private running = false;
  readonly id: AgentId;
  readonly role: AgentRole;
  private readonly provider: AgentProvider;
  private readonly store: StateStore;

  constructor(id: AgentId, role: AgentRole, provider: AgentProvider, store: StateStore) {
    this.id = id;
    this.role = role;
    this.provider = provider;
    this.store = store;
  }

  async enqueue(message: Message): Promise<void> {
    this.queue.push(message);
    await this.store.updateQueuedMessages(this.id, this.queue.length);
  }

  hasQueuedWork(): boolean {
    return this.queue.length > 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  async advance(): Promise<AgentRunResult | null> {
    if (this.running || this.queue.length === 0) {
      return null;
    }

    this.running = true;
    const previousOutput = this.store.getSnapshot().agents[this.id].lastOutput ?? "";
    const inbound = [...this.queue];
    this.queue.length = 0;
    await this.store.updateQueuedMessages(this.id, 0);
    await this.store.setAgentStatus(this.id, "running", {
      currentIntent: "Running the next round.",
      lastError: undefined,
      lastErrorKind: undefined
    });

    const round = await this.store.incrementAgentRound(this.id);
    const prompt = this.buildPrompt(inbound);
    let result: ProviderResult;
    try {
      result = await this.provider.send({
        agentId: this.id,
        role: this.role,
        prompt,
        round
      });
    } catch (error) {
      this.running = false;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordSystemError(`provider:${this.provider.name}`, `${this.id} send failed: ${message}`);
      return this.failRun(inbound, message);
    }

    this.running = false;

    if (result.exitCode !== 0 || !result.output.trim()) {
      return this.failRun(
        inbound,
        result.rawStderr || result.rawStdout || `Provider exited with code ${result.exitCode}.`,
        result.sessionId
      );
    }

    const summary = summarize(result.output);
    const outputMessage: Message = {
      id: createId("msg"),
      kind: "agent_output",
      from: this.id,
      to: "system",
      body: result.output.trim(),
      summary,
      round,
      createdAt: new Date().toISOString(),
      requiresHuman: false
    };

    await this.store.recordAgentCompletion(this.id, outputMessage.body);
    await this.store.patchAgent(this.id, {
      lastOutputSummary: summary,
      lastErrorKind: undefined,
      sessionId: result.sessionId,
      sessionUpdatedAt: result.sessionId ? new Date().toISOString() : undefined
    });
    return {
      outputMessage,
      rawOutput: result.output.trim(),
      noProgress: hasNoProgress(previousOutput, result.output)
    };
  }

  private async failRun(
    inbound: Message[],
    errorMessage: string,
    sessionId?: string
  ): Promise<null> {
    this.queue.unshift(...inbound);
    await this.store.updateQueuedMessages(this.id, this.queue.length);
    await this.store.setAgentStatus(this.id, "error", {
      lastError: errorMessage,
      lastErrorKind: "provider_failure",
      currentIntent: "Waiting for /retry, /resume <agent>, or /reset <agent>.",
      sessionId
    });
    return null;
  }

  async syncProviderState(): Promise<void> {
    const info = await this.provider.getSessionInfo?.(this.id);
    await this.store.patchAgent(this.id, {
      sessionId: info?.sessionId,
      sessionUpdatedAt: info?.updatedAt
    });
  }

  async reset(): Promise<void> {
    this.queue.length = 0;
    this.running = false;
    await this.provider.resetSession?.(this.id);
    await this.store.updateQueuedMessages(this.id, 0);
    await this.store.patchAgent(this.id, {
      status: "idle",
      round: 0,
      lastActionAt: undefined,
      lastOutput: undefined,
      lastOutputSummary: undefined,
      lastError: undefined,
      lastErrorKind: undefined,
      currentIntent: defaultIntentForRole(this.role),
      sessionId: undefined,
      sessionUpdatedAt: undefined
    });
  }

  async resumeFromIntervention(): Promise<"idle" | "waiting_message" | "waiting_handoff"> {
    const snapshot = this.store.getSnapshot();
    const agent = snapshot.agents[this.id];
    const nextStatus = this.queue.length > 0 ? "waiting_message" : agent.lastOutput ? "waiting_handoff" : "idle";
    const nextIntent =
      nextStatus === "waiting_message"
        ? "Queued work is ready to run."
        : nextStatus === "waiting_handoff"
          ? "Last output is ready for handoff or manual review."
          : defaultIntentForRole(this.role);

    await this.store.setAgentStatus(this.id, nextStatus, {
      currentIntent: nextIntent,
      lastError: undefined,
      lastErrorKind: undefined
    });
    return nextStatus;
  }

  private buildPrompt(inbound: Message[]): string {
    const snapshot = this.store.getSnapshot();
    const transcript = snapshot.recentMessages
      .filter((message) => message.from === this.id || message.to === this.id)
      .slice(-6)
      .map((message) => `${message.from} -> ${message.to}: ${message.body}`)
      .join("\n");

    const inbox = inbound
      .map((message) => `${message.kind} from ${message.from}: ${message.body}`)
      .join("\n");

    return [
      `You are the ${this.role} agent in a dual-agent terminal orchestrator.`,
      "Work crisply and return a concise, actionable response.",
      "",
      "Recent transcript:",
      transcript || "(empty)",
      "",
      "New inbox:",
      inbox || "(empty)"
    ].join("\n");
  }
}

function summarize(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) {
    return compact;
  }

  return `${compact.slice(0, 217)}...`;
}

function hasNoProgress(previous: string, current: string): boolean {
  if (!previous.trim()) {
    return false;
  }

  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/round:\s*\d+/g, " ")
      .replace(/\b\d+\b/g, " ")
      .replace(/[^a-z]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const a = normalize(previous);
  const b = normalize(current);
  if (!a || !b) {
    return false;
  }

  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  return overlap / Math.max(aTokens.size, bTokens.size) >= 0.92;
}
