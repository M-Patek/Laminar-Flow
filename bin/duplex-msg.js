#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(scriptDir, "../src/app/msgCliMain.ts");

await import(pathToFileURL(entryPath).toString());
