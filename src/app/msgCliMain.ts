import { runMsgCli } from "./msgCli.ts";

try {
  const exitCode = await runMsgCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
