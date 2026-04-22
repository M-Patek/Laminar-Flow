import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackendId } from "../backends/backendDescriptors.ts";

export type SessionStateScope = "interactive-pane" | "provider-agent";

export interface StoredSessionEntry {
  ownerId: string;
  sessionId?: string;
  updatedAt: string;
  backend?: BackendId;
}

export interface SessionStateDocument {
  scope: SessionStateScope;
  entries: Record<string, StoredSessionEntry>;
}

export class SessionStateStore {
  private readonly filePath: string;
  private readonly scope: SessionStateScope;

  constructor(filePath: string, scope: SessionStateScope) {
    this.filePath = filePath;
    this.scope = scope;
  }

  async load(): Promise<SessionStateDocument> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return normalizeSessionStateDocument(JSON.parse(content), this.scope);
    } catch {
      return {
        scope: this.scope,
        entries: {}
      };
    }
  }

  async save(state: SessionStateDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify(
        {
          scope: state.scope,
          entries: state.entries
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function normalizeSessionStateDocument(raw: unknown, scope: SessionStateScope): SessionStateDocument {
  if (isSessionStateDocument(raw)) {
    return {
      scope,
      entries: raw.entries
    };
  }

  if (scope === "interactive-pane" && isLegacyInteractiveState(raw)) {
    const entries = Object.fromEntries(
      Object.entries(raw.panes)
        .filter(([, value]) => Boolean(value))
        .map(([ownerId, value]) => [
          ownerId,
          {
            ownerId,
            sessionId: value?.sessionId,
            updatedAt: value?.updatedAt ?? new Date(0).toISOString(),
            backend: value?.backend
          } satisfies StoredSessionEntry
        ])
    );
    return { scope, entries };
  }

  if (scope === "provider-agent" && isLegacyProviderState(raw)) {
    const entries = Object.fromEntries(
      Object.entries(raw.agents)
        .filter(([, value]) => Boolean(value))
        .map(([ownerId, value]) => [
          ownerId,
          {
            ownerId,
            sessionId: value?.sessionId,
            updatedAt: value?.updatedAt ?? new Date(0).toISOString()
          } satisfies StoredSessionEntry
        ])
    );
    return { scope, entries };
  }

  return {
    scope,
    entries: {}
  };
}

function isSessionStateDocument(value: unknown): value is SessionStateDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SessionStateDocument>;
  return typeof candidate.scope === "string" && Boolean(candidate.entries) && typeof candidate.entries === "object";
}

function isLegacyInteractiveState(value: unknown): value is {
  panes: Record<string, { backend?: BackendId; sessionId?: string; updatedAt?: string } | undefined>;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "panes" in value && typeof (value as { panes?: unknown }).panes === "object";
}

function isLegacyProviderState(value: unknown): value is {
  agents: Record<string, { sessionId?: string; updatedAt?: string } | undefined>;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "agents" in value && typeof (value as { agents?: unknown }).agents === "object";
}
