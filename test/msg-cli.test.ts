import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  buildMsgHelpText,
  createMessage,
  listMessages,
  resolveMsgAction,
  runMsgCli
} from "../src/app/msgCli.ts";

test("resolveMsgAction accepts mailbox subcommands", () => {
  assert.equal(resolveMsgAction(["send"]), "send");
  assert.equal(resolveMsgAction(["inbox"]), "inbox");
  assert.equal(resolveMsgAction(["read"]), "read");
  assert.equal(resolveMsgAction(["done"]), "done");
  assert.equal(resolveMsgAction(["--help"]), "help");
});

test("buildMsgHelpText documents the local mailbox tool", () => {
  const help = buildMsgHelpText();
  assert.match(help, /duplex-msg send/);
  assert.match(help, /Messages are brokered locally/);
});

test("createMessage and listMessages store selective local handoffs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "duplex-msg-"));

  const created = await createMessage(workspace, {
    from: "left",
    to: "right",
    kind: "handoff",
    summary: "review parser",
    ask: "check empty input edge case",
    refs: ["src/parser.ts"]
  });

  assert.equal(created.status, "unread");
  assert.equal(created.ask, "check empty input edge case");
  const inbox = await listMessages(workspace, { to: "right", status: "unread" });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.summary, "review parser");
});

test("runMsgCli marks messages read and done", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "duplex-msg-"));
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await runMsgCli(
      ["send", "--from", "left", "--to", "right", "--summary", "need review", "--ask", "inspect parser", "--kind", "question"],
      workspace
    );
    assert.match(writes.join(""), /sent msg_/);
    assert.match(writes.join(""), /ask:inspect parser/);
    const saved = JSON.parse(await readFile(path.join(workspace, ".duplex", "broker", "state.json"), "utf8")) as {
      messages: Array<{ id: string; ask: string }>;
    };
    const id = saved.messages[0]!.id;
    assert.equal(saved.messages[0]!.ask, "inspect parser");

    writes.length = 0;
    await runMsgCli(["inbox", "--to", "right", "--status", "unread"], workspace);
    const inboxOutput = writes.join("");
    assert.match(inboxOutput, /1\. msg_/);
    assert.match(inboxOutput, /\[unread\] left->right \[question\] need review \| ask:inspect parser/);

    writes.length = 0;
    await runMsgCli(["read", id], workspace);
    const readOutput = writes.join("");
    assert.match(readOutput, /\[read\] left->right \[question\]/);
    assert.match(readOutput, /summary: need review/);
    assert.match(readOutput, /ask: inspect parser/);

    writes.length = 0;
    await runMsgCli(["done", id], workspace);
    const doneOutput = writes.join("");
    assert.match(doneOutput, /done msg_/);
  } finally {
    process.stdout.write = originalWrite;
  }
});
