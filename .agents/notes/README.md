# Agent Notes

An Agent Note records a durable decision or proposal for this codebase: the problem, the choice, the alternatives that lost, and the consequences. It is not a changelog or a transcript of implementation work.

## Lifecycle and layout

Use `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- `proposed/` — a substantial change that is not shipped yet.
- `implemented/` — a decision that is present in the product and kept current with the code.
- `rejected/` — a proposal kept only while its failure prevents a tempting mistake.
- `archived/` — a frozen historical record. Archived notes are never edited.

Classes are `feature`, `bug-fix`, `simplification`, `architecture`, `process`, and `testing`. Use `architecture` for shipped source and runtime decisions; use `process` for tooling, branch, or workflow decisions.

Do not create a centralized index. The path is the inventory. Before adding a note, search active notes for an older record about the same decision and supersede or cross-link it deliberately.

## Format

Every active note starts with:

```markdown
# Agent Note: <title>
Status: proposed
```

The status must match its lifecycle: `proposed`, `implemented`, or `rejected — <reason>`. Every note contains `## Problem` and `## Alternatives considered`. Proposed notes use `## Proposal`, `## Acceptance criteria`, and `## Risks`; implemented notes use `## Decision` and `## Consequences`.

Mechanical edits and local UI changes do not need a note. A lasting ownership boundary, compatibility rule, security decision, user-visible capability choice, or test strategy does.

When a decision is fully replaced, preserve unique rationale before deleting or archiving the old note. Do not edit an archived note.
