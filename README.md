# duplex-codex

`duplex-codex` is a terminal-native dual-Codex wrapper. It runs two real interactive Codex sessions side by side inside one terminal, with a minimal control line at the bottom.

The default collaboration model is asymmetric:

- left pane = `lead`
- right pane = `support`

## Interactive UI

- Left pane: native interactive Codex session
- Right pane: native interactive Codex session
- Left is the default lead role; right is the default support role
- mouse click: switch focus between left and right panes
- `Tab`: toggle between UI mouse mode and native text selection mode
- right click in `ui` mode: paste clipboard into the current focus
- right click in `select` mode: leave it to the host terminal
- `F1`: move focus to the bottom control line
- `Tab` from control mode: return to the last pane
- `Ctrl+C`: quit the interactive UI

Control mode currently supports:

- `/help`
- `/focus left|right`
- `/restart left|right|both`
- `/max-turns <n>`
- `/turns`
- `/status`
- `/quit`

Mouse wheel events are intercepted by the outer split UI, so they should scroll panes instead of leaking raw escape fragments into the control line. Press `Tab` while a pane is focused to temporarily disable mouse reporting and let the host terminal handle normal drag-to-select text. Press `Tab` again to restore click focus and wheel scroll. The bottom status/control lines also use light color coding for focus, commands, warnings, and errors. Focus colors are now pane-specific: left is red, right is green, and control is yellow. The status line also shows unread mailbox counts as `mail:Lx|Ry`.

The broker hint in the bottom status line is a compact runtime view:

- `Lbusy/Ridle`: current peer states known to the broker
- `qL1 qR0`: queued undelivered messages per target pane
- `next:left`, `next:right`, or `next:left+merge`: the broker's current delivery decision
- `next:cooldown:742ms`, `next:left_busy:615ms`, `next:right_busy:615ms`, or `next:no_pending`: why nothing is being injected right now, including the remaining delay window when available

`/status` prints a richer one-line runtime snapshot with:

- current focus
- pane roles and local pane status
- broker peer states
- unread counts
- broker blocked reason
- wait time until the next delivery window, when blocked
- next delivery target plus the candidate message direction and kind

The bottom status line also shows delivery progress as `turns:x/y`. This is the number of broker-delivered cross-pane injections so far versus the current turn limit. `/max-turns 0` disables the limit.

## Run

```powershell
npm run start
```

Or from the repo root on Windows:

```powershell
.\duplex-codex.cmd
```

You can also start directly into a target workspace and preload the role prompts:

```powershell
.\duplex-codex.cmd --workspace C:\path\to\repo --max-turns 6 --left-prompt C:\Users\asus\Desktop\gpt-test\ROLEPROMPT-LEFT-LEAD.md --right-prompt C:\Users\asus\Desktop\gpt-test\ROLEPROMPT-RIGHT-SUPPORT.md
```

```powershell
npm test
```

```powershell
npm run verify:long
```

```powershell
npm run verify:matrix
```

## Local Command

This repo can now be exposed as a local CLI command:

```powershell
npm link
duplex-codex
```

The packaged command maps to the same entrypoints:

```powershell
duplex-codex
duplex-codex start
duplex-codex verify:long
duplex-codex verify:matrix
duplex-codex help
duplex-codex version
duplex-msg send --from left --to right --summary "review parser" --ask "review empty-input"
```

After `npm link`, both `duplex-codex` and `duplex-msg` are available globally, even if you move this repo later.

For a zero-install Windows wrapper from the repo root:

```powershell
.\duplex-codex.cmd
.\duplex-codex.cmd verify:long
.\duplex-codex.cmd verify:matrix
duplex-msg inbox --to right
```

## Local Mailbox

Use `duplex-msg` when one Codex pane needs to tell the other something without dumping the full transcript.

```powershell
duplex-msg send --from left --to right --kind handoff --summary "review parser" --ask "review empty-input and error path" --ref src\parser.ts
duplex-msg inbox --to right --status unread
duplex-msg read msg_xxx
duplex-msg done msg_xxx
```

The local broker stays under `.duplex/broker/state.json`. Keep messages short and selective:

- `handoff`
- `question`
- `decision`
- `blocker`
- `note`

`inbox` is intentionally compact: it prints one-line summaries by default. Use `read <id>` only when you actually need the full body.

Messages now use a fixed lightweight structure:

- `summary`
- `ask`
- `refs`

When the split UI is running, new unread mailbox messages are also directly injected into the target Codex pane in this short structured form. The mailbox still keeps the local record. When both sides have pending messages at the same time, delivery now prefers the left lead pane and merges support input into that lead-facing update instead of trying to advance two equal main threads.

To try the Codex CLI provider:

```powershell
$env:DUPLEX_PROVIDER="codex"
npm run start
```

To run the headless long-run verification against a specific provider:

```powershell
$env:DUPLEX_PROVIDER="codex"
npm run verify:long
```

For a local recovery drill with injected provider failures:

```powershell
$env:DUPLEX_PROVIDER="flaky"
npm run verify:long
```

To run a built-in verification scenario:

```powershell
$env:DUPLEX_VERIFY_SCENARIO="handoff-limit"
npm run verify:long
```

To run the full deterministic verification matrix, and optionally include the current provider as `default`:

```powershell
npm run verify:matrix
$env:DUPLEX_VERIFY_INCLUDE_DEFAULT="1"
npm run verify:matrix
```

When `DUPLEX_PROVIDER=codex`, the app persists per-agent Codex session ids in `.duplex/provider/codex-sessions.json` and reuses them across rounds.

## Notes

- `mock` is the default provider and is safe for local iteration.
- `codex` needs the CLI to be authenticated and able to write its own session files under `~/.codex/sessions`.
- `flaky` is a local-only provider that fails the first round per agent so recovery paths can be exercised on demand.
- In `auto` mode, repeated handoffs and long ping-pong loops are halted by guardrails instead of running forever.

## Commands

- `/left <text>`
- `/right <text>`
- `/both <text>`
- `/focus [left|right|next]`
- `/input-mode direct|command`
- `/step left`
- `/step right`
- `/takeover left|right`
- `/release left|right`
- `/retry [left|right]`
- `/continue`
- `/reset left|right`
- `/handoff left`
- `/handoff right`
- `/mode manual`
- `/mode step`
- `/mode auto`
- `/event-filter [all|system|agent|coordinator|message]`
- `/event-open <n>`
- `/event-close`
- `/event-next`
- `/event-prev`
- `/handoff-details [show|hide]`
- `/handoff-open [n]`
- `/handoff-close`
- `/reports`
- `/report-open [n]`
- `/report-close`
- `/max-turns <n>`
- `/turns`
- `/pause`
- `/resume`
- `/resume left|right`
- `/events`
- `/clear-events`
- `/status`
- `/help`
- `/quit`

Plain text without a leading slash is sent to the currently focused pane. Use mouse clicks or `/focus` to switch focus.

The UI now keeps one direct-input draft per pane plus a separate command buffer:

- `direct` mode edits the focused pane draft and sends it on `Enter`
- `command` mode edits the shared command buffer and expects `/commands`
- `/takeover left|right` automatically focuses that pane and returns to `direct` mode

Useful keyboard shortcuts:

- mouse click: switch pane focus
- `Tab`: toggle between UI mouse mode and native selection mode
- `F1`: open or close the control line
- `F2`: toggle `direct` / `command` input mode
- `F3`: open or close the newest event detail in the current filter
- `F4`: open or close the newest handoff detail
- `F5` / `F6`: move to older or newer items inside the open inspection panel
- `F7`: open or close the newest loaded verification report
- `PgUp` / `PgDn`: move through event feed pages
- `Esc`: clear the active buffer, then close inspection panels if the buffer is already empty

`/max-turns 0` disables the limit. By default the coordinator starts with a max-turn cap of `8`.

The bottom control region supports:

- event feed filtering by scope
- numbered event inspection with `/event-open <n>`
- paging backward and forward through recent events
- expanding the latest or selected handoff payload
- loading recent verification reports with `/reports`
- opening report details with `/report-open [n]`

The event feed is numbered newest-first within the current filter. `/event-open 1` selects the newest visible matching event, and `/handoff-open 1` selects the newest recorded handoff.

Verification reports are also ranked newest-first after `/reports` refreshes the local index. `/report-open 1` selects the newest report currently found under `.duplex/verification/reports`.

Handoffs are now packed as structured envelopes with `Context`, `Result`, `Risk`, and `Ask` sections. The coordinator summary also surfaces the latest handoff risk directly, so you can see the key review concern without expanding the full body.

Both agents and the coordinator now expose structured failure labels:

- `issueKind` on agents distinguishes provider failures, interrupted runs, no-progress loops, and human-confirmation stops
- `haltKind` on the coordinator distinguishes turn caps, auto-turn caps, repeated handoffs, human confirmation, and no-progress stops

`npm run verify:long` also supports built-in deterministic scenarios via `DUPLEX_VERIFY_SCENARIO`:

- `default`: use the currently selected provider as-is
- `no-progress`: force a repeat-output halt
- `handoff-limit`: drive the system until the auto-handoff cap stops it
- `human-confirmation`: stop on a review output that requests human input
- `provider-recovery`: inject provider failures and verify retry behavior

Both `npm run verify:long` and `npm run verify:matrix` write JSON reports under `.duplex/verification/reports` and print a `reportPath` in their terminal output. Verification summaries also include each scenario's `artifactDir`, so you can inspect the corresponding snapshot and event log afterward.

