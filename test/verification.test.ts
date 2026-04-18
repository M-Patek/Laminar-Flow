import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runLongRunVerification,
  runVerificationMatrix,
  writeVerificationReport
} from "../src/app/verification.ts";
import { loadVerificationReports } from "../src/ui/reports.ts";

async function withWorkspace<T>(run: (workspaceDir: string) => Promise<T>): Promise<T> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "duplex-codex-verify-test-"));
  try {
    return await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test("verification scenario no-progress halts with no_progress", async () => {
  const summary = await withWorkspace((workspaceDir) =>
    runLongRunVerification({ workspaceDir, scenario: "no-progress" })
  );

  assert.equal(summary.provider, "scenario:no-progress");
  assert.equal(summary.haltKind, "no_progress");
  assert.equal(summary.left.issueKind, "no_progress");
  assert.match(summary.artifactDir, /verification/);
});

test("verification scenario handoff-limit reaches the handoff limit guardrail", async () => {
  const summary = await withWorkspace((workspaceDir) =>
    runLongRunVerification({ workspaceDir, scenario: "handoff-limit" })
  );

  assert.equal(summary.provider, "scenario:handoff-limit");
  assert.equal(summary.haltKind, "handoff_limit");
  assert.equal(summary.handoffs, 6);
});

test("verification scenario human-confirmation stops on a review confirmation request", async () => {
  const summary = await withWorkspace((workspaceDir) =>
    runLongRunVerification({ workspaceDir, scenario: "human-confirmation" })
  );

  assert.equal(summary.provider, "scenario:human-confirmation");
  assert.equal(summary.haltKind, "human_confirmation");
  assert.equal(summary.right.issueKind, "human_confirmation");
});

test("verification scenario provider-recovery retries provider failures before halting", async () => {
  const summary = await withWorkspace((workspaceDir) =>
    runLongRunVerification({ workspaceDir, scenario: "provider-recovery" })
  );

  assert.equal(summary.provider, "flaky");
  assert.match(summary.recoveryActions.join(" | "), /retry:left:/);
  assert.match(summary.recoveryActions.join(" | "), /retry:right:/);
  assert.equal(summary.haltKind, "human_confirmation");
});

test("verification matrix runs all built-in scenarios and can write a report", async () => {
  await withWorkspace(async (workspaceDir) => {
    const matrix = await runVerificationMatrix({ workspaceDir });
    const reportPath = await writeVerificationReport(workspaceDir, "verify-matrix-test", matrix);
    const reports = await loadVerificationReports(workspaceDir);

    assert.deepEqual(matrix.scenarios, [
      "no-progress",
      "handoff-limit",
      "human-confirmation",
      "provider-recovery"
    ]);
    assert.equal(matrix.results.length, 4);
    assert.equal(matrix.counts.byHaltKind.no_progress, 1);
    assert.equal(matrix.counts.byHaltKind.handoff_limit, 1);
    assert.equal(matrix.counts.byHaltKind.human_confirmation, 2);
    assert.equal(reports[0]?.kind, "matrix");
    assert.equal(reports[0]?.path, reportPath);
    await access(reportPath);
  });
});

test("verification matrix can include the default provider scenario", async () => {
  await withWorkspace(async (workspaceDir) => {
    const matrix = await runVerificationMatrix({ workspaceDir, includeDefault: true });

    assert.deepEqual(matrix.scenarios, [
      "default",
      "no-progress",
      "handoff-limit",
      "human-confirmation",
      "provider-recovery"
    ]);
    assert.equal(matrix.results.length, 5);
    assert.equal(matrix.results[0]?.scenario, "default");
    assert.equal(matrix.results[0]?.provider, "mock");
    assert.match(matrix.results[0]?.artifactDir ?? "", /verification/);
  });
});
