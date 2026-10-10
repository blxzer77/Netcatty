---
name: netcatty-pi-agent
description: Guide changes to the Pi Agent integration across discovery, settings, bridge drivers, normalized events, cancellation, tests, and Windows packaging.
---
# Netcatty Pi Agent Integration

Treat Pi as a first-class driver, not a UI-only alias. Before changing it, inspect the driver, SDK registry, discovery handlers, managed-agent state, settings, send eligibility, and the existing Catty event protocol.

Every Pi change must answer:

- How is the executable discovered and how are missing or invalid installations reported?
- Which process owns the child process, IPC stream, cancellation, and teardown?
- How are Pi messages, tool calls, file changes, usage, warnings, and failures translated to the shared event protocol?
- Which settings and locale keys are user-visible, and which stale configurations are rejected or migrated?
- Which focused tests would fail if discovery, lifecycle, event ordering, or send eligibility regressed?
- Does the Windows packaged app contain the native runtime and patched `node-pty` artifacts?

Do not reintroduce hidden provider selection, direct renderer subprocesses, silent fallback to another agent, or a second event vocabulary. If the supported-agent set changes, update the `pi-catty-agent-boundary` Agent Note in the same change.
