import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentProvider, ProviderInput, ProviderResult, ProviderSessionInfo } from "./Provider.ts";
import { CodexSessionStateStore, type CodexSessionState } from "./CodexSessionState.ts";

export class CodexCliProvider implements AgentProvider {
  readonly name = "codex";
  private readonly workspaceDir: string;
  private readonly runtimeDir: string;
  private readonly sessionStateStore: CodexSessionStateStore;
  private sessionStatePromise: Promise<CodexSessionState> | null = null;

  constructor(workspaceDir: string, runtimeDir: string) {
    this.workspaceDir = workspaceDir;
    this.runtimeDir = runtimeDir;
    this.sessionStateStore = new CodexSessionStateStore(runtimeDir);
  }

  async send(input: ProviderInput): Promise<ProviderResult> {
    await mkdir(this.runtimeDir, { recursive: true });
    const sessionState = await this.loadSessionState();
    const result = await this.runCodex(input, sessionState.agents[input.agentId]?.sessionId);

    if (result.exitCode !== 0 && sessionState.agents[input.agentId]) {
      delete sessionState.agents[input.agentId];
      await this.sessionStateStore.save(sessionState);
      const retried = await this.runCodex(input, undefined);
      await this.persistSessionRef(input.agentId, sessionState, retried.sessionId);
      return retried;
    }

    await this.persistSessionRef(input.agentId, sessionState, result.sessionId);
    return result;
  }

  async getSessionInfo(agentId: ProviderInput["agentId"]): Promise<ProviderSessionInfo | null> {
    const sessionState = await this.loadSessionState();
    const session = sessionState.agents[agentId];
    if (!session) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      updatedAt: session.updatedAt
    };
  }

  async resetSession(agentId: ProviderInput["agentId"]): Promise<void> {
    const sessionState = await this.loadSessionState();
    if (!sessionState.agents[agentId]) {
      return;
    }

    delete sessionState.agents[agentId];
    await this.sessionStateStore.save(sessionState);
  }

  private async runCodex(input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> {
    const outputFile = path.join(this.runtimeDir, `${input.agentId}-last.txt`);
    await rm(outputFile, { force: true }).catch(() => undefined);
    const args = sessionId
      ? [
          "exec",
          "resume",
          "--skip-git-repo-check",
          "--output-last-message",
          outputFile,
          sessionId,
          input.prompt
        ]
      : [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--color",
          "never",
          "--output-last-message",
          outputFile,
          input.prompt
        ];

    const child =
      process.platform === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "codex.cmd", ...args], {
            cwd: this.workspaceDir,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
          })
        : spawn("codex", args, {
            cwd: this.workspaceDir,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
          });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    let output = "";
    try {
      output = (await readFile(outputFile, "utf8")).trim();
    } catch {
      output = stdout.trim();
    }

    const parsedSessionId = parseSessionId(`${stdout}\n${stderr}`) ?? sessionId;

    return {
      output,
      exitCode,
      sessionId: parsedSessionId,
      rawStdout: stdout.trim(),
      rawStderr: stderr.trim()
    };
  }

  private async loadSessionState(): Promise<CodexSessionState> {
    if (!this.sessionStatePromise) {
      this.sessionStatePromise = this.sessionStateStore.load();
    }

    return this.sessionStatePromise;
  }

  private async persistSessionRef(
    agentId: ProviderInput["agentId"],
    sessionState: CodexSessionState,
    sessionId: string | undefined
  ): Promise<void> {
    if (!sessionId) {
      return;
    }

    sessionState.agents[agentId] = {
      sessionId,
      updatedAt: new Date().toISOString()
    };
    await this.sessionStateStore.save(sessionState);
  }
}

function parseSessionId(stdout: string): string | undefined {
  const match = stdout.match(/session id:\s*([0-9a-f-]{36})/i);
  return match?.[1];
}
