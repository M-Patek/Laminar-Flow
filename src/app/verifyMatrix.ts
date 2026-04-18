import { runVerificationMatrix, writeVerificationReport } from "./verification.ts";

const includeDefault = process.env.DUPLEX_VERIFY_INCLUDE_DEFAULT === "1";
const summary = await runVerificationMatrix({
  includeDefault
});
const reportPath = await writeVerificationReport(process.cwd(), "verify-matrix", summary);
process.stdout.write(`${JSON.stringify({ ...summary, reportPath }, null, 2)}\n`);
