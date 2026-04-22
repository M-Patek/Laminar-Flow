import { parseInteractiveBackendId } from "../backends/interactiveCliBackend.ts";

export function resolveLaunchBackendArgs(invokedCommand: string): string[] {
  const match = invokedCommand.match(/^duplex-(codex|gemini|claude)-(codex|gemini|claude)$/);
  if (!match) {
    return [];
  }

  const left = parseInteractiveBackendId(match[1]);
  const right = parseInteractiveBackendId(match[2]);
  if (!left || !right) {
    return [];
  }

  return ["--left-backend", left, "--right-backend", right];
}
