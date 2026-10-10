# Agent Note: Catty is the server-operations agent
Status: proposed

## Problem

Catty is the fork's built-in agent: `CattyTurnDriver` runs a Vercel AI SDK `streamText`
loop (`infrastructure/ai/harness/turnDrivers/cattyStreamProcessor.ts`) over the catalog
tool surface, and its always-on system prompt comes from
`infrastructure/ai/cattyAgent/systemPrompt.ts`. Today both present Catty as a general
Netcatty automation assistant rather than a server-operations agent.

Two consequences follow:

1. The role is ambiguous. The Guidelines block leads with Vault inventory work
   (`vault_hosts_create`, `vault_hosts_import`, `vault_notes_*`) and keeps snippets,
   scripts, and host-notes guidance in the always-on prefix, so every ordinary ops turn
   pays prompt budget and attention for capabilities it will not use.
2. Scope is not explicit anywhere. The sidebar tool surface exposes all 73 catalog tools
   at once (`cattyToolSpecs.json`), so neither the model nor the user reviewing an
   approval prompt has a crisp notion of what this agent is for, and which writes deserve
   confirmation.

The fork wants Catty to be the agent you point at live sessions to diagnose, change, and
automate remote hosts.

## Proposal

Make "server operations" the explicit scope of Catty in the three places that define an
agent, and keep the capability catalog as the single source of truth for all three.

**1. Prompt.** Rewrite `buildSystemPrompt` around one purpose: operating live terminal
sessions and the servers behind them (diagnosis, change, verification, automation). Drop
the always-on Vault/notes/snippets tutorials from the Guidelines block; state the
management tools only where a section is gated by whether those tools are in the current
tool set. Keep the existing invariant that the static, cacheable prefix stays stable
across turns and that dynamic sections (scope, sessions, permission mode, skills) are
appended after it.

**2. Tool surface.** Classify the catalog by role instead of exposing everything:

- Core ops: `session.environment`, `terminal.*`, `session.close`, `sftp.*`, the
  port-forwarding tunnel actions, `attachment.*`, `harness.tool_output.read`,
  `harness.url.fetch`, `harness.web.search`, `harness.workspace.*`.
- Inventory and knowledge management: `vault.host*`, `vault.group*`, `vault.note*`,
  `vault.identity.list`, `vault.proxyProfile.list`, host connect scripts, `snippets.*`,
  `scripts.*` (including rule CRUD under `portforward.rules.*`).

Exposure is decided in `electron/capabilities/catalog/` through the existing
`surfaces` / `agentKinds` mechanism and the generated specs, not by ad-hoc filtering in
the renderer. Inventory tools stay implemented and keep their MCP and CLI surfaces; the
question this note decides is only what the sidebar agent advertises by default.

**3. Capabilities.** Run an inventory pass against real ops tasks and add the missing ones
(for example service/unit state, disk and network diagnosis, log retrieval, batch
execution across several sessions) as catalog entries first, then regenerate with
`npm run generate:capability-tools`. No tool may be added to the sidebar by editing
generated JSON.

**4. Approval.** Keep Observer strictly read-only. For Confirm mode, state the write
classes once in the prompt in operational terms (command execution, file writes and
transfers, tunnel start, session close) so the user's approval decisions match the
agent's stated scope.

## Alternatives considered

**Keep Catty general and split server ops into a second agent.** This adds a second
in-tree streaming agent with its own prompt, tool surface, approval policy, and tests,
while the fork already commits to exactly Catty and Pi as supported agents
(`2026-10-10-pi-catty-agent-boundary`). Rejected unless Catty and an ops agent genuinely
need different runtimes rather than different scope.

**Only rewrite the prompt.** Cheapest change, but the tool surface is what drives tool
selection, approval review, and per-turn token cost, so the role would stay ambiguous.

**Hide tools in the renderer.** Leaves the catalog, MCP, and CLI views disagreeing about
what Catty can do, and reintroduces a second source of truth for exposure.

**Keep every tool because tokens are cheap.** A 73-tool surface with overlapping
inventory and ops actions measurably widens tool choice and dilutes the prompt; the cost
is not only tokens.

## Acceptance criteria

- `buildSystemPrompt` states the server-operations purpose first, and its static prefix
  stays byte-stable across turns for the same configuration (existing prompt-structure
  test keeps passing).
- The sidebar tool set is derived from the catalog, and the CI drift check stays clean:
  `npm run generate:capability-tools` followed by
  `git diff --exit-code infrastructure/ai/harness/generated/cattyToolSpecs.json` produces
  no diff.
- MCP (`netcatty-mcp-server`) and CLI tool lists are unchanged except where a catalog
  entry deliberately changes, and their tests pass.
- Approval behavior is unchanged for existing write classes: Observer denies writes,
  Confirm asks per `policy.write && !policy.bypassesApproval`, Auto runs them.
- A fixed set of ops smoke tasks (single-host diagnostics, file read/write, long-running
  job, multi-session fan-out) completes without reaching for management tools.

## Risks

- The catalog is shared by the sidebar agent, the global agent, MCP, and the CLI.
  Pruning sidebar exposure must not silently change those contracts; each surface removal
  needs the corresponding test updated in the same change.
- Users who currently drive Vault inventory work through Catty lose the obvious path; the
  replacement must be a documented, discoverable way to reach those tools rather than a
  hidden one.
- Prompt restructuring can break provider prompt caching if static and dynamic sections
  get reordered; the cacheable-prefix invariant must survive the rewrite.
- Tool-count shrinkage can hide a capability the model previously used to self-correct
  (for example `tool_output_read` for truncated results); the keep-list has to be derived
  from ops transcripts, not from intuition.
