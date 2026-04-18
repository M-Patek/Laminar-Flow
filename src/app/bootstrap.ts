import { startRuntime } from "./runtime.ts";

try {
  await startRuntime();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
