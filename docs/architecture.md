# Architecture

`duplex-codex` is split into four layers:

- `src/ui`: terminal rendering and input capture
- `src/core`: agent sessions, coordination rules, and persisted state
- `src/providers`: provider adapters such as `mock` and `codex`
- `src/commands`: command parsing and execution

## Runtime flow

1. `bootstrap.ts` starts the runtime.
2. `runtime.ts` restores `.duplex/session.json` if present.
3. `StateStore` becomes the single writable state boundary.
4. `TerminalUi` subscribes to `StateStore` and redraws on change.
5. Commands are parsed into typed actions.
6. `Coordinator` routes actions to `AgentSession` instances.
7. `AgentSession` calls the selected provider and returns structured output.
8. State changes and events are persisted under `.duplex/`.

## Provider behavior

`MockProvider`

- deterministic local responses
- useful for UI and coordinator development

`CodexCliProvider`

- starts a fresh session with `codex exec`
- resumes an existing per-agent session with `codex exec resume`
- stores session references in `.duplex/provider/codex-sessions.json`
- retries with a fresh session if a saved session id stops working

## MVP choices

- Two fixed agents: `left`, `right`
- Default roles: `builder`, `reviewer`
- Default provider: `mock`
- Optional provider: `codex`
- Coordinator modes: `manual`, `step`, `auto`
- Auto mode is guarded by a hard handoff cap and repetition detection
