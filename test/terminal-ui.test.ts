import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSnapshot } from "../src/config/defaults.ts";
import { TerminalUi } from "../src/ui/TerminalUi.ts";
import type { AppSnapshot } from "../src/types/app.ts";
import { SplitCodexUi } from "../src/ui/SplitCodexUi.ts";

function createSnapshot(): AppSnapshot {
  const snapshot = createDefaultSnapshot();
  snapshot.recentEvents.push(
    { id: "evt-1", at: new Date().toISOString(), scope: "system", message: "booted" },
    { id: "evt-2", at: new Date().toISOString(), scope: "coordinator", message: "handoff left -> right" },
    { id: "evt-3", at: new Date().toISOString(), scope: "agent", message: "left completed round 1" }
  );
  snapshot.recentMessages.push(
    {
      id: "msg-1",
      kind: "handoff",
      from: "left",
      to: "right",
      body: "Context: one\nResult: one\nAsk: review",
      summary: "one",
      round: 1,
      createdAt: new Date().toISOString(),
      requiresHuman: false
    },
    {
      id: "msg-2",
      kind: "handoff",
      from: "right",
      to: "left",
      body: "Context: two\nResult: two\nAsk: implement",
      summary: "two",
      round: 2,
      createdAt: new Date().toISOString(),
      requiresHuman: false
    }
  );

  return snapshot;
}

function createUi(submit?: (input: string, focusedPane: "left" | "right") => Promise<{ message: string; shouldExit: boolean; uiEffects?: never[] }>) {
  const snapshot = createSnapshot();
  const store = {
    getSnapshot() {
      return snapshot;
    },
    subscribe() {
      return () => {};
    }
  };

  return new TerminalUi(store as never, {
    onSubmit: submit ?? (async () => ({ message: "ok", shouldExit: false })),
    onExit: async () => {}
  });
}

async function withMutedStdout<T>(run: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("TerminalUi shortcuts browse event and handoff inspection state", async () => {
  const ui = createUi();

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "f3" });
    await ui["handleKeypress"]("", { name: "f5" });
    await ui["handleKeypress"]("", { name: "escape" });
    await ui["handleKeypress"]("", { name: "f4" });
    await ui["handleKeypress"]("", { name: "f5" });
    await ui["handleKeypress"]("", { name: "f6" });
  });

  const state = ui["uiState"];
  assert.equal(state.selectedEvent, undefined);
  assert.equal(state.showHandoffDetails, true);
  assert.equal(state.selectedHandoff?.rank, 1);
});

test("TerminalUi command mode rejects plain text and preserves the buffer", async () => {
  let submitCalls = 0;
  const ui = createUi(async () => {
    submitCalls += 1;
    return { message: "submitted", shouldExit: false };
  });

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "f2" });
    await ui["handleKeypress"]("h", { name: "h", sequence: "h" });
    await ui["handleKeypress"]("i", { name: "i", sequence: "i" });
    await ui["handleKeypress"]("", { name: "return" });
  });

  assert.equal(ui["uiState"].inputMode, "command");
  assert.equal(ui["commandBuffer"], "hi");
  assert.equal(ui["notice"], "Command mode expects /commands. Use /input-mode direct to send plain text.");
  assert.equal(submitCalls, 0);
});

test("TerminalUi direct mode keeps per-pane drafts across focus changes", async () => {
  const ui = createUi();

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("a", { name: "a", sequence: "a" });
    await ui["handleKeypress"]("", { name: "tab" });
    await ui["handleKeypress"]("b", { name: "b", sequence: "b" });
    await ui["handleKeypress"]("", { name: "tab" });
  });

  assert.equal(ui["uiState"].focusedPane, "left");
  assert.equal(ui["drafts"].left, "a");
  assert.equal(ui["drafts"].right, "b");
});

test("TerminalUi report inspection can open and browse loaded verification reports", async () => {
  const ui = createUi();
  ui["uiState"].reports = [
    {
      id: "report-1",
      path: "C:\\temp\\verify-matrix.json",
      name: "verify-matrix.json",
      kind: "matrix",
      generatedAt: new Date().toISOString(),
      summary: "4 scenarios | halted 4 | active 0",
      raw: "{\"generatedAt\":\"now\"}"
    },
    {
      id: "report-2",
      path: "C:\\temp\\verify-long.json",
      name: "verify-long.json",
      kind: "long",
      generatedAt: new Date().toISOString(),
      summary: "default | mock | halted | no_progress",
      raw: "{\"scenario\":\"default\"}"
    }
  ];

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "f7" });
    await ui["handleKeypress"]("", { name: "f5" });
    await ui["handleKeypress"]("", { name: "f6" });
  });

  assert.equal(ui["uiState"].selectedReport?.rank, 1);
  assert.equal(ui["notice"], "Inspecting report #1.");
});

test("SplitCodexUi narrow status line still includes turn progress without throwing", () => {
  const ui = new SplitCodexUi({ workspaceDir: process.cwd(), maxTurns: 4 });
  ui["deliveredTurns"] = 2;
  ui["brokerHint"] = "broker:Lidle/Ridle qL0 qR0 next:no_pending";
  ui["mailboxCache"] = { at: Date.now(), leftUnread: 0, rightUnread: 0 };
  const line = ui["buildStatusLine"]();
  assert.match(line, /turns:2\/4/);
  assert.match(line, /Click:focus/);
  assert.match(line, /Tab:select/);
  assert.match(line, /F1:control/);
});

test("SplitCodexUi uses F1 to enter and leave the control line", async () => {
  const ui = new SplitCodexUi({ workspaceDir: process.cwd() });

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "f1" });
  });

  assert.equal(ui["focus"], "control");
  assert.match(ui["notice"], /Control focus/);

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "f1" });
  });

  assert.equal(ui["focus"], "left");
  assert.match(ui["notice"], /Returned to left/);
});

test("SplitCodexUi uses Tab to toggle selection mode", async () => {
  const ui = new SplitCodexUi({ workspaceDir: process.cwd() });

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "tab" });
  });

  assert.equal(ui["mouseMode"], "select");
  assert.match(ui["notice"], /Selection mode enabled/);

  await withMutedStdout(async () => {
    await ui["handleKeypress"]("", { name: "tab" });
  });

  assert.equal(ui["mouseMode"], "ui");
  assert.match(ui["notice"], /UI mouse mode enabled/);
});

test("SplitCodexUi mouse clicks switch focus between panes only", async () => {
  const ui = new SplitCodexUi({ workspaceDir: process.cwd() });

  await withMutedStdout(async () => {
    ui["handleRawInput"]("\u001B[<0;90;1M");
  });
  assert.equal(ui["focus"], "right");

  await withMutedStdout(async () => {
    ui["handleRawInput"]("\u001B[<0;5;1M");
  });
  assert.equal(ui["focus"], "left");

  await withMutedStdout(async () => {
    ui["handleRawInput"]("\u001B[<0;5;999M");
  });
  assert.equal(ui["focus"], "left");
});
