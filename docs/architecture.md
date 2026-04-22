# Architecture

`duplex-codex` currently has two distinct execution paths:

- interactive dual-pane runtime
- headless verification runtime

They share some backend and session metadata, but they are not the same stack.

## Interactive runtime

The interactive product path is:

1. `src/app/cli.ts`
2. `src/app/runtime.ts`
3. `src/ui/SplitCodexUi.ts`
4. `src/runtime/DuplexRuntime.ts`
5. `src/ui/render/PaneRenderer.ts`

The responsibilities are split like this:

- `SplitCodexUi`
  - terminal screen layout
  - keyboard and mouse handling
  - focus, scroll offset, control line, status line
  - top-level startup and shutdown flow

- `DuplexRuntime`
  - pane lifecycle
  - PTY spawning via `node-pty`
  - interactive session restore and persistence
  - broker polling and delivery
  - peer busy/idle bookkeeping

- `PaneRenderer`
  - headless xterm buffer to visible pane lines
  - synthetic cursor overlay
  - Gemini-specific render cleanup and cursor re-anchoring

## Interactive backends

Interactive backends are defined in:

- `src/backends/backendDescriptors.ts`
- `src/backends/interactiveCliBackend.ts`

Current supported backends:

- `codex`
- `gemini`
- `claude`

Shared backend metadata lives in `backendDescriptors.ts`:

- default command
- Windows lookup/fallback paths
- session resume capability
- assigned-session capability
- provider session store filename

Interactive-specific behavior lives in `interactiveCliBackend.ts`:

- startup args
- synthetic cursor behavior
- cursor anchoring behavior
- optional interactive session id discovery

## Interactive persistence

Workspace-local interactive state is stored under `.duplex/`.

Current key files:

- `.duplex/broker/state.json`
- `.duplex/interactive-sessions.json`

The session persistence layer is:

- `src/state/SessionStateStore.ts`
- `src/backends/InteractiveSessionState.ts`

`SessionStateStore` is the shared low-level schema and compatibility layer.
It reads the current `scope + entries` shape and also accepts older legacy shapes.

## Broker model

Cross-pane delivery is local and workspace-bound.

The broker-facing pieces are:

- `src/app/broker.ts`
- `src/app/brokerClient.ts`
- `src/runtime/DuplexRuntime.ts`
- `src/app/msg-cli.ts`

Important constraints:

- delivery is local only
- delivery is best-effort, not exactly-once
- restored sessions start with delivery paused
- the user resumes automatic delivery with `/resume`

## Headless verification

The verification path is separate from the interactive pane runtime.

Entry points:

- `src/app/verification.ts`
- `src/providers/createProvider.ts`

Core verification model:

- `src/core/coordination/Coordinator.ts`
- `src/core/agents/AgentSession.ts`
- `src/core/state/StateStore.ts`

Provider adapters:

- `mock`
- `codex`
- `gemini`
- `claude`
- `flaky`

This path is used for deterministic drills and regression checks.
It is not the same thing as the interactive pane runtime.

## Current boundaries

What is intentionally fixed:

- exactly two panes
- one shared terminal
- local workspace-bound persistence
- local brokered message passing
- manual-first runtime with optional automatic delivery

What is intentionally not modeled as a general platform:

- arbitrary pane counts
- a general agent orchestration framework
- perfect terminal style fidelity across all CLIs
- strong distributed message guarantees

## Important current behavior

- `codex` can auto-resume its interactive session on workspace reopen
- `gemini` and `claude` currently start fresh in the interactive runtime; users resume inside the native CLI if they want an old conversation
- interactive launchers such as `duplex-codex-claude` are just thin wrappers for left/right backend selection
- headless provider behavior and interactive pane behavior are related, but intentionally separate
