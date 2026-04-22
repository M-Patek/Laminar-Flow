import test from "node:test";
import assert from "node:assert/strict";
import { getBackendDescriptor } from "../src/backends/backendDescriptors.ts";
import { resolveLaunchBackendArgs } from "../src/app/launchCombos.ts";
import { createInteractiveBackend } from "../src/backends/interactiveCliBackend.ts";
import { buildHelpText, parseStartCliOptions, resolveCliAction } from "../src/app/cli.ts";

test("resolveCliAction defaults to start with no arguments", () => {
  assert.equal(resolveCliAction([]), "start");
  assert.equal(resolveCliAction(["--workspace", "C:\\repo"]), "start");
});

test("resolveCliAction accepts verify subcommands and help/version aliases", () => {
  assert.equal(resolveCliAction(["verify:long"]), "verify:long");
  assert.equal(resolveCliAction(["verify:matrix"]), "verify:matrix");
  assert.equal(resolveCliAction(["--help"]), "help");
  assert.equal(resolveCliAction(["-v"]), "version");
});

test("resolveCliAction rejects unknown commands", () => {
  assert.throws(() => resolveCliAction(["weird"]), /Unknown command: weird/);
});

test("buildHelpText lists the packaged command usage", () => {
  const help = buildHelpText();

  assert.match(help, /duplex-codex verify:long/);
  assert.match(help, /duplex-codex verify:matrix/);
  assert.match(help, /--backend gemini/);
  assert.match(help, /duplex-codex-claude/);
  assert.match(help, /--workspace/);
  assert.match(help, /DUPLEX_INTERACTIVE_BACKEND=codex\|gemini\|claude/);
  assert.match(help, /DUPLEX_PROVIDER=mock\|codex\|gemini\|claude\|flaky/);
});

test("parseStartCliOptions resolves workspace and interactive backends", () => {
  const cwd = "C:\\repo";
  const options = parseStartCliOptions(
    [
      "start",
      "--workspace",
      ".\\demo",
      "--max-turns",
      "6",
      "--backend",
      "gemini",
      "--right-backend",
      "claude"
    ],
    cwd
  );

  assert.equal(options.workspaceDir, "C:\\repo\\demo");
  assert.equal(options.maxTurns, 6);
  assert.equal(options.interactiveBackend, "gemini");
  assert.equal(options.rightInteractiveBackend, "claude");
});

test("parseStartCliOptions rejects bad max-turns", () => {
  assert.throws(() => parseStartCliOptions(["--max-turns", "-1"]), /non-negative integer/);
});

test("parseStartCliOptions rejects unsupported interactive backend", () => {
  assert.throws(() => parseStartCliOptions(["--backend", "weird"]), /must be one of codex, gemini, or claude/);
  assert.throws(() => parseStartCliOptions(["--left-backend", "weird"]), /must be one of codex, gemini, or claude/);
});

test("createInteractiveBackend defaults to codex and honors env override", () => {
  assert.equal(createInteractiveBackend(undefined, {}).id, "codex");
  assert.equal(createInteractiveBackend(undefined, { DUPLEX_INTERACTIVE_BACKEND: "claude" }).id, "claude");
});

test("backend descriptors expose shared provider and interactive metadata", () => {
  const codex = getBackendDescriptor("codex");
  const gemini = getBackendDescriptor("gemini");
  const claude = getBackendDescriptor("claude");

  assert.equal(codex.providerSessionStoreFileName, "codex-sessions.json");
  assert.equal(gemini.providerSessionStoreFileName, "gemini-sessions.json");
  assert.equal(claude.providerSessionStoreFileName, "claude-sessions.json");
  assert.equal(codex.supportsAssignedSessionId, false);
  assert.equal(claude.supportsAssignedSessionId, true);
});

test("Gemini and Claude interactive backends start fresh by default on workspace reopen", () => {
  const gemini = createInteractiveBackend("gemini");
  const claude = createInteractiveBackend("claude");

  assert.equal(gemini.autoResumeOnWorkspaceRestore, false);
  assert.equal(gemini.anchorsCursorToVisibleTextEnd, true);
  assert.deepEqual(gemini.buildInteractiveArgs({ resume: true }), ["--resume"]);

  assert.equal(claude.autoResumeOnWorkspaceRestore, false);
  assert.deepEqual(claude.buildInteractiveArgs({ resume: true }), ["--resume"]);
});

test("resolveLaunchBackendArgs maps combo launchers to per-pane backend flags", () => {
  assert.deepEqual(resolveLaunchBackendArgs("duplex-codex-claude"), [
    "--left-backend",
    "codex",
    "--right-backend",
    "claude"
  ]);
  assert.deepEqual(resolveLaunchBackendArgs("duplex-gemini-gemini"), [
    "--left-backend",
    "gemini",
    "--right-backend",
    "gemini"
  ]);
  assert.deepEqual(resolveLaunchBackendArgs("duplex-codex"), []);
});
