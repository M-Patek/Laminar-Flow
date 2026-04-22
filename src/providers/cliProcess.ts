import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface CliProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

export async function runCliProcess(options: {
  workspaceDir: string;
  command: string;
  args: string[];
  outputFile?: string;
}): Promise<CliProcessResult> {
  if (options.outputFile) {
    await rm(options.outputFile, { force: true }).catch(() => undefined);
  }

  const child = spawnCommand(options.command, options.args, options.workspaceDir);

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
  if (options.outputFile) {
    try {
      output = (await readFile(options.outputFile, "utf8")).trim();
    } catch {
      output = stdout.trim();
    }
  } else {
    output = stdout.trim();
  }

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    output
  };
}

function spawnCommand(command: string, args: string[], workspaceDir: string) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd: workspaceDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  return spawn(command, args, {
    cwd: workspaceDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
