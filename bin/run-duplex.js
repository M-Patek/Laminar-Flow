import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runDuplex(extraArgs = []) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.resolve(here, "../src/app/cli.ts");
  const argv = process.argv.slice(2);

  const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...argv, ...extraArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
    windowsHide: true
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  process.exit(exitCode);
}
