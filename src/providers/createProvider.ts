import path from "node:path";
import { DUPLEX_DIR } from "../config/defaults.ts";
import type { AgentProvider } from "./Provider.ts";
import { CodexCliProvider } from "./CodexCliProvider.ts";
import { FlakyProvider } from "./FlakyProvider.ts";
import { MockProvider } from "./MockProvider.ts";

export function createProvider(
  workspaceDir: string,
  options?: {
    runtimeDir?: string;
  }
): AgentProvider {
  const providerName = (process.env.DUPLEX_PROVIDER ?? "mock").toLowerCase();
  if (providerName === "codex") {
    return new CodexCliProvider(
      workspaceDir,
      options?.runtimeDir ?? path.join(workspaceDir, DUPLEX_DIR, "provider")
    );
  }

  if (providerName === "flaky") {
    return new FlakyProvider();
  }

  return new MockProvider();
}
