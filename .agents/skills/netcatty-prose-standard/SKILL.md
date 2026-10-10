---
name: netcatty-prose-standard
description: Write and review Netcatty documentation, comments, diagnostics, prompts, localization, and agent guidance without losing behavioral contracts.
---
# Netcatty Prose Standard

Write enough to preserve the contract, then remove repetition and implementation narration. Keep the actor, condition, timing, modality, ownership, side effect, failure, and consequence that a maintainer or user needs.

- Comments explain non-obvious ownership, ordering, security, lifecycle, or failure behavior; they do not restate code.
- Public bridge and driver docs state inputs, outputs, cancellation, errors, side effects, and process ownership.
- Product text, accessibility labels, tooltips, and settings descriptions belong in typed locale dictionaries.
- Agent Notes retain the decision, alternatives, consequences, and verification; they do not become changelogs.
- Diagnostics name the failing subject, violated rule, and correction when the fix is not obvious.
- Update the owning source before generated catalogs or derived output, then run the narrow documentation and behavior checks.

When two phrasings preserve the same facts, choose the shorter one. Do not weaken a negative guarantee or hide a limitation to make prose sound smoother.
