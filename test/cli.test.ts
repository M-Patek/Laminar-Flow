import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
  assert.match(help, /--workspace/);
  assert.match(help, /DUPLEX_PROVIDER=mock\|codex\|flaky/);
});

test("parseStartCliOptions resolves workspace and prompt paths", () => {
  const cwd = "C:\\repo";
  const options = parseStartCliOptions(
    ["start", "--workspace", ".\\demo", "--max-turns", "6", "--left-prompt", "left.md", "--right-prompt", "right.md"],
    cwd
  );

  assert.equal(options.workspaceDir, path.resolve(cwd, ".\\demo"));
  assert.equal(options.maxTurns, 6);
  assert.equal(options.leftPromptPath, path.resolve(cwd, "left.md"));
  assert.equal(options.rightPromptPath, path.resolve(cwd, "right.md"));
});

test("parseStartCliOptions rejects bad max-turns", () => {
  assert.throws(() => parseStartCliOptions(["--max-turns", "-1"]), /non-negative integer/);
});
