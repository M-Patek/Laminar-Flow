import type { AgentProvider, ProviderInput, ProviderResult } from "./Provider.ts";

function buildMockOutput(input: ProviderInput): string {
  const normalized = input.prompt.replace(/\s+/g, " ").trim();
  const excerpt = normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;

  if (input.role === "builder" || input.role === "executor") {
    return [
      `Role: ${input.role}`,
      `Round: ${input.round}`,
      "Result:",
      `- I received the task context: ${excerpt}`,
      "- I propose splitting the work into UI, coordination, state, and provider layers.",
      "- Next concrete action: hand this summary to the reviewer and ask for risk checks."
    ].join("\n");
  }

  return [
    `Role: ${input.role}`,
    `Round: ${input.round}`,
    "Review:",
    `- I reviewed the latest handoff: ${excerpt}`,
    "- Primary risk: uncontrolled auto-handoff loops without repetition guards.",
    "- Next concrete action: return a short checklist to the builder."
  ].join("\n");
}

export class MockProvider implements AgentProvider {
  readonly name = "mock";

  async send(input: ProviderInput): Promise<ProviderResult> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      output: buildMockOutput(input),
      exitCode: 0
    };
  }

  async getSessionInfo(): Promise<null> {
    return null;
  }

  async resetSession(): Promise<void> {}
}
