# AGENTS.md

## Navigation and checks

- This fork has no GitNexus index and no `.claude/skills/gitnexus`: locate flows and blast radius with the `ripwire` tool (repo root `C:/projetos/pi-acp-agents`) and TypeScript symbols with `lsp`.
- Before a commit: `npm run typecheck` and `npm test` (vitest). One file: `npx vitest run test/<file>`. CI runs on push, PR and `workflow_dispatch`; Actions may not start for billing, so run these locally.
- Hooks and timeouts must stay portable to Windows: the suite runs on Windows here (27 failures fixed in #1).

## Agent profiles vs servers

`agent_servers.<key>` is an **agent profile**: a named persona (`systemPrompt` + narrower goal + optional `default_model`/`default_mode` + optional `description`) that *references* a **server** (the transport: `command` + `args` + `env` + `cwd`). Multiple profiles MAY share one server binary — e.g. `pi`, `verifier`, `coder`, `browser-tester`, `red`, `general` all back onto `pi-acp` but each carries its own persona.

The optional `description?: string` field surfaces a one-line summary of what the profile does and when to use it. It appears in `/acp agents`, `acp_status`, `acp_runtime_info`, `acp_doctor`, and the agent-config TUI. Absent → `(no description)` placeholder. Non-string values are rejected by `validateConfig`.

Canonical example: [`docs/agent-profiles-example.json`](docs/agent-profiles-example.json).

### The 7 canonical aliases

| Alias | Server | Description |
|-------|--------|-------------|
| `claude` | `npx @agentclientprotocol/claude-agent-acp` | Claude Code via the official ACP adapter — general-purpose coding agent. |
| `pi` | `pi-acp` | Default pi coding agent — the workhorse for repo-local dev tasks. |
| `verifier` | `pi-acp` | Blind reviewer persona — gates work via the verifier-loop (≥2 unanimous approvals). |
| `coder` | `pi-acp` | Implementation-focused persona — writes GREEN-phase code from RED tests / plans. |
| `browser-tester` | `pi-acp` | E2E/browser persona — drives the abw skill for UI/UX verification. |
| `red` | `pi-acp` | Adversarial/red-team persona — finds edge cases, breaks assumptions, stress-tests designs. |
| `general` | `pi-acp` | Unscoped general assistant — inherits the global pi system prompt, no narrowed goal. |


## ACP Tools — State Manifest

**Before touching any ACP tool**: read [`flow/plans/manifest/state.md`](flow/plans/manifest/state.md) — single source of truth for which tools are `implemented` / `partial` / `stub` / `planned` / `deferred` / `to-sunset`, with gap + plan references. Active registered tools = 13 (audit `index.ts registerTool`). `src/settings/config.ts ACP_TOOL_NAMES` is a legacy list (39) and misleading.
