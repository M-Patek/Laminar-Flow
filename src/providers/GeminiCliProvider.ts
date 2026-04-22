import { getBackendDescriptor, resolveBackendCommand } from "../backends/backendDescriptors.ts";
import { CliBackedProvider } from "./CliBackedProvider.ts";
import { runCliProcess } from "./cliProcess.ts";
import type { ProviderInput, ProviderResult } from "./Provider.ts";

export class GeminiCliProvider extends CliBackedProvider {
  constructor(workspaceDir: string, runtimeDir: string) {
    const descriptor = getBackendDescriptor("gemini");
    super({
      name: descriptor.id,
      workspaceDir,
      runtimeDir,
      supportsSessionResume: descriptor.supportsSessionResume,
      sessionStoreFileName: descriptor.providerSessionStoreFileName
    });
  }

  protected async execute(input: ProviderInput, sessionId: string | undefined): Promise<ProviderResult> {
    const resolved = resolveBackendCommand("gemini");
    const args = sessionId
      ? ["--resume", sessionId, "--prompt", input.prompt, "--output-format", "json"]
      : ["--prompt", input.prompt, "--output-format", "json"];
    const result = await runCliProcess({
      workspaceDir: this.workspaceDir,
      command: resolved.command,
      args
    });
    const parsed = parseGeminiJson(result.output);

    return {
      output: parsed?.response ?? result.output,
      exitCode: result.exitCode,
      sessionId: parsed?.session_id ?? sessionId,
      rawStdout: result.stdout,
      rawStderr: result.stderr
    };
  }
}

function parseGeminiJson(raw: string): { session_id?: string; response?: string } | null {
  try {
    return JSON.parse(raw) as { session_id?: string; response?: string };
  } catch {
    return null;
  }
}
