import { mkdir } from "node:fs/promises";
import type { AgentProvider, ProviderInput, ProviderResult, ProviderSessionInfo } from "./Provider.ts";
import { CliSessionStateStore, type CliSessionState } from "./CliSessionState.ts";

export abstract class CliBackedProvider implements AgentProvider {
  readonly name: string;
  protected readonly workspaceDir: string;
  protected readonly runtimeDir: string;
  protected readonly supportsSessionResume: boolean;
  protected readonly sessionStateStore: CliSessionStateStore;
  private sessionStatePromise: Promise<CliSessionState> | null = null;

  constructor(options: {
    name: string;
    workspaceDir: string;
    runtimeDir: string;
    supportsSessionResume: boolean;
    sessionStoreFileName: string;
  }) {
    this.name = options.name;
    this.workspaceDir = options.workspaceDir;
    this.runtimeDir = options.runtimeDir;
    this.supportsSessionResume = options.supportsSessionResume;
    this.sessionStateStore = new CliSessionStateStore(options.runtimeDir, options.sessionStoreFileName);
  }

  async send(input: ProviderInput): Promise<ProviderResult> {
    await mkdir(this.runtimeDir, { recursive: true });
    const sessionState = await this.loadSessionState();
    const sessionId = this.supportsSessionResume ? sessionState.agents[input.agentId]?.sessionId : undefined;
    const result = await this.execute(input, sessionId);

    if (this.supportsSessionResume && result.exitCode !== 0 && sessionId) {
      delete sessionState.agents[input.agentId];
      await this.sessionStateStore.save(sessionState);
      const retried = await this.execute(input, undefined);
      await this.persistSessionRef(input.agentId, sessionState, retried.sessionId);
      return retried;
    }

    if (this.supportsSessionResume) {
      await this.persistSessionRef(input.agentId, sessionState, result.sessionId);
    }
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

  protected abstract execute(input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult>;

  private async loadSessionState(): Promise<CliSessionState> {
    if (!this.sessionStatePromise) {
      this.sessionStatePromise = this.sessionStateStore.load();
    }

    return this.sessionStatePromise;
  }

  private async persistSessionRef(
    agentId: ProviderInput["agentId"],
    sessionState: CliSessionState,
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
