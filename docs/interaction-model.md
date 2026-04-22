# Interaction Model

The current interactive UI has three user-facing regions:

- left pane
- right pane
- bottom status and control area

This is a terminal wrapper around two real interactive CLI sessions.
It is not the old coordinator-driven `TerminalUi` model.

## Focus model

Focus can be on:

- `left`
- `right`
- `control`

The focused pane receives keyboard input unless focus is on the control line.

## Mouse modes

There are two mouse modes:

- `ui`
- `select`

### `ui` mode

In `ui` mode:

- click changes pane focus
- wheel scroll changes pane viewport
- right click pastes clipboard into the focused pane

### `select` mode

In `select` mode:

- terminal mouse reporting is disabled
- the host terminal can drag-select text normally
- pane scrolling stays available through the keyboard

This is still a host-terminal compromise, not a full pane-local selection engine.

## Keyboard controls

- `F1`: enter or leave the control line
- `Tab`: toggle `ui` and `select` mouse mode
- `Shift+Tab`: pass through to the focused pane
- `PgUp` / `PgDn`: scroll the focused pane
- `Home` / `End`: jump to oldest/latest visible buffered content
- `Ctrl+V`: paste clipboard into the current focus
- `Ctrl+C`: quit the whole wrapper

## Control commands

Enter the control line with `F1`, then use:

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

Behavior notes:

- `/resume` resumes automatic broker delivery
- `/pause` stops automatic broker delivery
- `/clear-mail` clears the local broker state for this workspace and pauses delivery
- `/max-turns 0` disables the turn cap
- when the cap is reached, delivery halts but the panes stay alive

## Delivery model

The wrapper is manual-first.

- panes are always real interactive sessions
- the user can type directly into either pane
- cross-pane broker delivery is optional
- restored workspaces start with delivery paused

The control area is there to manage delivery, not to replace direct pane use.

## Status area

The status area shows:

- current pane focus
- pane status: `starting`, `running`, `exited`
- current turn count and limit
- unread broker counts
- delivery state: `paused` or `live`
- backend selection for left and right panes
- compact broker diagnostics

Important distinction:

- unread mail counts are not the same thing as pending deliverable messages

## Session behavior

Interactive session state is workspace-local.

- `codex` can auto-resume its interactive session on workspace reopen
- `gemini` and `claude` start fresh in the wrapper
- if you want an older Gemini or Claude conversation, resume it inside that native CLI yourself

The wrapper stores pane session metadata, but it does not force all interactive backends into the same resume UX.

## Local messaging

Cross-pane messages are created through `duplex-msg`.

Typical flow:

1. one side sends a broker message
2. the message lands in local broker storage
3. automatic delivery is injected into the opposite pane only when delivery is live and timing rules allow it

This means message passing is local, workspace-bound, and best-effort.

## Headless verification

Headless verification uses a different interaction model.
That path belongs to `Coordinator + AgentSession + Provider` and is documented separately in the verification and architecture docs.
