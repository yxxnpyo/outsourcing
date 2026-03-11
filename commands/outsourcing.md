---
name: outsourcing
description: "A plugin that lets Claude act as the PM while Codex handles delegated implementation work"
argument-hint: "[task description]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# /outsourcing Command

Claude stays in the PM role, while actual implementation is delegated to Codex outsourced workers.

## Parse Arguments

Inspect `$ARGUMENTS` to determine the action:

| Argument Pattern | Action | Skill |
|-----------------|--------|-------|
| `[task description]` | Start work in outsourcing mode | outsourcing |
| (no argument) | Print a short usage note | See below |

## No Argument Provided

Print a short usage note:

```text
/outsourcing [task description]

Examples:
- /outsourcing implement auth, DB, and API tasks in parallel
- /outsourcing delegate the new feature build to Codex workers
```

## Execute

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/outsourcing/SKILL.md`
2. Follow the skill workflow using `$ARGUMENTS`
3. Keep fixed worker templates on disk; do not restate them fully in chat
