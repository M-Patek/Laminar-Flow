import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "../types/agent.ts";

export interface CodexAgentSessionRef {
  sessionId: string;
  updatedAt: string;
}

export interface CodexSessionState {
  agents: Partial<Record<AgentId, CodexAgentSessionRef>>;
}

export class CodexSessionStateStore {
  private readonly filePath: string;

  constructor(runtimeDir: string) {
    this.filePath = path.join(runtimeDir, "codex-sessions.json");
  }

  async load(): Promise<CodexSessionState> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return JSON.parse(content) as CodexSessionState;
    } catch {
      return { agents: {} };
    }
  }

  async save(state: CodexSessionState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
