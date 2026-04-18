import type { AgentId } from "../types/agent.ts";
import type { AgentProvider, ProviderInput, ProviderResult } from "./Provider.ts";

export type VerificationScenario =
  | "default"
  | "no-progress"
  | "handoff-limit"
  | "human-confirmation"
  | "provider-recovery";

const TOKENS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

export class ScenarioProvider implements AgentProvider {
  readonly name: string;
  private readonly scenario: Exclude<VerificationScenario, "default" | "provider-recovery">;
  private readonly perAgentRound: Record<AgentId, number> = {
    left: 0,
    right: 0
  };

  constructor(scenario: Exclude<VerificationScenario, "default" | "provider-recovery">) {
    this.scenario = scenario;
    this.name = `scenario:${scenario}`;
  }

  async send(input: ProviderInput): Promise<ProviderResult> {
    this.perAgentRound[input.agentId] += 1;
    return {
      output: buildScenarioOutput(this.scenario, input, this.perAgentRound[input.agentId]),
      exitCode: 0
    };
  }

  async getSessionInfo(): Promise<null> {
    return null;
  }

  async resetSession(agentId: AgentId): Promise<void> {
    this.perAgentRound[agentId] = 0;
  }
}

function buildScenarioOutput(
  scenario: Exclude<VerificationScenario, "default" | "provider-recovery">,
  input: ProviderInput,
  localRound: number
): string {
  switch (scenario) {
    case "no-progress":
      return buildNoProgressOutput(input, localRound);
    case "handoff-limit":
      return buildHandoffLimitOutput(input, localRound);
    case "human-confirmation":
      return buildHumanConfirmationOutput(input, localRound);
  }
}

function buildNoProgressOutput(input: ProviderInput, localRound: number): string {
  if (input.agentId === "left") {
    const repeated = [
      "Role: builder",
      `Round: ${input.round}`,
      "Result:",
      "- Built the split-pane shell and wired command routing.",
      "- Added a coordinator summary block for the current workflow."
    ];

    return repeated.join("\n");
  }

  return [
    "Role: reviewer",
    `Round: ${input.round}`,
    "Review:",
    `- Reviewed the builder handoff on local round ${localRound}.`,
    "- Primary risk: repeated builder output could hide a no-progress loop."
  ].join("\n");
}

function buildHandoffLimitOutput(input: ProviderInput, localRound: number): string {
  if (input.agentId === "left") {
    const variant = BUILDER_HANDOFF_LIMIT_VARIANTS[(localRound - 1) % BUILDER_HANDOFF_LIMIT_VARIANTS.length];
    return [
      "Role: builder",
      `Round: ${input.round}`,
      "Result:",
      `- ${variant.result}`,
      `- ${variant.followUp}`
    ].join("\n");
  }

  const variant = REVIEWER_HANDOFF_LIMIT_VARIANTS[(localRound - 1) % REVIEWER_HANDOFF_LIMIT_VARIANTS.length];
  return [
    "Role: reviewer",
    `Round: ${input.round}`,
    "Review:",
    `- ${variant.result}`,
    `- ${variant.followUp}`
  ].join("\n");
}

function buildHumanConfirmationOutput(input: ProviderInput, localRound: number): string {
  if (input.agentId === "left") {
    return [
      "Role: builder",
      `Round: ${input.round}`,
      "Result:",
      `- Prepared the next scheduler iteration on local round ${localRound}.`,
      "- Left a clear build summary for reviewer follow-up."
    ].join("\n");
  }

  return [
    "Role: reviewer",
    `Round: ${input.round}`,
    "Review:",
    "- The current branch strategy is unclear.",
    "- Please confirm whether the next step should stay in auto mode or wait for a human checkpoint."
  ].join("\n");
}

const BUILDER_HANDOFF_LIMIT_VARIANTS = [
  {
    result: "Sketched a console-first split layout with a compact coordinator banner and fresh telemetry labels.",
    followUp: "Prepared a wiring note that maps manual takeover commands to the left and right panes."
  },
  {
    result: "Reworked the event rail into a paged inspection strip with separate focus and browsing affordances.",
    followUp: "Captured a routing note for how review feedback should re-enter the builder queue."
  },
  {
    result: "Outlined a recovery workflow that distinguishes transport faults from deliberate operator stops.",
    followUp: "Added a checkpoint describing how retries should preserve pending work across interruptions."
  },
  {
    result: "Prepared a long-run verification pass that records halt categories alongside per-agent issue labels.",
    followUp: "Wrote a follow-up note for extending the scheduler with additional scenario drills."
  }
];

const REVIEWER_HANDOFF_LIMIT_VARIANTS = [
  {
    result: "Reviewed the layout pass and flagged navigation clarity around the inspection shortcuts.",
    followUp: "Recommended a concise footer legend so the operator can see which pane owns direct input."
  },
  {
    result: "Checked the inspection rail and highlighted the need for explicit newest-versus-oldest paging cues.",
    followUp: "Suggested keeping event and handoff browsing semantics aligned before adding more panes."
  },
  {
    result: "Reviewed the recovery workflow and focused on user-visible distinctions between retries and manual checkpoints.",
    followUp: "Asked for a concise status surface that exposes halt kind before reopening automation."
  },
  {
    result: "Validated the long-run drill output and focused on making scenario summaries easier to compare side by side.",
    followUp: "Recommended preserving a short scenario label in every verification summary for quick scanning."
  }
];
