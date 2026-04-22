import path from "node:path";
import { getBackendDescriptor, resolveBackendCommand } from "../backends/backendDescriptors.ts";
import { CliBackedProvider } from "./CliBackedProvider.ts";
import { runCliProcess } from "./cliProcess.ts";
import type { ProviderInput, ProviderResult } from "./Provider.ts";

export class CodexCliProvider extends CliBackedProvider {
  constructor(workspaceDir: string, runtimeDir: string) {
    const descriptor = getBackendDescriptor("codex");
    super({
      name: descriptor.id,
      workspaceDir,
      runtimeDir,
      supportsSessionResume: descriptor.supportsSessionResume,
      sessionStoreFileName: descriptor.providerSessionStoreFileName
    });
  }

  protected execute(input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> {
    return this.runCodex(input, sessionId);
  }

  protected async runCodex(input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> {
    const resolved = resolveBackendCommand("codex");
    const outputFile = path.join(this.runtimeDir, `${input.agentId}-last.txt`);
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

    const result = await runCliProcess({
      workspaceDir: this.workspaceDir,
      command: resolved.command,
      args,
      outputFile
    });
    const parsedSessionId = parseSessionId(`${result.stdout}\n${result.stderr}`) ?? sessionId;

    return {
      output: result.output,
      exitCode: result.exitCode,
      sessionId: parsedSessionId,
      rawStdout: result.stdout,
      rawStderr: result.stderr
    };
  }
}

function parseSessionId(stdout: string): string | undefined {
  const match = stdout.match(/session id:\s*([0-9a-f-]{36})/i);
  return match?.[1];
}
