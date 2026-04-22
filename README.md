# duplex-codex

`duplex-codex` is a terminal-native dual-agent wrapper for one person. It runs two real interactive CLI agent sessions side by side inside one terminal, with a small control area at the bottom and a local broker for cross-pane messages.

This project is intentionally narrow:

- one terminal
- two real agent panes
- local workspace-bound session state
- lightweight message passing via `duplex-msg`
- manual-first usage, with optional automatic delivery

## Current Model

- Left pane and right pane are both real interactive CLI agent sessions.
- Interactive backends currently supported: `codex`, `gemini`, and `claude`.
- Session state is bound to the current workspace directory.
- Reopening the same workspace restores its local broker/session state.
- Restored sessions start with **delivery paused** by default.
- Use `/resume` when you want automatic cross-pane delivery to continue.
- Use `--new` to start a fresh session for the current workspace.

## Start

From any target repo:

```powershell
cd C:\path\to\your\repo
duplex-codex
```

Choose an interactive backend explicitly:

```powershell
duplex-codex --backend gemini
duplex-codex --backend claude
```

Choose separate backends for the left and right panes:

```powershell
duplex-codex --left-backend codex --right-backend claude
duplex-codex --left-backend gemini --right-backend gemini
```

After `npm link`, all 3x3 packaged launchers are also available:

```powershell
duplex-codex-claude
duplex-gemini-codex
duplex-claude-gemini
duplex-claude-claude
```

Each launcher name means `duplex-<left>-<right>`.

Start a fresh session in the current workspace:

```powershell
duplex-codex --new
```

Explicit workspace:

```powershell
duplex-codex --workspace C:\path\to\repo
```

Set an initial turn limit:

```powershell
duplex-codex --workspace C:\path\to\repo --max-turns 16
```

## Global Commands

After linking once from the project directory:

```powershell
npm link
```

these commands are available globally:

```powershell
duplex-codex
duplex-msg
duplex-codex-claude
duplex-gemini-gemini
duplex-claude-codex
```

## Interactive Controls

Pane / mouse controls:

- mouse click: focus left or right pane
- right click in `ui` mode: paste clipboard into the current focus
- `Tab`: toggle between `ui` mode and `select` mode
- `Shift+Tab`: pass through to the focused Codex pane
- `PgUp` / `PgDn`: scroll the focused pane
- `Home` / `End`: jump to oldest/latest content in the focused pane
- `F1`: enter or leave the control line
- `Ctrl+C`: quit the whole wrapper

### `ui` mode

In `ui` mode:

- mouse clicks change pane focus
- wheel scroll is handled by the wrapper
- right click pastes clipboard into the focused target

### `select` mode

In `select` mode:

- mouse reporting is disabled so the host terminal can do normal drag-to-select text
- use `PgUp` / `PgDn` / `Home` / `End` for pane scrolling
- selection behavior is still a host-terminal compromise, not a true pane-isolated terminal selection engine

Current practical limitation:

- selection is constrained by the host terminal, so pane-local text selection is not as strong as a real separate terminal window
- `select` mode is meant to make copying easier, not to perfectly emulate two native terminal windows inside one host terminal

## Control Commands

Enter control mode with `F1`, then use:

- `/help`
- `/resume`
- `/pause`
- `/clear-mail`
- `/restart left`
- `/restart right`
- `/restart both`
- `/max-turns <n>`
- `/turns`
- `/status`
- `/quit`

Notes:

- `/resume` enables automatic cross-pane delivery
- `/pause` stops automatic delivery; pane work stays manual
- `/clear-mail` clears the current workspace broker messages and unread counts, resets delivered turns, and pauses delivery
- `/max-turns 0` disables the limit
- when the turn limit is reached, automatic delivery stops, but the panes stay alive

## Status Line

The bottom status area shows the current runtime state, including:

- pane status (`starting`, `running`, `exited`)
- turn progress as `turns:x/y`
- unread counts as `mail:Lx|Ry`
- `delivery:paused|live`
- a compact broker hint

Important distinction:

- `mail:Lx|Ry` means **unread** messages
- it does **not** mean pending delivery count

## Local Messaging

Use `duplex-msg` when one pane needs to tell the other something.

```powershell
duplex-msg send --from left --to right --summary "review parser" --ask "check empty-input" --kind handoff --ref src\parser.ts
duplex-msg inbox --to right --status unread
duplex-msg read msg_xxx
duplex-msg done msg_xxx
```

Current `duplex-msg` behavior:

- messages are stored locally under `.duplex/broker/state.json`
- `send` creates a broker message
- `inbox` lists unread/read/done messages
- `read` marks a message as read and shows details
- `done` marks a message as done

The CLI is lightweight but currently still expects:

- `--from`
- `--to`
- `--summary`
- `--ask`

Optional:

- `--kind`
- `--ref`

## Collaboration Files

Shared workspace-level collaboration rules belong in:

- `AGENTS.md`

Role / identity prompts belong in separate files, for example:

- `Basile.md`
- `Morning.md`

Recommended split:

- `AGENTS.md`: shared tool/collaboration rules
- role prompt files: identity, relationship, and local task framing

## Current Design Boundaries

This tool is deliberately not a full agent framework.

It is:

- a dual-pane CLI agent wrapper
- a local brokered message bridge
- a manual-first personal workflow tool

It is not:

- a general multi-agent platform
- a full orchestrator with strong consistency guarantees
- a true embedded native terminal multiplexer with perfect pane-local selection and styling fidelity

## Verification

```powershell
npm test
npm run verify:long
npm run verify:matrix
```

## Notes

- Use `--backend codex|gemini|claude` or `DUPLEX_INTERACTIVE_BACKEND` to choose the interactive pane backend.
- Use `--left-backend` and `--right-backend`, or a packaged launcher such as `duplex-codex-claude`, when the two panes should use different CLIs.
- `DUPLEX_PROVIDER` still controls the headless verification provider path, not the interactive panes.
- Headless verification providers currently supported: `mock`, `codex`, `gemini`, `claude`, and `flaky`.
- `mock` is the default verification provider for local iteration.
- `codex` in verification mode requires the Codex CLI to be available and authenticated.
- Interactive pane session ids are stored in `.duplex/interactive-sessions.json`.
- In the interactive runtime, `codex` can auto-resume from that file when reopening the same workspace.
- In the interactive runtime, `gemini` and `claude` currently start fresh; resume older conversations inside those native CLIs if you want them.
- restored sessions are paused by default so you can manually inspect the state before resuming delivery.
