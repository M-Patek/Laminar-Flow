import { readFile } from "node:fs/promises";
import { SplitCodexUi } from "../ui/SplitCodexUi.ts";
import type { StartCliOptions } from "./cli.ts";

export async function startRuntime(options: StartCliOptions = {}): Promise<void> {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const [leftPrompt, rightPrompt] = await Promise.all([
    readOptionalText(options.leftPromptPath),
    readOptionalText(options.rightPromptPath)
  ]);

  const ui = new SplitCodexUi({
    workspaceDir,
    maxTurns: options.maxTurns,
    leftPrompt,
    rightPrompt
  });

  await ui.start();
  await ui.waitUntilClosed();
}

async function readOptionalText(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
