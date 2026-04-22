import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type BackendId = "codex" | "gemini" | "claude";

export interface BackendDescriptor {
  id: BackendId;
  displayName: string;
  defaultCommand: string;
  windowsSearch: string[];
  windowsFallbacks: string[];
  supportsSessionResume: boolean;
  supportsAssignedSessionId: boolean;
  providerSessionStoreFileName: string;
}

const DESCRIPTORS: Record<BackendId, BackendDescriptor> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    defaultCommand: "codex",
    windowsSearch: ["codex.cmd", "codex"],
    windowsFallbacks: [
      path.join(process.env.USERPROFILE ?? "", "anaconda3", "codex.cmd"),
      path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "codex.cmd")
    ],
    supportsSessionResume: true,
    supportsAssignedSessionId: false,
    providerSessionStoreFileName: "codex-sessions.json"
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini CLI",
    defaultCommand: "gemini",
    windowsSearch: ["gemini.cmd", "gemini"],
    windowsFallbacks: [
      path.join(process.env.USERPROFILE ?? "", "anaconda3", "gemini.cmd"),
      path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "gemini.cmd")
    ],
    supportsSessionResume: true,
    supportsAssignedSessionId: false,
    providerSessionStoreFileName: "gemini-sessions.json"
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    defaultCommand: "claude",
    windowsSearch: ["claude.exe", "claude"],
    windowsFallbacks: [
      path.join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe"),
      path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "claude.cmd")
    ],
    supportsSessionResume: true,
    supportsAssignedSessionId: true,
    providerSessionStoreFileName: "claude-sessions.json"
  }
};

const resolvedCommandCache = new Map<BackendId, { command: string; extraPath?: string }>();

export function parseBackendId(value: string | undefined): BackendId | undefined {
  if (value === "codex" || value === "gemini" || value === "claude") {
    return value;
  }

  return undefined;
}

export function getBackendDescriptor(id: BackendId): BackendDescriptor {
  return DESCRIPTORS[id];
}

export function resolveBackendCommand(id: BackendId): { command: string; extraPath?: string } {
  const cached = resolvedCommandCache.get(id);
  if (cached) {
    return cached;
  }

  const descriptor = getBackendDescriptor(id);
  let resolved: { command: string; extraPath?: string };
  if (process.platform !== "win32") {
    resolved = { command: descriptor.defaultCommand };
    resolvedCommandCache.set(id, resolved);
    return resolved;
  }

  const whereMatch = resolveWindowsExecutable(descriptor.windowsSearch);
  if (whereMatch) {
    resolved = {
      command: whereMatch,
      extraPath: path.dirname(whereMatch)
    };
    resolvedCommandCache.set(id, resolved);
    return resolved;
  }

  const fallback = descriptor.windowsFallbacks.find((candidate) => existsSync(candidate));
  if (fallback) {
    resolved = {
      command: fallback,
      extraPath: path.dirname(fallback)
    };
    resolvedCommandCache.set(id, resolved);
    return resolved;
  }

  resolved = { command: descriptor.defaultCommand };
  resolvedCommandCache.set(id, resolved);
  return resolved;
}

function resolveWindowsExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const whereResult = spawnSync("where.exe", [candidate], {
      encoding: "utf8",
      windowsHide: true
    });

    if (whereResult.status !== 0) {
      continue;
    }

    const matches = whereResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const match = preferWindowsCommand(matches);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function preferWindowsCommand(matches: string[]): string | undefined {
  const existing = matches.filter((candidate) => existsSync(candidate));
  if (existing.length === 0) {
    return matches[0];
  }

  const ranked = existing
    .map((candidate) => ({
      candidate,
      rank: windowsCommandRank(candidate)
    }))
    .sort((left, right) => right.rank - left.rank);

  return ranked[0]?.candidate;
}

function windowsCommandRank(candidate: string): number {
  const extension = path.extname(candidate).toLowerCase();
  switch (extension) {
    case ".exe":
      return 4;
    case ".cmd":
      return 3;
    case ".bat":
      return 2;
    default:
      return 1;
  }
}
