#!/usr/bin/env node

import { runDuplex } from "./run-duplex.js";

await runDuplex(["--left-backend", "claude", "--right-backend", "codex"]);
