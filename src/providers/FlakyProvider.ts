import type { AgentId } from "../types/agent.ts";
import type { AgentProvider, ProviderInput, ProviderResult } from "./Provider.ts";

export class FlakyProvider implements AgentProvider {
  readonly name = "flaky";
  private readonly failedAgents = new Set<AgentId>();

  async send(input: ProviderInput): Promise<ProviderResult> {
    if (!this.failedAgents.has(input.agentId)) {
      this.failedAgents.add(input.agentId);
      return {
        output: "",
        exitCode: 1,
        rawStderr: `Injected flaky failure for ${input.agentId} on round ${input.round}.`
      };
    }

    return {
      output: buildOutput(input),
      exitCode: 0
    };
  }

  async getSessionInfo(): Promise<null> {
    return null;
  }

  async resetSession(agentId: AgentId): Promise<void> {
    this.failedAgents.delete(agentId);
  }
}

function buildOutput(input: ProviderInput): string {
  const normalized = input.prompt.replace(/\s+/g, " ").trim();
  const excerpt = normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;

  if (input.role === "builder" || input.role === "executor") {
    return [
      `Role: ${input.role}`,
      `Round: ${input.round}`,
      "Result:",
      `- Recovered after a flaky provider interruption: ${excerpt}`,
      "- Updated the local scheduler flow with clearer failure handling.",
      "- Primary risk: recovery paths need explicit visibility in the coordinator."
    ].join("\n");
  }

  return [
    `Role: ${input.role}`,
    `Round: ${input.round}`,
    "Review:",
    `- Reviewed the recovered handoff: ${excerpt}`,
    "- Primary risk: repeated handoff loops after recovery are still possible.",
    "- Next concrete action: confirm the builder retry path and stop conditions."
  ].join("\n");
}
