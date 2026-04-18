import { runLongRunVerification, writeVerificationReport } from "./verification.ts";

const summary = await runLongRunVerification();
const reportPath = await writeVerificationReport(process.cwd(), "verify-long", summary);
process.stdout.write(`${JSON.stringify({ ...summary, reportPath }, null, 2)}\n`);
