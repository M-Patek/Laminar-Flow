import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  getBackendDescriptor,
  parseBackendId,
  resolveBackendCommand,
  type BackendId
} from "./backendDescriptors.ts";

export type InteractiveBackendId = BackendId;

export interface InteractiveCliBackend {
  id: InteractiveBackendId;
  displayName: string;
  command: string;
  extraPath?: string;
  autoResumeOnWorkspaceRestore: boolean;
  supportsSyntheticCursorOverlay: boolean;
  anchorsCursorToVisibleTextEnd: boolean;
  syntheticCursorOverlayDelayMs: number;
  supportsSessionResume: boolean;
  supportsAssignedSessionId: boolean;
  buildInteractiveArgs(options: { sessionId?: string; resume: boolean }): string[];
  extractSessionIdFromOutput?(output: string): string | undefined;
  createAssignedSessionId?(): string;
  discoverSessionId?(workspaceDir: string, knownSessionIds: string[]): string | undefined;
}

interface InteractiveBackendBehavior {
  autoResumeOnWorkspaceRestore: boolean;
  supportsSyntheticCursorOverlay: boolean;
  anchorsCursorToVisibleTextEnd: boolean;
  syntheticCursorOverlayDelayMs: number;
  buildInteractiveArgs(options: { sessionId?: string; resume: boolean }): string[];
  extractSessionIdFromOutput?(output: string): string | undefined;
  createAssignedSessionId?(): string;
  discoverSessionId?(workspaceDir: string, command: string, knownSessionIds: string[]): string | undefined;
}

const DEFAULT_INTERACTIVE_BACKEND: InteractiveBackendId = "codex";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const DESCRIPTORS: Record<InteractiveBackendId, InteractiveBackendBehavior> = {
  codex: {
    autoResumeOnWorkspaceRestore: true,
    supportsSyntheticCursorOverlay: true,
    anchorsCursorToVisibleTextEnd: false,
    syntheticCursorOverlayDelayMs: 0,
    buildInteractiveArgs: ({ sessionId, resume }) =>
      resume && sessionId ? ["resume", "--no-alt-screen", sessionId] : ["--no-alt-screen"],
    extractSessionIdFromOutput: (output) => output.match(/session id:\s*([0-9a-f-]{36})/i)?.[1]
  },
  gemini: {
    autoResumeOnWorkspaceRestore: false,
    supportsSyntheticCursorOverlay: true,
    anchorsCursorToVisibleTextEnd: true,
    syntheticCursorOverlayDelayMs: 0,
    buildInteractiveArgs: ({ sessionId, resume }) => {
      const args: string[] = [];
      if (resume) {
        args.push("--resume");
        if (sessionId) {
          args.push(sessionId);
        }
      }
      return args;
    },
    discoverSessionId: (workspaceDir, command, knownSessionIds) => {
      const output = runCommandForOutput(command, ["--list-sessions"], workspaceDir);
      const ids = [...output.matchAll(UUID_PATTERN)].map((match) => match[0]);
      return ids.find((id) => !knownSessionIds.includes(id));
    }
  },
  claude: {
    autoResumeOnWorkspaceRestore: false,
    supportsSyntheticCursorOverlay: true,
    anchorsCursorToVisibleTextEnd: true,
    syntheticCursorOverlayDelayMs: 0,
    buildInteractiveArgs: ({ sessionId, resume }) => {
      const args: string[] = [];
      if (resume) {
        args.push("--resume");
        if (sessionId) {
          args.push(sessionId);
        }
      } else if (sessionId) {
        args.push("--session-id", sessionId);
      }
      return args;
    },
    createAssignedSessionId: () => crypto.randomUUID()
  }
};

export function parseInteractiveBackendId(value: string | undefined): InteractiveBackendId | undefined {
  return parseBackendId(value);
}

export function resolveInteractiveBackendId(
  explicitValue: string | undefined,
  env = process.env
): InteractiveBackendId {
  const candidate = explicitValue?.trim().toLowerCase() || env.DUPLEX_INTERACTIVE_BACKEND?.trim().toLowerCase();
  const parsed = parseBackendId(candidate);
  if (parsed) {
    return parsed;
  }

  if (candidate) {
    throw new Error(`Unsupported interactive backend: ${candidate}`);
  }

  return DEFAULT_INTERACTIVE_BACKEND;
}

export function createInteractiveBackend(
  explicitValue: string | undefined,
  env = process.env
): InteractiveCliBackend {
  const id = resolveInteractiveBackendId(explicitValue, env);
  const descriptor = getBackendDescriptor(id);
  const behavior = DESCRIPTORS[id];
  const resolved = resolveBackendCommand(id);

  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    command: resolved.command,
    extraPath: resolved.extraPath,
    autoResumeOnWorkspaceRestore: behavior.autoResumeOnWorkspaceRestore,
    supportsSyntheticCursorOverlay: behavior.supportsSyntheticCursorOverlay,
    anchorsCursorToVisibleTextEnd: behavior.anchorsCursorToVisibleTextEnd,
    syntheticCursorOverlayDelayMs: behavior.syntheticCursorOverlayDelayMs,
    supportsSessionResume: descriptor.supportsSessionResume,
    supportsAssignedSessionId: descriptor.supportsAssignedSessionId,
    buildInteractiveArgs: (options) => behavior.buildInteractiveArgs(options),
    extractSessionIdFromOutput: behavior.extractSessionIdFromOutput,
    createAssignedSessionId: behavior.createAssignedSessionId,
    discoverSessionId: behavior.discoverSessionId
      ? (workspaceDir, knownSessionIds) => behavior.discoverSessionId!(workspaceDir, resolved.command, knownSessionIds)
      : undefined
  };
}

function runCommandForOutput(command: string, args: string[], workspaceDir: string): string {
  const result =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
          cwd: workspaceDir,
          encoding: "utf8",
          windowsHide: true
        })
      : spawnSync(command, args, {
          cwd: workspaceDir,
          encoding: "utf8",
          windowsHide: true
        });

  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}
