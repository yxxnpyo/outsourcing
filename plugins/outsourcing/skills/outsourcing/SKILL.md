---
name: outsourcing
description: Claude acts as the PM, plans the work, and delegates implementation to Codex outsourced workers. Fixed templates stay on disk, and Claude only emits compact payloads so implementation-token burden shifts away from Claude.
---

# outsourcing - Claude PM / Codex Outsourced Workers

`outsourcing` is not trying to minimize total system-wide tokens at any cost. Its purpose is to shift Claude Code's implementation-token usage onto Codex workers.

## When to use it

- When there are at least three independent implementation tasks
- When Claude can define signatures, constraints, and task background clearly
- When Codex workers can implement most of the work autonomously

## When not to use it

- A tiny task with one or two edits
- A single-file tweak
- Work that requires each worker to receive a large repeated context dump

## Role split

- Claude PM: planning, task decomposition, task background, compact payload generation, final synthesis
- Codex Worker: implementation, phase reporting, verification, delivery reporting

Claude must not restate long worker templates in chat for every task.

## Fixed assets

Worker prompts and reporting rules come from these files:

- `templates/worker-core.md`
- `templates/report-format.md`
- `templates/phase-openers.json`
- `templates/report-rules.json`
- `schemas/task-payload.schema.json`
- `schemas/final-report.schema.json`

## Worker phases

Worker phases are fixed to exactly four steps:

1. `planning`
2. `implementation`
3. `verification`
4. `final`

At the end of each phase, the Codex worker must print a fixed-marker memo to the pane or stdout.

## Worker payload rules

Claude should keep its contribution compact and only provide:

- `task_name`
- `worker_role`
- `working_dir`
- `task_background`
- `requests`
- `targets`
- `signatures`
- `constraints`
- `recommended_skills`

The PM must provide the task background explicitly. Workers must not hallucinate it.

## Claude session nonce

When this plugin starts, Claude should generate a short session nonce and print it once in the conversation, for example:

`outsourcing session nonce: 7f3c2e1a`

Claude should pass the same value to the orchestrator with `--claude-session-nonce`.

This keeps Claude token measurement stable even when multiple Claude Code sessions are open in the same project.

## Observer Mode

- Preferred observer backend: `tmux`
- Observer panes exist for human visibility
- Claude should not continuously read implementation logs from the panes
- The orchestrator only parses structured markers and state transitions

## Re-delegation policy

- Failed tasks may be re-delegated automatically
- Correction context must stay short and specific
- Retry count must be bounded

## Final reporting

Claude's final report must include:

- Per-task completion or failure summary
- Retry history
- Key risks
- `Claude Code solo estimate`
- `Claude Code outsourcing tokens`
- `Claude Code token savings rate`
- `Codex Worker tokens`

## Execution rules

1. Decompose the work.
2. Generate and print a short Claude session nonce.
3. Produce compact payloads.
4. Assemble worker prompts from local templates.
5. Delegate implementation to Codex workers, passing the nonce to the orchestrator.
6. Validate with local gates and worker reports.
7. Keep Claude's final synthesis short.
