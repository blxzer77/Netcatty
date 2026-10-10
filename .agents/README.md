# Netcatty Agent Guidance

This directory contains the maintainer-facing workflows and durable decision records for the Netcatty fork.

- `../AGENTS.md` is the standing repository rule set and architecture map.
- `skills/` contains focused procedures for review, testing, documentation, and Pi integration. A skill is guidance for a task scope, not a replacement for judgment.
- `notes/` contains decisions whose rationale is not obvious from code, tests, or ordinary documentation.

Read the root `AGENTS.md` first. Use `netcatty-pre-push-checks` before publishing a branch, `netcatty-code-review` when reviewing a change, and `netcatty-pi-agent` when changing the Pi bridge, discovery, settings, or event translation.

The fork branch policy is deliberately separate from upstream maintenance: `main` mirrors upstream, `catty-main` is the product branch, and short-lived work branches are deleted locally and remotely after merge.
