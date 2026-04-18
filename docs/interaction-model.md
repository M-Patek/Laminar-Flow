# Interaction Model

The terminal has three conceptual regions:

- left pane
- right pane
- bottom command bar
- shared event feed between the panes and the command bar

Every user action maps to one of three primitives:

- `send`
- `advance`
- `handoff`

## Commands

- `/left <text>`: queue work for the left agent and immediately advance it if possible
- `/right <text>`: queue work for the right agent and immediately advance it if possible
- `/both <text>`: queue the same message for both agents
- `/focus [left|right|next]`: move the local input focus between panes
- `/input-mode direct|command`: switch between pane draft entry and the shared command buffer
- `/step left|right`: advance exactly one agent round
- `/takeover left|right`: mark one agent pane as manually controlled and stop auto-driving it
- `/release left|right`: remove manual takeover from one agent pane
- `/retry [left|right]`: retry a blocked or queued agent, or pick the most likely target automatically
- `/continue`: alias for `/retry`
- `/reset left|right`: clear one agent's local queue and provider session
- `/handoff left|right`: create a structured handoff to the opposite agent
- `/mode manual|step|auto`: switch coordinator mode
- `/event-filter [all|system|agent|coordinator|message]`: change the bottom event feed scope
- `/event-open <n>`: inspect the `n`th newest event in the current filter
- `/event-close`: close the selected event detail panel
- `/event-next`: move the bottom event feed to an older page
- `/event-prev`: move the bottom event feed to a newer page
- `/handoff-details [show|hide]`: expand or collapse the latest handoff detail block
- `/handoff-open [n]`: inspect the `n`th newest handoff; defaults to `1`
- `/handoff-close`: close the handoff detail panel
- `/reports`: refresh the local verification report index and print the newest report files
- `/report-open [n]`: inspect the `n`th newest verification report; defaults to `1`
- `/report-close`: close the report detail panel
- `/max-turns <n>`: set the global turn ceiling for the current workspace; `0` means unlimited
- `/turns`: show the current turn count and configured ceiling
- `/pause`: stop automatic advancement
- `/resume`: resume the coordinator
- `/resume left|right`: move one agent out of `error` or `needs_human`
- `/events`: print the latest event feed lines into the notice area
- `/clear-events`: clear the persisted event feed
- `/status`: print a compact state summary
- `/help`: print supported commands
- `/quit`: persist state and exit

When you type plain text without a command prefix in `direct` mode, it is sent to the currently focused pane. Press `Tab` to move focus between `left` and `right`.

The input model now has two local buffers:

- one draft buffer for each pane in `direct` mode
- one shared command buffer in `command` mode

Switching focus preserves the left and right drafts. Switching input mode preserves whichever buffer is not active.

Useful keyboard shortcuts:

- `Tab`: switch focus between `left` and `right`
- `F2`: toggle `direct` and `command` input modes
- `F3`: open or close the newest event detail in the current filter
- `F4`: open or close the newest handoff detail
- `F5` / `F6`: move to older or newer items inside the open event, handoff, or report inspection panel
- `F7`: open or close the newest loaded verification report
- `PgUp` / `PgDn`: move to older or newer event-feed pages
- `Esc`: clear the active input buffer, or close the open inspection panel when the buffer is already empty

## Failure labels

The scheduler now keeps structured failure labels in addition to the human-readable reason text:

- agent `issueKind`: `provider_failure`, `interrupted_run`, `no_progress`, or `human_confirmation`
- coordinator `haltKind`: `turn_limit`, `auto_turn_limit`, `handoff_limit`, `repeated_handoff`, `human_confirmation`, or `no_progress`

These labels appear in status output and the terminal summary so recovery flows can distinguish transport failures from deliberate stop conditions.

## Auto mode guardrails

Auto mode can stop itself and enter `halted` when:

- the handoff count exceeds the configured cap
- the latest handoff summary is effectively the same as the previous one
- a handoff draft asks for human confirmation

When halted, new user messages are queued but not auto-advanced until `/resume`.

## Manual takeover

When an agent is under manual takeover:

- user messages still queue for that agent
- auto mode does not advance that agent
- auto mode does not continue through a handoff into that agent
- the user can still use `/step`, `/handoff`, `/resume`, or `/reset` on that side

## UI surfaces

The terminal now shows:

- left and right agent panes
- a coordinator summary block with the latest decision and last handoff
- a shared event feed with filter, paging, and newest-first numbering
- an optional selected event detail block
- an optional expanded handoff detail block for the latest or selected handoff
- an optional verification report detail block for the latest or selected report
- the bottom input bar, which can operate in `direct` or `command` mode

The focused pane is marked directly in the pane header and mirrored in the bottom status line. The active direct-input pane also shows its current draft inside the pane body.

## Handoff shape

Every handoff is packed into a small structured envelope:

- `Context`: what side is handing off to whom
- `Result`: the compressed outcome of the latest round
- `Risk`: the main issue to watch for next
- `Ask`: the concrete next action expected from the receiving side

The coordinator summary mirrors the latest `Risk` and `Ask` so the user can inspect the handoff at a glance before opening the full detail panel.

## Headless verification

`npm run verify:long` runs a non-interactive builder-reviewer drill, writes a JSON report under `.duplex/verification/reports`, and prints a JSON summary of:

- verification scenario
- provider name
- scenario artifact directory
- final coordinator status, `haltKind`, and halt reason
- per-agent status, rounds, and `issueKind`
- recovery actions that were attempted automatically

Verification scenarios are selected with `DUPLEX_VERIFY_SCENARIO`:

- `default`: use the currently selected provider
- `no-progress`: force a repeat-output halt
- `handoff-limit`: drive the loop until the auto-handoff cap is hit
- `human-confirmation`: stop when review output requests a human checkpoint
- `provider-recovery`: inject provider failures and verify retries

`npm run verify:matrix` runs the deterministic verification scenarios in one pass, aggregates halt-kind counts, writes a report to `.duplex/verification/reports`, and prints the generated `reportPath`.

Use `/reports` inside the terminal UI to refresh the local report index after a headless verification run. Once loaded, `/report-open 1` or `F7` opens the newest report detail directly in the bottom inspection area.

Set `DUPLEX_PROVIDER=codex` with `DUPLEX_VERIFY_SCENARIO=default` to exercise the real Codex CLI. Use `DUPLEX_PROVIDER=flaky` or `DUPLEX_VERIFY_SCENARIO=provider-recovery` for a local recovery drill.
