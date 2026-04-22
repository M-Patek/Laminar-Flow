import { SplitCodexUi } from "../ui/SplitCodexUi.ts";
import type { StartCliOptions } from "./cli.ts";

export async function startRuntime(options: StartCliOptions = {}): Promise<void> {
  const workspaceDir = options.workspaceDir ?? process.cwd();

  const ui = new SplitCodexUi({
    workspaceDir,
    maxTurns: options.maxTurns,
    newSession: options.newSession,
    interactiveBackend: options.interactiveBackend,
    leftInteractiveBackend: options.leftInteractiveBackend,
    rightInteractiveBackend: options.rightInteractiveBackend
  });

  await ui.start();
  await ui.waitUntilClosed();
}
