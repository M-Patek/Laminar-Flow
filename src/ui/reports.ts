import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DUPLEX_DIR } from "../config/defaults.ts";
import type { SelectedUiEntry } from "./inspection.ts";

export interface VerificationReportEntry {
  id: string;
  path: string;
  name: string;
  kind: "long" | "matrix" | "unknown";
  generatedAt?: string;
  summary: string;
  raw: string;
}

export async function loadVerificationReports(
  workspaceDir: string,
  limit = 12
): Promise<VerificationReportEntry[]> {
  const reportsDir = path.join(workspaceDir, DUPLEX_DIR, "verification", "reports");
  let names: string[];

  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const reports: VerificationReportEntry[] = [];
  for (const name of names) {
    const reportPath = path.join(reportsDir, name);
    const raw = await readFile(reportPath, "utf8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }

    reports.push(describeReport(reportPath, name, raw, parsed));
  }

  return reports;
}

export function selectReportByRank(
  reports: VerificationReportEntry[],
  rank: number
): SelectedUiEntry | undefined {
  if (rank < 1) {
    return undefined;
  }

  const report = reports[rank - 1];
  return report ? { id: report.id, rank } : undefined;
}

export function selectReportByOffset(
  reports: VerificationReportEntry[],
  currentRank: number,
  offset: number
): SelectedUiEntry | undefined {
  return selectReportByRank(reports, currentRank + offset);
}

export function findReportById(
  reports: VerificationReportEntry[],
  reportId: string | undefined
): VerificationReportEntry | undefined {
  if (!reportId) {
    return undefined;
  }

  return reports.find((report) => report.id === reportId);
}

function describeReport(
  reportPath: string,
  name: string,
  raw: string,
  parsed: unknown
): VerificationReportEntry {
  if (isMatrixReport(parsed)) {
    return {
      id: reportPath,
      path: reportPath,
      name,
      kind: "matrix",
      generatedAt: parsed.generatedAt,
      summary: `${parsed.scenarios.length} scenarios | halted ${parsed.counts.halted} | active ${parsed.counts.active}`,
      raw
    };
  }

  if (isLongReport(parsed)) {
    return {
      id: reportPath,
      path: reportPath,
      name,
      kind: "long",
      generatedAt: parsed.generatedAt ?? parsed.createdAt,
      summary: `${parsed.scenario} | ${parsed.provider} | ${parsed.status}${parsed.haltKind ? ` | ${parsed.haltKind}` : ""}`,
      raw
    };
  }

  return {
    id: reportPath,
    path: reportPath,
    name,
    kind: "unknown",
    summary: "Unrecognized verification report payload.",
    raw
  };
}

function isMatrixReport(
  value: unknown
): value is {
  generatedAt?: string;
  scenarios: string[];
  counts: {
    halted: number;
    active: number;
  };
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { scenarios?: unknown }).scenarios) &&
      typeof (value as { counts?: { halted?: unknown; active?: unknown } }).counts?.halted === "number" &&
      typeof (value as { counts?: { halted?: unknown; active?: unknown } }).counts?.active === "number"
  );
}

function isLongReport(
  value: unknown
): value is {
  generatedAt?: string;
  createdAt?: string;
  scenario: string;
  provider: string;
  status: string;
  haltKind?: string;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { scenario?: unknown }).scenario === "string" &&
      typeof (value as { provider?: unknown }).provider === "string" &&
      typeof (value as { status?: unknown }).status === "string"
  );
}
