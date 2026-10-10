---
name: netcatty-pre-push-checks
description: Select the smallest relevant checks before publishing a Netcatty branch, with special handling for Pi, Electron, native packaging, and fork-only pushes.
---
# Netcatty Pre-Push Checks

Use this workflow once before pushing a branch. It selects evidence for the outgoing diff; it does not require the full repository suite for every change.

## Inspect the change

```powershell
git status --short --branch
git rev-parse --show-toplevel
git diff --cached --check
git diff --check
```

The normal base for product work is `catty-main`. The `main` branch is an upstream mirror and must not receive product changes. Publish only to `origin`, never to `upstream`.

## Select evidence

- Pure domain or state behavior: run the owning `node --test --import tsx` files.
- Pi or Catty bridge behavior: run the affected `electron/bridges/aiBridge/sdk` tests plus discovery, state, settings, and eligibility tests that own the changed contract.
- User-visible copy or settings: run the affected locale and lifecycle tests and lint the changed source.
- Build, native dependency, or packaging changes: run `npm run build`, then the relevant directory or platform package command. Windows native work uses the repository's documented Visual Studio environment.
- Generated capability or plugin files: regenerate from the owning source, then run the generator check and its tests.

Do not repeat a passing check merely because a commit or push follows. Report the exact commands that ran and any checks intentionally left to CI.

## Publish safely

Commit normally, verify the staged diff, push the current branch to `origin`, and verify that the remote ref equals `HEAD`:

```powershell
git rev-parse HEAD origin/$(git branch --show-current)
```

History rewrites use `--force-with-lease` with an observed remote OID. Never use raw `--force`. After a branch is merged into `catty-main`, delete it both locally and from `origin`.
