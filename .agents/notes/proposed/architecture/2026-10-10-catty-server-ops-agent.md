# Agent Note: Catty is the personal server-management agent
Status: proposed

## Problem

Catty is the fork's built-in agent, but its role was never defined from the user's
workload. It presents itself as a general Netcatty automation assistant: the always-on
Guidelines block leads with Vault inventory work, and the sidebar exposes all 73 catalog
tools. The owner of this fork runs a handful of fixed private servers — proxies plus
self-hosted services — and wants the agent to do the operating work for them.

The requirement is a **server-management agent that runs inside Netcatty, not an agent
that runs on the server**: no remote daemon, no scheduled background run, no unattended
maintenance. Everything happens interactively, through the sessions the user already has
open, under approval.

Concrete requirements collected from the user:

- **Scope**: a fixed small set of personal machines (not a fleet), reachable through
  Netcatty connections; proxies and self-hosted services are the workloads that matter.
- **Tasks**: diagnosis, change and maintenance, inspection with reporting, file and
  config transport between machines, and cross-machine consistency comparison.
- **Autonomy**: goal-driven. The agent plans, the user approves the plan once, the agent
  executes. It stops and asks when reality diverges from the plan.
- **Approval**: nothing is categorically forbidden, but everything needs review. The unit
  of approval is the plan (a step list with a single approve action), not the individual
  command.
- **Red line**: the proxy path is the user's own ingress/egress. Before any change that
  could break it, the agent must establish a backup access path: confirm another live
  connection to the host exists, verify an alternate route is actually reachable, back up
  the current configuration, and state the recovery steps in the plan it asks the user to
  approve.
- **Delivery**: a conclusion plus the evidence behind it, not a transcript.
- **Memory**: machine state and prior actions survive across chat sessions, stored in
  editable vault host notes.
- **Inspection**: delivered as a skill plus runbook the user invokes — no cron, no
  background loop.

## Proposal

Reposition Catty as the personal server-management agent and make that scope explicit in
prompt, tool surface, approval, and memory. The runtime stays where it is: the agent
operates the client's live sessions and nothing more.

**1. Prompt.** Rewrite `buildSystemPrompt` around one purpose — managing a small fixed set
of servers through their live sessions — with diagnosis, change, verification, inspection
and transport as the named task classes. Keep the existing cacheable-prefix invariant
(static guidelines first, dynamic scope/sessions/permission/skills after).

**2. Tool surface.** Classify the catalog by role:

- *Perceive* (read-only): `session.environment`, `terminal.poll`, `terminal.read_context`,
  `sftp.list`, `sftp.read_file`, `sftp.stat`, `sftp.home`, `portforward.tunnels.list`,
  `harness.workspace.get_info`, `harness.workspace.get_session_info`,
  `harness.tool_output.read`, `harness.url.fetch`, `harness.web.search`.
- *Change* (write): `terminal.execute`, `terminal.start`, `terminal.stop`, `sftp.upload`,
  `sftp.write_file`, `sftp.mkdir`, `sftp.rename`, `sftp.delete`, `sftp.chmod`,
  `sftp.download`, `portforward.start`, `portforward.stop`.
- *Machine record*: read and update host notes so the agent's cross-session memory lives in
  an editable place the user owns.
- *Loop*: `harness.plan.submit`, the tool the agent uses to propose work for approval.
- *Everything else* (`vault.*` beyond host notes, snippets, scripts, groups, identities,
  proxy profiles, port-forward rule CRUD, attachments, `session.close`) leaves the sidebar
  agent and stays managed through the Netcatty UI, MCP, and the CLI.

Exposure is decided in `electron/capabilities/catalog/` through a new
`agentToolsets: ["server-ops"]` marker that `toolSurfaces.cjs` gates the sidebar agent on —
never by filtering in the renderer. The sidebar set is 28 tools, down from 73.

Two deliberate deviations from the first draft of this list:

- **`portforward.start` / `portforward.stop` stay.** Writing rules is inventory, but
  starting and stopping an existing tunnel is how the agent makes a service reachable, and
  the shipped prompt tells it to use port-forward tunnels instead of shell workarounds.
  Removing them would contradict the prompt.
- **All 11 SFTP tools stay.** Transport between hosts is one of the four task classes, and
  SFTP is the specific tool for it.

**3. Plan, approve, execute.** Replace per-tool-call approval as the primary flow with a
plan artifact: the agent emits a numbered plan (command, target host, reason, expected
verification), the user approves once, execution proceeds serially per host, and any
divergence stops the run and asks. Keep per-call approval as the fallback for ad-hoc
single commands, and keep Observer strictly read-only.

**4. Backup-access precondition.** A required preflight before any action that can break
the proxy path: verify a second live connection to the target host, test an alternate
route for reachability, back up the affected configuration, and include the recovery
procedure in the plan. The plan must show the result of each check.

**5. Coordination.** Serialize writes to the same host across every chat session, not just
within one (today's queue key is `chatSessionId:sessionId`, which leaves two sessions
racing on the same machine). Batch runs report per-host outcomes and a summary; a failure
on one host must not stop or corrupt the others.

**6. Memory.** Machine state, prior actions, and conclusions live in vault host notes,
written by the agent and editable by the user; secrets are redacted before anything
reaches the model.

## Alternatives considered

**An agent that runs on the server.** Rejected by the user: no remote deployment, no
daemon, no unattended maintenance. The agent's hands are the user's existing sessions.

**A resident, scheduled inspection agent.** Also rejected: no background loop and no
timer. Inspection is a skill plus runbook the user invokes.

**Keep the full Vault management surface in the agent.** Conflicts with the goal — the
agent should manage servers, not manage Netcatty's inventory. Host notes are the single
exception, because they are where the machine record lives.

**Rewrite the runtime and event protocol.** Unnecessary. `AgentRuntime`, trace, compaction,
output store, and the session queue are production-quality; the gap is the agent
definition, so the work is prompt, tool exposure, approval unit, and coordination.

**Per-command approval only.** Safe, but the user explicitly asked for plan-level approval
and does not want to operate the machine by hand.

## Acceptance criteria

- The prompt states the server-management purpose first; the static prefix stays stable
  across turns for the same configuration.
- The sidebar tool set is derived from the catalog, contains exactly the 28
  server-ops tools (golden list in `toolSurfaces.test.cjs`), and holds no Vault capability
  beyond host notes; `npm run generate:capability-tools` plus
  `git diff --exit-code infrastructure/ai/harness/generated/cattyToolSpecs.json` is clean.
- The MCP tool list and the global agent tool list are byte-for-byte what they were before
  the narrowing (69 and 68 tools), so external contracts are untouched.
- A plan can be approved once and then executed; execution stops on divergence and asks;
  Observer mode still denies every write; every action is recorded in the trace.
- The backup-access precondition runs before proxy-affecting actions, is visible in the
  plan, and blocks the action when it fails.
- Writes to the same host serialize across chat sessions; a batched run reports per-host
  results and survives single-host failures.
- Machine state and prior actions are readable in a new chat session and editable by the
  user in host notes; secrets never reach the model.
- A fixed smoke set passes: single-host diagnosis, a change with verification, an
  inspection skill run, a transport task, and a cross-machine consistency comparison.
- No background or scheduled execution exists: no resident process, no timer trigger.

## Risks

- **Plan approval is a new surface.** It needs an event, a rendering, continuation, and
  stop semantics that fit the existing `AgentEvent` protocol and the compact activity
  view. Per-tool approval must keep working for ad-hoc commands.
- **The precondition can block legitimate work.** A user with only one connection to a
  host needs an explicit, honest "continue anyway" path that records the risk.
- **Host notes become a schema.** They carry machine records written by the agent and
  edited by the user, so format, redaction, and concurrent edits need a decision.
- **Cost control is still on us.** A smaller tool set is the main lever on the per-turn
  prompt cost; the plan artifact itself adds tokens and must stay terse.
- **Do not over-build for a fleet.** The target is a handful of machines. Batch execution
  and comparison must not grow a cluster abstraction that this user does not need.

## Open questions

- Exact agent-facing shape of host notes (structured record vs. free markdown with a
  fixed header block).
- Which capabilities count as "proxy-affecting" for the precondition (proxy service
  commands, firewall rules, `portforward_start`, routing changes).
- Whether the plan artifact is persisted for audit, and for how long.
