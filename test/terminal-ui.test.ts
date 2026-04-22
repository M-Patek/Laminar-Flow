import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInteractiveBackend } from "../src/backends/interactiveCliBackend.ts";
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

test("SplitCodexUi status lines still include turn progress without throwing", () => {
  const ui = new SplitCodexUi({ workspaceDir: process.cwd(), maxTurns: 4, interactiveBackend: "gemini" });
  ui["deliveredTurns"] = 2;
  ui["brokerHint"] = "broker:Lidle/Ridle qL0 qR0 next:no_pending";
  ui["mailboxCache"] = { at: Date.now(), leftUnread: 0, rightUnread: 0 };
  const lines = ui["buildStatusLines"]();
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /turns:2\/4/);
  assert.match(lines[0] ?? "", /backend:Lgemini\|Rgemini/);
  assert.match(lines[1] ?? "", /Click:focus/);
  assert.match(lines[1] ?? "", /Tab:select/);
  assert.match(lines[1] ?? "", /F1:control/);
});

test("SplitCodexUi renders the synthetic cursor for Claude panes without delay", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "claude"
  });
  const backend = createInteractiveBackend("claude");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 3,
        getLine: () => ({
          translateToString: () => "hello"
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });

  ui["recentPaneActivityAt"].left = Date.now();
  const lines = ui["getPaneLines"]("left", 20, 1);

  assert.equal(lines[0]?.cursorCol, 3);
});

test("SplitCodexUi only renders the synthetic cursor on the active cursor row", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "codex"
  });
  const backend = createInteractiveBackend("codex");
  const terminal = {
    buffer: {
      active: {
        length: 2,
        baseY: 0,
        cursorY: 1,
        cursorX: 2,
        getLine: (index: number) => ({
          translateToString: () => (index === 0 ? "first" : "second")
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 20, 2);

  assert.equal(lines[0]?.cursorCol, undefined);
  assert.equal(lines[1]?.cursorCol, 2);
});

test("SplitCodexUi clamps the synthetic cursor to visible text width for non-Claude panes", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "codex"
  });
  const backend = createInteractiveBackend("codex");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 5,
        getLine: () => ({
          translateToString: () => "你好"
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 20, 1);

  assert.equal(lines[0]?.cursorCol, 4);
});

test("SplitCodexUi anchors Gemini cursor to the cell after the last visible text at end of line", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 5,
        getLine: () => ({
          translateToString: () => "浣犲ソ"
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 20, 1);

  assert.equal(lines[0]?.cursorCol, 5);
});

test("SplitCodexUi reanchors Gemini cursor above a filtered decorative row", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const terminal = {
    buffer: {
      active: {
        length: 2,
        baseY: 0,
        cursorY: 1,
        cursorX: 0,
        getLine: (index: number) => ({
          translateToString: () => (index === 0 ? "Type your message" : "────────────")
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 20, 2);

  assert.equal(lines[0]?.cursorCol, "Type your message".length);
  assert.equal(lines[1]?.text, "");
  assert.equal(lines[1]?.cursorCol, undefined);
});

test("SplitCodexUi anchors Gemini cursor before the placeholder hint text", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 35,
        getLine: () => ({
          translateToString: () => "> Type your message or @path/to/file"
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 50, 1);

  assert.equal(lines[0]?.cursorCol, 1);
});

test("SplitCodexUi reanchors Gemini cursor to the placeholder row when the live cursor is below it", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const terminal = {
    buffer: {
      active: {
        length: 2,
        baseY: 0,
        cursorY: 1,
        cursorX: 0,
        getLine: (index: number) => ({
          translateToString: () => (index === 0 ? "> Type your message or @path/to/file" : "")
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 50, 2);

  assert.equal(lines[0]?.cursorCol, 1);
  assert.equal(lines[1]?.cursorCol, undefined);
});

test("SplitCodexUi anchors Claude cursor to the cell after the last visible text at end of line", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "claude"
  });
  const backend = createInteractiveBackend("claude");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 5,
        getLine: () => ({
          translateToString: () => "你好"
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 20, 1);

  assert.equal(lines[0]?.cursorCol, 4);
});

test("SplitCodexUi anchors Claude cursor to the cell after trimmed text during deletion", () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "claude"
  });
  const backend = createInteractiveBackend("claude");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 1,
        getLine: () => ({
          translateToString: () => "a "
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  const lines = ui["getPaneLines"]("left", 20, 1);

  assert.equal(lines[0]?.cursorCol, 1);
});

test("SplitCodexUi renders a background cursor cell when a non-Claude cursor is on whitespace", async () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "codex"
  });
  const backend = createInteractiveBackend("codex");
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 5,
        getLine: () => ({
          translateToString: () => "hello"
        })
      }
    }
  };

  ui["focus"] = "left";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: false,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });
  ui["recentPaneActivityAt"].left = Date.now() - 500;

  await withMutedStdout(async () => {
    ui["render"]();
  });
  const rendered = ui["lastFrame"];

  assert.match(rendered, /\u001B\[44m\u001B\[34m█\u001B\[0m/);
});

test("SplitCodexUi starts panes in parallel after the first frame is rendered", async () => {
  const ui = new SplitCodexUi({ workspaceDir: process.cwd() });
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStdoutOn = process.stdout.on.bind(process.stdout);
  const originalStdoutOff = process.stdout.off.bind(process.stdout);
  const originalStdinResume = process.stdin.resume.bind(process.stdin);
  const originalStdinPause = process.stdin.pause.bind(process.stdin);
  const originalStdinOn = process.stdin.on.bind(process.stdin);
  const originalStdinOff = process.stdin.off.bind(process.stdin);
  const originalSetRawMode =
    "setRawMode" in process.stdin && typeof process.stdin.setRawMode === "function"
      ? process.stdin.setRawMode.bind(process.stdin)
      : undefined;

  let renderCount = 0;
  const startEvents: string[] = [];
  let mailboxInstalled = false;

  ui["sessionStateStore"].load = async () => ({ panes: {} });
  ui["broker"].upsertPeerState = async () => undefined;
  ui["render"] = () => {
    renderCount += 1;
  };
  ui["startPane"] = async (id: "left" | "right") => {
    startEvents.push(`${id}:start:${renderCount}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    startEvents.push(`${id}:end:${renderCount}`);
  };

  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stdout.on = (((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "resize") {
      return process.stdout;
    }
    return originalStdoutOn(event as never, listener as never);
  }) as typeof process.stdout.on);
  process.stdout.off = (((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "resize") {
      return process.stdout;
    }
    return originalStdoutOff(event as never, listener as never);
  }) as typeof process.stdout.off);
  process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
  process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
  process.stdin.on = (((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "data" || event === "keypress") {
      return process.stdin;
    }
    return originalStdinOn(event as never, listener as never);
  }) as typeof process.stdin.on);
  process.stdin.off = (((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "data" || event === "keypress") {
      return process.stdin;
    }
    return originalStdinOff(event as never, listener as never);
  }) as typeof process.stdin.off);
  if (originalSetRawMode) {
    process.stdin.setRawMode = (() => undefined) as typeof process.stdin.setRawMode;
  }

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (((fn: (...args: unknown[]) => void, _ms?: number) => {
    mailboxInstalled = true;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setInterval);
  global.clearInterval = (((_timer: NodeJS.Timeout) => undefined) as typeof clearInterval);

  try {
    const startedAt = Date.now();
    await ui.start();
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 75, `expected parallel startup, got ${elapsed}ms`);
    assert.deepEqual(startEvents.slice(0, 2), ["left:start:1", "right:start:1"]);
    assert.equal(mailboxInstalled, true);
  } finally {
    if (ui["mailboxTimer"]) {
      clearInterval(ui["mailboxTimer"]);
      ui["mailboxTimer"] = undefined;
    }
    process.stdout.write = originalStdoutWrite;
    process.stdout.on = originalStdoutOn;
    process.stdout.off = originalStdoutOff;
    process.stdin.resume = originalStdinResume;
    process.stdin.pause = originalStdinPause;
    process.stdin.on = originalStdinOn;
    process.stdin.off = originalStdinOff;
    if (originalSetRawMode) {
      process.stdin.setRawMode = originalSetRawMode;
    }
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test("SplitCodexUi trims Gemini rich background styling after the last visible glyph", async () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const styledCell = {
    getWidth: () => 1,
    getChars: () => "A",
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => true,
    isFgDefault: () => true,
    isBgDefault: () => false,
    getFgColor: () => 0,
    getBgColor: () => 7
  };
  const paddedCell = {
    ...styledCell,
    getChars: () => " "
  };
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        getLine: () => ({
          translateToString: () => "A   ",
          getCell: (index: number) => {
            if (index === 0) {
              return styledCell;
            }
            if (index >= 1 && index <= 3) {
              return paddedCell;
            }
            return {
              ...paddedCell,
              isBgPalette: () => false,
              isBgDefault: () => true
            };
          }
        })
      }
    }
  };

  ui["focus"] = "control";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: true,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });

  await withMutedStdout(async () => {
    ui["render"]();
  });

  const rendered = ui["lastFrame"];
  assert.match(rendered, /A/);
  assert.doesNotMatch(rendered, /\u001B\[48;5;7m/);
});

test("SplitCodexUi resets Gemini whitespace cells inside styled regions", async () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const makeCell = (chars: string) => ({
    getWidth: () => 1,
    getChars: () => chars,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => true,
    isFgDefault: () => true,
    isBgDefault: () => false,
    getFgColor: () => 0,
    getBgColor: () => 7
  });
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        getLine: () => ({
          translateToString: () => "A B",
          getCell: (index: number) => {
            if (index === 0) {
              return makeCell("A");
            }
            if (index === 1) {
              return makeCell(" ");
            }
            if (index === 2) {
              return makeCell("B");
            }
            return undefined;
          }
        })
      }
    }
  };

  ui["focus"] = "control";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: true,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });

  await withMutedStdout(async () => {
    ui["render"]();
  });

  const rendered = ui["lastFrame"];
  assert.match(rendered, /A/);
  assert.match(rendered, /A B\u001B\[0m/);
  assert.doesNotMatch(rendered, /\u001B\[48;5;7m/);
});

test("SplitCodexUi strips Gemini decorative frame glyphs", async () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const makeCell = (chars: string) => ({
    getWidth: () => 1,
    getChars: () => chars,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isFgDefault: () => true,
    isBgDefault: () => true,
    getFgColor: () => 0,
    getBgColor: () => 0
  });
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        getLine: () => ({
          translateToString: () => "────",
          getCell: (index: number) => (index >= 0 && index <= 3 ? makeCell("─") : undefined)
        })
      }
    }
  };

  ui["focus"] = "control";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: true,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });

  await withMutedStdout(async () => {
    ui["render"]();
  });

  const rendered = ui["lastFrame"];
  assert.doesNotMatch(rendered, /─/u);
});

test("SplitCodexUi preserves Gemini logo block glyphs", async () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const makeCell = (chars: string) => ({
    getWidth: () => 1,
    getChars: () => chars,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isFgDefault: () => true,
    isBgDefault: () => true,
    getFgColor: () => 0,
    getBgColor: () => 0
  });
  const terminal = {
    buffer: {
      active: {
        length: 1,
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        getLine: () => ({
          translateToString: () => "\u259b\u259c",
          getCell: (index: number) => {
            if (index === 0) {
              return makeCell("\u259b");
            }
            if (index === 1) {
              return makeCell("\u259c");
            }
            return undefined;
          }
        })
      }
    }
  };

  ui["focus"] = "control";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: true,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });

  await withMutedStdout(async () => {
    ui["render"]();
  });

  const rendered = ui["lastFrame"];
  assert.match(rendered, /\u259b\u259c/u);
});

test("SplitCodexUi strips long Gemini decorative block runs but keeps short logo clusters", async () => {
  const ui = new SplitCodexUi({
    workspaceDir: process.cwd(),
    interactiveBackend: "gemini"
  });
  const backend = createInteractiveBackend("gemini");
  const makeCell = (chars: string) => ({
    getWidth: () => 1,
    getChars: () => chars,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isFgRGB: () => false,
    isBgRGB: () => false,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isFgDefault: () => true,
    isBgDefault: () => true,
    getFgColor: () => 0,
    getBgColor: () => 0
  });
  const terminal = {
    buffer: {
      active: {
        length: 2,
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        getLine: (index: number) => {
          if (index === 0) {
            return {
              translateToString: () => "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588",
              getCell: (cellIndex: number) => (cellIndex >= 0 && cellIndex <= 7 ? makeCell("\u2588") : undefined)
            };
          }

          return {
            translateToString: () => "\u259b\u259c",
            getCell: (cellIndex: number) => {
              if (cellIndex === 0) {
                return makeCell("\u259b");
              }
              if (cellIndex === 1) {
                return makeCell("\u259c");
              }
              return undefined;
            }
          };
        }
      }
    }
  };

  ui["focus"] = "control";
  ui["paneBackends"].set("left", backend);
  ui["panes"].set("left", {
    id: "left",
    role: "lead",
    terminal,
    pty: {} as never,
    status: "running",
    consumedInitialPromptInline: true,
    writeQueue: Promise.resolve(),
    pendingOutput: ""
  });

  const lines = ui["getPaneLines"]("left", 20, 2);
  assert.equal(lines[0]?.text, "");
  assert.equal(lines[1]?.text, "\u259b\u259c");
});

test("SplitCodexUi serializes session discovery so pane ids stay distinct", async (t) => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "duplex-codex-ui-test-"));
  t.after(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const ui = new SplitCodexUi({ workspaceDir });
  const seenKnown: string[][] = [];
  const backend = {
    id: "gemini",
    displayName: "Gemini CLI",
    command: "gemini",
    autoResumeOnWorkspaceRestore: true,
    supportsSyntheticCursorOverlay: true,
    syntheticCursorOverlayDelayMs: 0,
    supportsSessionResume: true,
    supportsAssignedSessionId: false,
    buildInteractiveArgs: () => [],
    discoverSessionId: (_workspaceDir: string, knownSessionIds: string[]) => {
      seenKnown.push([...knownSessionIds]);
      return ["session-left", "session-right"].find((id) => !knownSessionIds.includes(id));
    }
  };

  ui["paneBackends"].set("left", backend);
  ui["paneBackends"].set("right", backend);
  ui["panes"].set("left", { status: "running" } as never);
  ui["panes"].set("right", { status: "running" } as never);

  await Promise.all([
    ui["capturePaneSessionId"]("left", "ready"),
    ui["capturePaneSessionId"]("right", "ready")
  ]);

  assert.equal(ui["paneSessionIds"].left, "session-left");
  assert.equal(ui["paneSessionIds"].right, "session-right");
  assert.deepEqual(seenKnown, [[], ["session-left"]]);
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
