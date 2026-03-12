#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const job = require('../skills/outsourcing/scripts/outsourcing-job.js');
const worker = require('../skills/outsourcing/scripts/outsourcing-job-worker.js');

assert.equal(typeof job.parseOutsourcingConfig, 'function', 'parseOutsourcingConfig should be exported');
assert.equal(typeof worker.normalizeCodexCommand, 'function', 'normalizeCodexCommand should be exported');

const missingConfigPath = path.join(os.tmpdir(), `outsourcing-missing-${process.pid}.yaml`);
const config = job.parseOutsourcingConfig(missingConfigPath);
assert.equal(
  config.outsourcing.defaults.command,
  'codex exec --sandbox danger-full-access --ask-for-approval never --ephemeral',
  'default exec command should use explicit full access flags'
);
assert.equal(
  config.outsourcing.defaults.observer_command,
  'codex --sandbox danger-full-access --ask-for-approval never --no-alt-screen',
  'default observer command should use explicit full access flags'
);

const execLaunch = worker.normalizeCodexCommand(
  'codex exec --sandbox danger-full-access --ask-for-approval never --ephemeral',
  '/tmp/worker-project'
);
assert.deepEqual(
  execLaunch,
  {
    program: 'codex',
    args: ['exec', '--cd', '/tmp/worker-project', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--ephemeral'],
  },
  'exec launch should inject --cd after the exec subcommand'
);

const observerLaunch = worker.normalizeCodexCommand(
  'codex --sandbox danger-full-access --ask-for-approval never --no-alt-screen',
  '/tmp/worker-project'
);
assert.deepEqual(
  observerLaunch,
  {
    program: 'codex',
    args: ['--cd', '/tmp/worker-project', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--no-alt-screen'],
  },
  'interactive launch should inject --cd before other options'
);

const absolutePathLaunch = worker.normalizeCodexCommand(
  '/opt/homebrew/bin/codex exec --sandbox danger-full-access --ask-for-approval never --ephemeral',
  '/tmp/worker-project'
);
assert.deepEqual(
  absolutePathLaunch,
  {
    program: '/opt/homebrew/bin/codex',
    args: ['exec', '--cd', '/tmp/worker-project', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--ephemeral'],
  },
  'absolute codex paths should also receive cwd injection'
);

const preservedLaunch = worker.normalizeCodexCommand(
  'codex exec --cd=/tmp/already-set --sandbox danger-full-access --ask-for-approval never --ephemeral',
  '/tmp/worker-project'
);
assert.deepEqual(
  preservedLaunch,
  {
    program: 'codex',
    args: ['exec', '--cd=/tmp/already-set', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--ephemeral'],
  },
  'existing --cd should not be duplicated'
);

const nonCodexLaunch = worker.normalizeCodexCommand(
  'bash /tmp/fake-outsourcing-worker.sh',
  '/tmp/worker-project'
);
assert.deepEqual(
  nonCodexLaunch,
  {
    program: 'bash',
    args: ['/tmp/fake-outsourcing-worker.sh'],
  },
  'non-Codex commands should remain unchanged'
);

const syncScript = path.join(__dirname, '..', 'scripts', 'sync-marketplace.sh');
assert.ok(fs.existsSync(syncScript), 'sync-marketplace.sh should exist');
execFileSync('bash', [syncScript, '--check'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'pipe',
});

process.stdout.write('launch config checks passed\n');
