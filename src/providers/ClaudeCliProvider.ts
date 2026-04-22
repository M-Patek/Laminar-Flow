import { getBackendDescriptor, resolveBackendCommand } from "../backends/backendDescriptors.ts";
import { CliBackedProvider } from "./CliBackedProvider.ts";
import { runCliProcess } from "./cliProcess.ts";
import type { ProviderInput, ProviderResult } from "./Provider.ts";

export class ClaudeCliProvider extends CliBackedProvider {
  constructor(workspaceDir: string, runtimeDir: string) {
    const descriptor = getBackendDescriptor("claude");
    super({
      name: descriptor.id,
      workspaceDir,
      runtimeDir,
      supportsSessionResume: descriptor.supportsSessionResume,
      sessionStoreFileName: descriptor.providerSessionStoreFileName
    });
  }

  protected async execute(input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> {
    const resolved = resolveBackendCommand("claude");
    const args = ["--print", "--output-format", "json"];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push(input.prompt);
    const result = await runCliProcess({
      workspaceDir: this.workspaceDir,
      command: resolved.command,
      args
    });
    const parsed = parseClaudeJson(result.output);

    return {
      output: parsed?.result ?? result.output,
      exitCode: result.exitCode,
      sessionId: parsed?.session_id ?? sessionId,
      rawStdout: result.stdout,
      rawStderr: result.stderr
    };
  }
}

function parseClaudeJson(raw: string): { session_id?: string; result?: string } | null {
  try {
    return JSON.parse(raw) as { session_id?: string; result?: string };
  } catch {
    return null;
  }
}
