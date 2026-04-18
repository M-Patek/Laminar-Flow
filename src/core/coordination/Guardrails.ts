import { MAX_AUTO_HANDOFFS, MAX_CONSECUTIVE_AUTO_TURNS } from "../../config/defaults.ts";
import type { AppSnapshot } from "../../types/app.ts";
import type { AgentId } from "../../types/agent.ts";

export interface GuardrailDecision {
  ok: boolean;
  code?: "handoff_limit" | "repeated_handoff" | "auto_turn_limit";
  reason: string;
  repeated: boolean;
}

export function evaluateGuardrails(snapshot: AppSnapshot, summary: string): GuardrailDecision {
  if (snapshot.coordinator.handoffCount >= MAX_AUTO_HANDOFFS) {
    return {
      ok: false,
      code: "handoff_limit",
      reason: `Auto-handoff limit reached (${MAX_AUTO_HANDOFFS}).`,
      repeated: false
    };
  }

  if (snapshot.coordinator.lastHandoffSummary && isRepeatedSummary(snapshot.coordinator.lastHandoffSummary, summary)) {
    return {
      ok: false,
      code: "repeated_handoff",
      reason: "Detected a repeated handoff summary.",
      repeated: true
    };
  }

  return {
    ok: true,
    code: undefined,
    reason: "Guardrails passed.",
    repeated: false
  };
}

export function evaluateAutoTurnStreak(snapshot: AppSnapshot, agentId: AgentId): GuardrailDecision {
  if (
    snapshot.coordinator.autoTurnStreakAgent === agentId &&
    snapshot.coordinator.autoTurnStreakCount >= MAX_CONSECUTIVE_AUTO_TURNS
  ) {
    return {
      ok: false,
      code: "auto_turn_limit",
      reason: `Auto-turn streak limit reached for ${agentId} (${MAX_CONSECUTIVE_AUTO_TURNS}).`,
      repeated: false
    };
  }

  return {
    ok: true,
    code: undefined,
    reason: "Auto-turn streak passed.",
    repeated: false
  };
}

function isRepeatedSummary(previous: string, next: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

  const a = normalize(previous);
  const b = normalize(next);
  if (!a || !b) {
    return false;
  }

  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  const similarity = overlap / Math.max(aTokens.size, bTokens.size);
  return similarity >= 0.9;
}
