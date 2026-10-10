# Netcatty Agent Guidance

`plans/` holds the working plan for a substantial change that is not finished yet: the
requirements it must satisfy, the phases that will get there, and the gate each phase has
to pass. A plan is not a decision record — the durable decisions and their rationale live
in `../notes/`.

- Use `plans/yyyy-mm-dd-topic-title.md`.
- A plan links to the note that carries the decision it implements.
- Update the phase status as work lands; when the plan is complete, move the decision into
  `notes/implemented/` and archive or delete the plan.
- Keep acceptance criteria checkable (commands, tests, observable behavior), not intentions.
