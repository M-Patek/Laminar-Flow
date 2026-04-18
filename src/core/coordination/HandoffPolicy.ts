import type { AgentId, AgentRole } from "../../types/agent.ts";

export interface HandoffDraft {
  target: AgentId;
  body: string;
  summary: string;
  ask: string;
  risk: string;
  requiresHuman: boolean;
  reason: string;
}

export function createHandoffDraft(
  from: AgentId,
  to: AgentId,
  fromRole: AgentRole,
  toRole: AgentRole,
  latestOutput: string
): HandoffDraft {
  const normalizedLines = latestOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^role:\s*/i.test(line) && !/^round:\s*/i.test(line));
  const result = summarizeResult(normalizedLines, latestOutput);
  const summary = summarizeSummary(result);
  const risk = inferRisk(normalizedLines, fromRole, toRole);
  const context = `Structured handoff from ${from} (${fromRole}) to ${to} (${toRole}). Continue the same workspace task without redoing accepted work.`;
  const requiresHuman = /(confirm|choose|unclear|error|failed|permission|blocked|确认|选择|失败|报错)/i.test(latestOutput);
  const ask =
    fromRole === "builder" && toRole === "reviewer"
      ? "Review this result, identify concrete risks, and propose the next action."
      : "Use this review to refine the next implementation step.";

  return {
    target: to,
    summary,
    ask,
    risk,
    requiresHuman,
    reason: requiresHuman ? "The output asks for human confirmation." : "Ready for structured handoff.",
    body: [
      "Context:",
      context,
      "",
      "Result:",
      result,
      "",
      "Risk:",
      risk,
      "",
      "Ask:",
      ask
    ].join("\n")
  };
}

function summarizeResult(lines: string[], raw: string): string {
  const candidates = lines
    .map(cleanBullet)
    .filter(Boolean)
    .filter((line) => !/^result:?$/i.test(line) && !/^review:?$/i.test(line));
  const compact = (candidates.slice(0, 3).join(" ") || raw).replace(/\s+/g, " ").trim();
  if (compact.length <= 240) {
    return compact;
  }

  return `${compact.slice(0, 237)}...`;
}

function summarizeSummary(result: string): string {
  if (result.length <= 160) {
    return result;
  }

  return `${result.slice(0, 157)}...`;
}

function inferRisk(lines: string[], fromRole: AgentRole, toRole: AgentRole): string {
  const explicit = lines
    .map(cleanBullet)
    .find((line) => /risk|blocker|blocked|missing|todo|repeat|guardrail|error|failure/i.test(line));
  if (explicit) {
    return explicit;
  }

  if (fromRole === "builder" && toRole === "reviewer") {
    return "Check for regressions, missing tests, and loop-prone follow-up steps before handing work back.";
  }

  return "Carry forward the accepted constraints, avoid repeating prior work, and focus on the next concrete step.";
}

function cleanBullet(line: string): string {
  return line.replace(/^[-*]\s*/, "").trim();
}
