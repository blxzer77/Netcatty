---
name: netcatty-code-review
description: Review Netcatty changes against the fork's architecture, Pi/Catty lifecycle rules, Electron boundaries, localization, and packaging evidence.
---
# Reviewing a Netcatty Change

Review the live diff against the verified `catty-main` base. Read the root `AGENTS.md`, the relevant Agent Note, and the owning code before judging the patch.

## Blocking review areas

1. **Agent boundary:** only Catty and Pi are discoverable and selectable. New agent behavior must update the driver, registry, discovery, settings, event translation, cancellation, tests, and packaging path together.
2. **Lifecycle:** every spawned process, IPC listener, stream, timer, and native resource has one owner and a deterministic disposal path. Cancellation must reach the underlying driver.
3. **Electron separation:** renderer code uses typed bridges; main-process capabilities own external I/O, subprocesses, credentials, and filesystem access. Do not add direct network or process access to components.
4. **Model-visible behavior:** prompts, tool descriptions, activity events, errors, and diagnostics are reviewed as product behavior. Product copy belongs in typed locale dictionaries.
5. **Packaging:** native modules and patch-package changes are tested in the packaged app, not only in the source tree. Windows changes must preserve the patched `node-pty` path.
6. **Evidence:** the author reports focused tests, lint, build, or package checks that cover the changed surface. CI is not a substitute for a missing local contract test.

Prefer one substantiated blocker over a list of stylistic comments. Challenge unrelated abstractions, hidden defaults, silent fallback, stale state, and error paths that continue after their preconditions fail.
