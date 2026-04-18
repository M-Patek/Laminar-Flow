import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DUPLEX_DIR, EVENT_LOG_FILE, SNAPSHOT_FILE, createDefaultSnapshot } from "../config/defaults.ts";
import { AgentRegistry } from "../core/agents/AgentRegistry.ts";
import { AgentSession } from "../core/agents/AgentSession.ts";
import { Coordinator } from "../core/coordination/Coordinator.ts";
import { defaultIntentForRole } from "../core/coordination/rules.ts";
import { EventLog } from "../core/state/EventLog.ts";
import { SnapshotStore } from "../core/state/SnapshotStore.ts";
import { StateStore } from "../core/state/StateStore.ts";
import { FlakyProvider } from "../providers/FlakyProvider.ts";
import { createProvider } from "../providers/createProvider.ts";
import { ScenarioProvider, type VerificationScenario } from "../providers/ScenarioProvider.ts";
import type { AgentId } from "../types/agent.ts";
import type { AgentProvider } from "../providers/Provider.ts";

const DEFAULT_VERIFY_PROMPT =
  "Run a short builder-reviewer collaboration drill for this local dual-agent scheduler and surface the next concrete risk.";

const MAX_RECOVERY_ATTEMPTS = 2;

export interface VerificationSummary {
  scenario: VerificationScenario;
  provider: string;
  artifactDir: string;
  status: string;
  haltKind?: string;
  haltReason?: string;
  recoveryActions: string[];
  left: {
    status: string;
    round: number;
    issueKind?: string;
  };
  right: {
    status: string;
    round: number;
    issueKind?: string;
  };
  handoffs: number;
  turns: number;
}

export interface VerificationMatrixSummary {
  generatedAt: string;
  scenarios: VerificationScenario[];
  results: VerificationSummary[];
  counts: {
    halted: number;
    active: number;
    byHaltKind: Record<string, number>;
  };
}

export const BUILT_IN_VERIFY_SCENARIOS: ReadonlyArray<Exclude<VerificationScenario, "default">> = [
  "no-progress",
  "handoff-limit",
  "human-confirmation",
  "provider-recovery"
];

export async function runLongRunVerification(options?: {
  workspaceDir?: string;
  scenario?: VerificationScenario;
  initialPrompt?: string;
  maxRecoveryAttempts?: number;
}): Promise<VerificationSummary> {
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const scenario = options?.scenario ?? resolveScenarioFromEnv();
  const verificationRoot = path.join(workspaceDir, DUPLEX_DIR, "verification", scenario);
  const provider = createVerificationProvider(workspaceDir, verificationRoot, scenario);
  const snapshotStore = new SnapshotStore(verificationRoot, SNAPSHOT_FILE);
  const eventLog = new EventLog(verificationRoot, EVENT_LOG_FILE);
  const store = new StateStore(createDefaultSnapshot(), eventLog, snapshotStore);

  await store.patchAgent("left", {
    currentIntent: defaultIntentForRole(store.getSnapshot().agents.left.role)
  });
  await store.patchAgent("right", {
    currentIntent: defaultIntentForRole(store.getSnapshot().agents.right.role)
  });
  await store.patchCoordinator({
    lastDecision: `Verification provider: ${provider.name} | scenario: ${scenario}`
  });
  await store.addUiEvent("system", `Verification started with provider ${provider.name} for scenario ${scenario}.`);

  const snapshot = store.getSnapshot();
  const agents = new AgentRegistry({
    left: new AgentSession("left", snapshot.agents.left.role, provider, store),
    right: new AgentSession("right", snapshot.agents.right.role, provider, store)
  });
  await agents.get("left").syncProviderState();
  await agents.get("right").syncProviderState();

  const coordinator = new Coordinator(agents, store);
  await coordinator.setMode("auto");

  const recoveryCounts: Partial<Record<AgentId, number>> = {};
  const recoveryActions: string[] = [];
  const initialPrompt = options?.initialPrompt ?? process.env.DUPLEX_VERIFY_PROMPT ?? DEFAULT_VERIFY_PROMPT;
  const maxRecoveryAttempts = options?.maxRecoveryAttempts ?? MAX_RECOVERY_ATTEMPTS;

  const sendResult = await coordinator.sendUserMessage("left", initialPrompt);
  recoveryActions.push(`initial-send:${sendResult}`);

  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    const current = store.getSnapshot();
    const recoverableAgent = findRecoverableAgent(current);
    if (!recoverableAgent) {
      continue;
    }

    const attempts = recoveryCounts[recoverableAgent] ?? 0;
    if (attempts >= maxRecoveryAttempts) {
      continue;
    }

    recoveryCounts[recoverableAgent] = attempts + 1;
    const retryResult = await coordinator.retryAgent(recoverableAgent);
    recoveryActions.push(`retry:${recoverableAgent}:${retryResult}`);
    madeProgress = true;
  }

  const finalSnapshot = store.getSnapshot();
  return {
    scenario,
    provider: provider.name,
    artifactDir: verificationRoot,
    status: finalSnapshot.coordinator.status,
    haltKind: finalSnapshot.coordinator.haltKind,
    haltReason: finalSnapshot.coordinator.haltReason,
    recoveryActions,
    left: {
      status: finalSnapshot.agents.left.status,
      round: finalSnapshot.agents.left.round,
      issueKind: finalSnapshot.agents.left.lastErrorKind
    },
    right: {
      status: finalSnapshot.agents.right.status,
      round: finalSnapshot.agents.right.round,
      issueKind: finalSnapshot.agents.right.lastErrorKind
    },
    handoffs: finalSnapshot.coordinator.handoffCount,
    turns: finalSnapshot.coordinator.turnCount
  };
}

export async function runVerificationMatrix(options?: {
  workspaceDir?: string;
  includeDefault?: boolean;
  scenarios?: VerificationScenario[];
}): Promise<VerificationMatrixSummary> {
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const scenarios =
    options?.scenarios ??
    (options?.includeDefault
      ? (["default", ...BUILT_IN_VERIFY_SCENARIOS] as VerificationScenario[])
      : [...BUILT_IN_VERIFY_SCENARIOS]);
  const results: VerificationSummary[] = [];

  for (const scenario of scenarios) {
    results.push(
      await runLongRunVerification({
        workspaceDir,
        scenario
      })
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    scenarios,
    results,
    counts: summarizeMatrix(results)
  };
}

export async function writeVerificationReport(
  workspaceDir: string,
  reportName: string,
  payload: VerificationSummary | VerificationMatrixSummary
): Promise<string> {
  const reportsDir = path.join(workspaceDir, DUPLEX_DIR, "verification", "reports");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `${reportName}-${timestamp}.json`);
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(payload, null, 2), "utf8");
  return reportPath;
}

export function resolveScenarioFromEnv(): VerificationScenario {
  const scenario = (process.env.DUPLEX_VERIFY_SCENARIO ?? "default").toLowerCase();
  switch (scenario) {
    case "default":
    case "no-progress":
    case "handoff-limit":
    case "human-confirmation":
    case "provider-recovery":
      return scenario;
    default:
      throw new Error(
        `Unsupported DUPLEX_VERIFY_SCENARIO: ${scenario}. Expected default, no-progress, handoff-limit, human-confirmation, or provider-recovery.`
      );
  }
}

function createVerificationProvider(
  workspaceDir: string,
  verificationRoot: string,
  scenario: VerificationScenario
): AgentProvider {
  switch (scenario) {
    case "default":
      return createProvider(workspaceDir, {
        runtimeDir: path.join(verificationRoot, "provider")
      });
    case "provider-recovery":
      return new FlakyProvider();
    case "no-progress":
    case "handoff-limit":
    case "human-confirmation":
      return new ScenarioProvider(scenario);
  }
}

function findRecoverableAgent(snapshot: ReturnType<StateStore["getSnapshot"]>): AgentId | undefined {
  for (const agentId of ["left", "right"] as const) {
    const agent = snapshot.agents[agentId];
    if (agent.status === "error" && agent.lastErrorKind === "provider_failure") {
      return agentId;
    }
  }

  return undefined;
}

function summarizeMatrix(results: VerificationSummary[]): VerificationMatrixSummary["counts"] {
  const byHaltKind: Record<string, number> = {};
  for (const result of results) {
    const key = result.haltKind ?? "none";
    byHaltKind[key] = (byHaltKind[key] ?? 0) + 1;
  }

  return {
    halted: results.filter((result) => result.status === "halted").length,
    active: results.filter((result) => result.status === "active").length,
    byHaltKind
  };
}
