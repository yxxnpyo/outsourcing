![outsourcing hero](./docs/outsourcing-hero.png)

# outsourcing

`outsourcing` is a Claude Code plugin that treats Claude Code as the PM and Codex as outsourced implementation workers.

This plugin is not just about parallel execution.

> Move implementation-token burden away from Claude Code and onto Codex workers.

In other words, `outsourcing` is not a tool that promises to minimize total tokens in every situation. It is a delegation orchestrator designed to reduce Claude Code's implementation-token usage when delegation is structured well.

## In one line

- Claude Code (Opus 4.6): PM, planning, decomposition, supervision, final synthesis
- Codex (Codex-5.4): outsourced implementation workers, actual build and implementation
- `tmux` Observer Mode: visible Codex TUI panes for human observation

## Why it exists

In a default LLM coding workflow, Claude often plans and implements directly, which means Claude also absorbs most implementation-token cost.

`outsourcing` intentionally splits that workflow.

- Claude defines what to build and why it matters.
- Codex handles how the implementation gets done.

This only works if a few rules stay intact:

- Claude does not write large implementation bodies before delegation
- Worker templates and reporting rules stay on disk
- Claude sends compact payloads only
- Validation leans on gates and structured worker reports

## Core features

### 1. Explicit Claude PM / Codex Worker split

Claude stays in the PM role. Codex workers handle actual implementation.

### 2. Parallel Codex delegation

Independent tasks can be split across multiple Codex workers and executed in parallel.

### 3. Observer Mode

`tmux` panes can show real Codex TUI sessions while the work is happening.

The important part is that this is an observation surface for humans, not a design that forces Claude to keep reading worker logs.

### 4. Fixed phase reporting

Worker phases are fixed to four steps:

- `planning`
- `implementation`
- `verification`
- `final`

At the end of each phase, a worker prints a structured report block:

```text
[OUTSOURCING][TASK ...][PHASE ...][DONE]
Reporting implementation completion.
...
[OUTSOURCING][END]
```

### 5. Final token metrics

Final output includes:

- `Claude Code solo estimate`
- `Claude Code outsourcing tokens`
- `Claude Code token savings rate`
- `Codex Worker tokens`

Supporting metrics are also included:

- `Claude Code outsourcing estimate`
- `Claude Code outsourcing actual`
- `Claude cache tokens`
- `Claude cache creation tokens`
- `Claude cache read tokens`
- `Claude Code outsourcing estimation error`
- `Claude Code measurement mode`
- `Codex Worker estimated tokens`
- `Codex Worker actual tokens`
- `Codex Worker estimation error`
- `Codex Worker measurement mode`

## How it works

1. Claude decomposes the work.
2. Claude produces compact worker payloads instead of long implementation bodies.
3. The plugin assembles worker prompts from local templates plus payloads.
4. Codex workers perform the implementation.
5. Workers emit phase reports with fixed markers.
6. Claude reads the results and writes a short final synthesis.

## Directory structure

```text
plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── outsourcing.md
├── docs/
│   └── outsourcing-hero.png
├── skills/
│   └── outsourcing/
│       ├── SKILL.md
│       ├── schemas/
│       ├── scripts/
│       └── templates/
├── test-fixtures/
└── outsourcing.config.yaml
```

## Key design points

### Claude does not regenerate long templates

Worker prompts and reporting rules are externalized into local files:

- `skills/outsourcing/templates/worker-core.md`
- `skills/outsourcing/templates/report-format.md`
- `skills/outsourcing/templates/phase-openers.json`
- `skills/outsourcing/templates/report-rules.json`

Claude only emits task-specific payload data.

### Task background is not allowed to hallucinate

Workers must only restate the task background that the PM supplied.

### Observer marker parsing is prefix-robust

Codex TUI output may include bullets or box-drawing prefixes. The orchestrator parses from `[OUTSOURCING]` onward so prefix changes do not break phase detection.

## Requirements

- Claude Code
- Codex CLI
- Node.js
- `tmux`

Install dependencies:

```bash
cd plugin/skills/outsourcing
npm install
```

## Official Claude Code plugin workflow

Anthropic's official Claude Code plugin docs match this repository structure:

- plugins use `.claude-plugin/plugin.json` for manifest metadata
- marketplace repositories use `.claude-plugin/marketplace.json`
- plugin skills live under `skills/`
- plugin commands live under `commands/`
- local development uses `claude --plugin-dir ./plugin`
- plugin changes can be reloaded with `/reload-plugins`

For marketplace distribution, Anthropic's official docs currently point developers to the in-app submission forms in Claude.ai or the Console.

This repository now includes a marketplace manifest so the published repo can also act as a direct marketplace source.

## Basic flow

1. Prepare `outsourcing.config.yaml` or a run-specific config.
2. Claude generates a short session nonce and prints it once in the conversation, for example `outsourcing session nonce: 7f3c2e1a`.
3. Start from Claude Code with `/outsourcing ...`.
4. Claude decomposes the work, emits worker payloads, and passes the same nonce to the orchestrator.
5. The plugin launches Codex workers with explicit full-access defaults and preserves each task working directory.
6. Workers implement and report.
7. Claude synthesizes the final result.

## Default worker permissions

- Exec default: `codex exec --sandbox danger-full-access --ask-for-approval never --ephemeral`
- Observer default: `codex --sandbox danger-full-access --ask-for-approval never --no-alt-screen`
- Observer workers open in the task directory. If that directory is not yet trusted by Codex, the trust prompt may appear before the worker starts.
- Custom task-level `command` and `observer_command` values are still supported.

## Local plugin test

Use the official local-loading flow during development:

```bash
claude --plugin-dir ./plugin
```

Then, inside Claude Code:

```text
/reload-plugins
/outsourcing ...
```

If you publish this repository, the official marketplace flow can point at the repo directly:

```text
/plugin marketplace add <owner>/<repo>
/plugin install outsourcing@<owner>/<repo>
```

## Testing

Practical test fixtures are included under `test-fixtures/`.

- `practical-one-task.yaml`
- `practical-three-task.yaml`
- `practical-smoke-workspace/`

These fixtures validate:

- 1-task observer execution
- 3-task parallel exec execution
- phase marker detection
- gate passes
- final report generation
- token metric aggregation
- launch command normalization
- marketplace copy sync verification

## Marketplace sync

`plugin/` is the editable source of truth. Refresh the marketplace copy after root plugin changes:

```bash
bash plugin/scripts/sync-marketplace.sh
```

Check whether the nested copy is already up to date:

```bash
bash plugin/scripts/sync-marketplace.sh --check
```

## Verification status

The current implementation has already been validated for:

- real Codex 1-task observer execution
- real Codex 3-task parallel execution
- phase marker detection
- observer state reflection
- final report generation
- token metric generation
- observer session-log-based worker token measurement
- exec JSON usage-based worker token measurement
- Claude project-session-log-based Claude token measurement with duplicate `message.id` dedupe

## Token measurement model

`outsourcing` treats token metrics in two layers.

### Codex Worker tokens

Codex worker tokens use actual measurements when available.

- `exec` mode: `codex exec --json` -> `turn.completed.usage`
- `observer` mode: `~/.codex/sessions/*.jsonl` -> `token_count`
- estimate only when measured data is unavailable

That means `Codex Worker tokens` is the metric closest to actual runtime usage.

### Claude Code tokens

Claude token metrics are split into two separate concepts.

#### Claude Code outsourcing tokens

This is the token usage Claude actually spent while acting as the PM for the outsourcing run, when measurable.

- source: `~/.claude/projects/<project>/<session>.jsonl`
- field: `message.usage`
- dedupe rule: keep the last record for each `message.id`
- outsourcing formula: `input_tokens + output_tokens`

Claude cache tokens are reported separately:

- `Claude cache tokens = cache_creation_input_tokens + cache_read_input_tokens`
- `Claude cache creation tokens = cache_creation_input_tokens`
- `Claude cache read tokens = cache_read_input_tokens`

Claude session logs may record the same `message.id` multiple times during streaming. Earlier records are partial. The plugin keeps only the last record for each message id to avoid double counting.

For reliable matching when multiple Claude Code sessions are open in the same project, use a short session nonce:

- Claude prints a one-line nonce into the conversation
- the same nonce is passed to the orchestrator with `--claude-session-nonce`
- do not append that flag to `codex` or `codex exec`; it is only for the outsourcing start command
- the plugin prefers session files whose message content contains that nonce

Without a nonce, the plugin falls back to a best-effort match using project directory and timestamps.

If a Claude session log cannot be matched, the plugin falls back to the artifact-based estimate.

#### Claude Code solo estimate

This is still an estimate of how many Claude tokens the same work might have consumed if Claude had implemented directly.

It remains heuristic on purpose.

- It is based on prompt, payload, review, synthesis, and retry artifacts
- It adds shifted implementation burden conservatively
- When actual Claude outsourcing usage is available, the solo estimate is floored above that actual PM spend plus shifted implementation burden
- It does not directly copy raw Codex actual usage into the solo estimate

### How to interpret savings

`Claude Code token savings rate` is an operational indicator, not billing-grade accounting.

It is meaningful for comparing delegation structure, but it should not be marketed as exact invoice math.

## Caveats

- Observer Mode may reach logical completion before the Codex TUI process exits.
- `Claude Code solo estimate` is still heuristic.
- `Claude Code outsourcing tokens` is actual only when a matching Claude session log is found; otherwise it falls back to an estimate.
- `Claude cache tokens` are only available when a matching Claude session log is found.
- Observer-mode worker token counts can be large because they reflect the whole TUI session.
- The goal of this plugin is to move implementation burden away from Claude, not to guarantee global token minimization.

## License

MIT
