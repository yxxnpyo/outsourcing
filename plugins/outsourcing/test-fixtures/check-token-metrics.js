#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const job = require('../skills/outsourcing/scripts/outsourcing-job.js');

const codexFixturePath = path.join(__dirname, 'token-usage-session.jsonl');
const claudeFixturePath = path.join(__dirname, 'claude-message-usage.jsonl');

assert.equal(typeof job.readSessionUsageSnapshot, 'function', 'readSessionUsageSnapshot should be exported');
assert.equal(typeof job.matchObserverSessionFile, 'function', 'matchObserverSessionFile should be exported');
assert.equal(typeof job.readClaudeSessionUsageSnapshot, 'function', 'readClaudeSessionUsageSnapshot should be exported');
assert.equal(typeof job.matchClaudeSessionFile, 'function', 'matchClaudeSessionFile should be exported');
assert.equal(typeof job.estimateTokenMetrics, 'function', 'estimateTokenMetrics should be exported');

const codexUsage = job.readSessionUsageSnapshot(codexFixturePath);
assert.equal(codexUsage.actual_usage.total_tokens, 2620, 'should read latest total Codex token usage');
assert.equal(codexUsage.actual_usage.output_tokens, 220, 'should preserve latest total Codex output tokens');

const matchedCodex = job.matchObserverSessionFile({
  sessionsRoot: path.join(__dirname),
  cwd: '/tmp/outsourcing-smoke',
  member: 'truncate-text',
  reportPath: '/tmp/jobs/outsourcing-123/members/truncate-text/report.json',
  startedAt: '2026-03-10T09:56:10.000Z',
});
assert.ok(matchedCodex, 'should match the observer session fixture');
assert.equal(path.basename(matchedCodex.filePath), 'token-usage-session.jsonl', 'should match the observer session fixture file');

const claudeUsage = job.readClaudeSessionUsageSnapshot(claudeFixturePath, '2026-03-11T00:00:00.000Z', 'nonce-abc123');
assert.equal(claudeUsage.messageCount, 2, 'should dedupe duplicate Claude message ids');
assert.equal(claudeUsage.actual_usage.input_plus_output_tokens, 131, 'should sum deduped Claude input+output totals');
assert.equal(claudeUsage.actual_usage.cache_tokens, 180, 'should sum deduped Claude cache totals');
assert.equal(claudeUsage.nonceMatched, true, 'should detect the Claude session nonce');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outsourcing-claude-fixture-'));
const projectDir = path.join(tempRoot, '-tmp-outsourcing-smoke');
fs.mkdirSync(projectDir, { recursive: true });
fs.copyFileSync(claudeFixturePath, path.join(projectDir, 'session-a.jsonl'));
process.env.OUTSOURCING_CLAUDE_PROJECTS_DIR = tempRoot;

const matchedClaude = job.matchClaudeSessionFile({
  cwd: '/tmp/outsourcing-smoke',
  startedAt: '2026-03-11T00:00:00.000Z',
  nonce: 'nonce-abc123',
});
assert.ok(matchedClaude, 'should match the Claude session fixture');
assert.equal(path.basename(matchedClaude.filePath), 'session-a.jsonl', 'should select the Claude fixture file');
assert.equal(matchedClaude.actual_usage.input_plus_output_tokens, 131, 'should surface deduped Claude input+output totals');
assert.equal(matchedClaude.actual_usage.cache_tokens, 180, 'should surface deduped Claude cache totals');

const fakeJobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outsourcing-job-'));

const tokenMetrics = job.estimateTokenMetrics(fakeJobDir, {
  createdAt: '2026-03-11T00:00:00.000Z',
  cwd: '/tmp/outsourcing-smoke',
  claudeSessionNonce: 'nonce-abc123',
  settings: {
    tokenEstimator: {
      claude_base_prompt_weight: 1,
      claude_payload_weight: 1,
      claude_result_review_weight: 1,
      claude_final_report_weight: 1,
      claude_retry_weight: 1,
      claude_solo_worker_transfer_ratio: 1,
      worker_prompt_overhead: 1.2,
    },
  },
  tasks: [
    {
      name: 'truncate-text',
      safeName: 'truncate-text',
      payload: { task_name: 'truncate-text', requests: ['x'] },
    },
  ],
}, [
  {
    taskName: 'truncate-text',
    summary: 'Short summary',
    risks: 'none',
    retryCount: 0,
    report: { summary: 'Short summary', risks: 'none' },
    output: '',
    usage: {
      prompt_tokens_estimated: 100,
      output_tokens_estimated: 30,
      report_tokens_estimated: 20,
      total_tokens_estimated: 150,
      actual_usage: { total_tokens: 200, input_tokens: 150, cached_input_tokens: 40, output_tokens: 50 },
      measurement_source: 'exec_json',
    },
  },
]);

assert.ok(tokenMetrics.claude_solo_estimated_tokens >= tokenMetrics.claude_outsourcing_tokens, 'solo estimate should not be lower than outsourcing tokens');
assert.equal(tokenMetrics.claude_outsourcing_tokens_actual, 131, 'Claude actual input+output tokens should be surfaced');
assert.equal(tokenMetrics.claude_cache_tokens, 180, 'Claude cache tokens should be surfaced separately');
assert.equal(tokenMetrics.claude_cache_creation_tokens, 80, 'Claude cache creation tokens should be surfaced');
assert.equal(tokenMetrics.claude_cache_read_tokens, 100, 'Claude cache read tokens should be surfaced');
assert.equal(tokenMetrics.claude_outsourcing_measurement_mode, 'actual', 'Claude measurement mode should indicate actual usage');
assert.equal(tokenMetrics.codex_worker_tokens_actual, 200, 'worker actual tokens should be surfaced');
assert.equal(tokenMetrics.codex_worker_measurement_mode, 'actual', 'worker measurement mode should indicate actual usage');

process.stdout.write('token metric checks passed\n');
