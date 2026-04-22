import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseInteractiveBackendId, type InteractiveBackendId } from "../backends/interactiveCliBackend.ts";
import { DUPLEX_COMBO_LAUNCHERS } from "./launchNames.ts";
import { runLongRunVerification, runVerificationMatrix, writeVerificationReport } from "./verification.ts";

export type CliAction = "start" | "verify:long" | "verify:matrix" | "help" | "version";

export interface StartCliOptions {
  workspaceDir?: string;
  maxTurns?: number;
  newSession?: boolean;
  interactiveBackend?: InteractiveBackendId;
  leftInteractiveBackend?: InteractiveBackendId;
  rightInteractiveBackend?: InteractiveBackendId;
}

export function resolveCliAction(argv: string[]): CliAction {
  const [command] = argv;
  if (!command || command === "start") {
    return "start";
  }

  if (command === "verify:long") {
    return "verify:long";
  }

  if (command === "verify:matrix") {
    return "verify:matrix";
  }

  if (command === "help" || command === "--help" || command === "-h") {
    return "help";
  }

  if (command === "version" || command === "--version" || command === "-v") {
    return "version";
  }

  if (command.startsWith("--")) {
    return "start";
  }

  throw new Error(`Unknown command: ${command}`);
}

export async function runCli(argv: string[]): Promise<number> {
  const action = resolveCliAction(argv);

  switch (action) {
    case "start":
      await (await import("./runtime.ts")).startRuntime(parseStartCliOptions(argv));
      return 0;
    case "verify:long": {
      const summary = await runLongRunVerification();
      const reportPath = await writeVerificationReport(process.cwd(), "verify-long", summary);
      process.stdout.write(`${JSON.stringify({ ...summary, reportPath }, null, 2)}\n`);
      return 0;
    }
    case "verify:matrix": {
      const includeDefault = process.env.DUPLEX_VERIFY_INCLUDE_DEFAULT === "1";
      const summary = await runVerificationMatrix({ includeDefault });
      const reportPath = await writeVerificationReport(process.cwd(), "verify-matrix", summary);
      process.stdout.write(`${JSON.stringify({ ...summary, reportPath }, null, 2)}\n`);
      return 0;
    }
    case "help":
      process.stdout.write(`${buildHelpText()}\n`);
      return 0;
    case "version":
      process.stdout.write(`${await readPackageVersion()}\n`);
      return 0;
  }
}

export function buildHelpText(): string {
  return [
    "duplex-codex",
    "",
    "Usage:",
    "  duplex-codex",
    "  duplex-codex start",
    "  duplex-codex --workspace C:\\path\\to\\repo --max-turns 6",
    "  duplex-codex --workspace C:\\path\\to\\repo --new",
    "  duplex-codex --backend gemini",
    "  duplex-codex --left-backend codex --right-backend claude",
    `  ${DUPLEX_COMBO_LAUNCHERS[2]}`,
    "  duplex-codex verify:long",
    "  duplex-codex verify:matrix",
    "  duplex-msg send --from left --to right --summary \"review parser\"",
    "  duplex-codex help",
    "  duplex-codex version",
    "",
    "Env:",
    "  DUPLEX_BROKER_TRANSPORT=local|daemon",
    "  DUPLEX_INTERACTIVE_BACKEND=codex|gemini|claude",
    "  DUPLEX_PROVIDER=mock|codex|gemini|claude|flaky",
    "  DUPLEX_VERIFY_SCENARIO=default|no-progress|handoff-limit|human-confirmation|provider-recovery",
    "  DUPLEX_VERIFY_INCLUDE_DEFAULT=1"
  ].join("\n");
}

export function parseStartCliOptions(argv: string[], cwd = process.cwd()): StartCliOptions {
  const args = argv[0] === "start" ? argv.slice(1) : argv.slice();
  const options: StartCliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--workspace") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --workspace");
      }
      options.workspaceDir = path.resolve(cwd, value);
      index += 1;
      continue;
    }

    if (token === "--max-turns") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --max-turns");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--max-turns requires a non-negative integer");
      }
      options.maxTurns = parsed;
      index += 1;
      continue;
    }

    if (token === "--new") {
      options.newSession = true;
      continue;
    }

    if (token === "--backend") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --backend");
      }
      const parsed = parseInteractiveBackendId(value.trim().toLowerCase());
      if (!parsed) {
        throw new Error("--backend must be one of codex, gemini, or claude");
      }
      options.interactiveBackend = parsed;
      index += 1;
      continue;
    }

    if (token === "--left-backend" || token === "--right-backend") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${token}`);
      }
      const parsed = parseInteractiveBackendId(value.trim().toLowerCase());
      if (!parsed) {
        throw new Error(`${token} must be one of codex, gemini, or claude`);
      }
      if (token === "--left-backend") {
        options.leftInteractiveBackend = parsed;
      } else {
        options.rightInteractiveBackend = parsed;
      }
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
  }

  return options;
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = path.resolve(currentDirname(), "../../package.json");
  const content = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(content) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function currentDirname(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).toString() : "";

if (import.meta.url === invokedUrl) {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
}

