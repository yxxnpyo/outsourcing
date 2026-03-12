#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SCRIPT_DIR = __dirname;
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const OUTPUT_SCHEMA_PATH = path.join(SCRIPT_DIR, 'codex-output-schema.json');

function exitWithError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const [key, rawValue] = token.split('=', 2);
    if (rawValue != null) {
      out[key.slice(2)] = rawValue;
      continue;
    }
    const next = args[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key.slice(2)] = true;
      continue;
    }
    out[key.slice(2)] = next;
    i++;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`outsourcing worker

Usage:
  outsourcing-job-worker.js --job-dir <dir> --member <name> --safe-member <safe> --command <cmd> --cwd <dir> [--observer-command <cmd>] [--mode exec|observer] [--timeout <sec>]
`);
}

function splitCommand(command) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;
  for (const ch of String(command || '')) {
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }
    if (!inSingle && ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (!inDouble && ch === '\'') {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  if (inSingle || inDouble) return null;
  return tokens;
}

function hasExplicitCd(args) {
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '');
    if (token === '-C' || token === '--cd') return true;
    if (token.startsWith('--cd=')) return true;
  }
  return false;
}

function isCodexProgram(program) {
  return path.basename(String(program || '')) === 'codex';
}

function normalizeCodexCommand(command, cwd) {
  const tokens = splitCommand(command);
  if (!tokens || tokens.length === 0) return null;
  const [program, ...args] = tokens;
  if (!isCodexProgram(program) || !cwd || hasExplicitCd(args)) {
    return { program, args };
  }
  const normalizedArgs = [...args];
  if (normalizedArgs[0] === 'exec') {
    normalizedArgs.splice(1, 0, '--cd', cwd);
  } else {
    normalizedArgs.unshift('--cd', cwd);
  }
  return { program, args: normalizedArgs };
}

function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function approxTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.max(1, Math.ceil(text.length / 4));
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function formatBullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) {
    return `- ${fallback}`;
  }
  return items.slice(0, 3).map((item) => `- ${String(item)}`).join('\n');
}

function buildPrompt(memberDir, payload, mode) {
  const workerCore = readText(path.join(SKILL_DIR, 'templates', 'worker-core.md'));
  const reportFormat = readText(path.join(SKILL_DIR, 'templates', 'report-format.md'));
  const reportRules = readJson(path.join(SKILL_DIR, 'templates', 'report-rules.json'));
  const phaseOpeners = readJson(path.join(SKILL_DIR, 'templates', 'phase-openers.json'));
  const projectContext = readText(path.join(memberDir, 'project-context.txt'));
  const correction = readText(path.join(memberDir, 'correction.txt')).trim();
  const reportPath = path.join(memberDir, 'report.json');

  const sections = [];
  sections.push(workerCore.trim());
  sections.push('');
  sections.push('## Task Info');
  sections.push(`- Task name: ${payload.task_name}`);
  sections.push(`- Assigned role: ${payload.worker_role}`);
  sections.push(`- Working directory: ${payload.working_dir}`);
  sections.push(`- Execution mode: ${mode}`);
  sections.push('');
  sections.push('## Task Background');
  sections.push(formatBullets(payload.task_background, 'No task background was provided by the PM.'));
  sections.push('');
  sections.push('## Requested Work');
  sections.push(formatBullets(payload.requests, 'No specific requests were provided.'));
  sections.push('');
  sections.push('## Implementation Targets');
  sections.push(formatBullets((payload.targets || []).map((item) => `${item.path} - ${item.purpose}`), 'No implementation targets were specified.'));
  sections.push('');
  sections.push('## Signatures / Interfaces');
  sections.push(formatBullets(payload.signatures, 'No explicit signatures were provided.'));
  sections.push('');
  sections.push('## Constraints');
  sections.push(formatBullets(payload.constraints, 'No additional constraints were provided.'));
  sections.push('');
  sections.push('## Recommended Skills');
  sections.push(formatBullets(payload.recommended_skills, 'No recommended skills were provided.'));
  sections.push('');
  if (correction) {
    sections.push('## Re-delegation Notes');
    sections.push(`- ${correction}`);
    sections.push('');
  }
  sections.push('## Phase Openers');
  for (const [phase, opener] of Object.entries(phaseOpeners)) {
    sections.push(`- ${phase}: ${opener}`);
  }
  sections.push('');
  sections.push('## Phase Reporting Rules');
  for (const rule of reportRules.rules || []) {
    sections.push(`- ${rule}`);
  }
  sections.push('');
  sections.push('## Phase Reporting Template');
  sections.push(reportFormat.trim());
  sections.push('');
  sections.push('## Additional Instructions');
  sections.push('- Print each phase report only to the pane or stdout.');
  sections.push(`- In the final delivery phase, write the final JSON result to ${reportPath}.`);
  sections.push('- The final report JSON must include files_created, files_modified, status, summary, signatures, dependencies_used, and risks.');
  sections.push('- The final report JSON summary must be a short delivery summary in one or two sentences. Do not paste full phase memos, code blocks, absolute paths, or markdown links into summary.');
  sections.push('- Keep the phase order as planning -> implementation -> verification -> final.');
  sections.push('- Print the [OUTSOURCING][TASK ...][PHASE ...][DONE] block exactly to the pane or stdout.');
  sections.push('');
  if (projectContext.trim()) {
    sections.push('## Project Context');
    sections.push(projectContext.trim());
    sections.push('');
  }
  sections.push('Start the task now.');

  return sections.join('\n');
}

function finalizeStatus(statusPath, payload, usagePath, prompt, output, report, actualUsage) {
  atomicWriteJson(statusPath, payload);
  atomicWriteJson(usagePath, {
    prompt_tokens_estimated: approxTokens(prompt),
    output_tokens_estimated: approxTokens(output),
    report_tokens_estimated: approxTokens(report),
    total_tokens_estimated: approxTokens(prompt) + approxTokens(output) + approxTokens(report),
    actual_usage: actualUsage || null,
    measurement_source: actualUsage ? 'exec_json' : 'estimated_only',
  });
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help || options.h) {
    printHelp();
    return;
  }
  const jobDir = options['job-dir'];
  const member = options.member;
  const safeMember = options['safe-member'];
  const command = options.command;
  const observerCommand = options['observer-command'];
  const mode = options.mode || 'exec';
  const cwd = options.cwd || process.cwd();
  const timeoutSec = Number(options.timeout || 0);

  if (!jobDir || !member || !safeMember || !command) {
    exitWithError('worker requires --job-dir --member --safe-member --command');
  }

  const memberDir = path.join(jobDir, 'members', safeMember);
  const statusPath = path.join(memberDir, 'status.json');
  const outPath = path.join(memberDir, 'output.txt');
  const errPath = path.join(memberDir, 'error.txt');
  const reportPath = path.join(memberDir, 'report.json');
  const usagePath = path.join(memberDir, 'usage.json');
  const payloadPath = path.join(memberDir, 'payload.json');
  const payload = readJson(payloadPath);
  const prompt = buildPrompt(memberDir, payload, mode);
  fs.writeFileSync(path.join(memberDir, 'assembled-prompt.txt'), prompt, 'utf8');

  const startedAt = new Date().toISOString();
  atomicWriteJson(statusPath, {
    member,
    state: 'running',
    startedAt,
    command,
    mode,
    pid: null,
  });

  const launchSpec = normalizeCodexCommand(mode === 'observer' ? (observerCommand || command) : command, cwd);
  if (!launchSpec || !launchSpec.program) {
    finalizeStatus(statusPath, {
      member,
      state: 'error',
      message: 'Invalid command string',
      startedAt,
      finishedAt: new Date().toISOString(),
      command,
    }, usagePath, prompt, '', '');
    process.exit(1);
  }

  const { program, args } = launchSpec;
  const finalArgs = [...args];
  if (mode === 'exec') {
    if (fs.existsSync(OUTPUT_SCHEMA_PATH)) {
      finalArgs.push('--output-schema', OUTPUT_SCHEMA_PATH, '-o', reportPath);
    }
    finalArgs.push('--json');
    finalArgs.push(prompt);
  } else {
    finalArgs.push(prompt);
  }

  const outStream = mode === 'exec' ? fs.createWriteStream(outPath, { flags: 'w' }) : null;
  const errStream = mode === 'exec' ? fs.createWriteStream(errPath, { flags: 'w' }) : null;
  let actualUsage = null;
  let jsonBuffer = '';

  let child;
  try {
    child = spawn(program, finalArgs, {
      cwd,
      env: process.env,
      stdio: mode === 'exec' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (error) {
    finalizeStatus(statusPath, {
      member,
      state: error && error.code === 'ENOENT' ? 'missing_cli' : 'error',
      message: error.message,
      startedAt,
      finishedAt: new Date().toISOString(),
      command,
    }, usagePath, prompt, '', '', actualUsage);
    process.exit(1);
  }

  atomicWriteJson(statusPath, {
    member,
    state: 'running',
    startedAt,
    command,
    mode,
    pid: child.pid,
  });

  if (mode === 'exec') {
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        jsonBuffer += chunk.toString('utf8');
        while (true) {
          const newlineIndex = jsonBuffer.indexOf('\n');
          if (newlineIndex < 0) break;
          const line = jsonBuffer.slice(0, newlineIndex).trim();
          jsonBuffer = jsonBuffer.slice(newlineIndex + 1);
          if (!line) continue;
          const parsed = safeJsonParse(line);
          if (!parsed) {
            outStream.write(`${line}\n`);
            continue;
          }
          if (parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message' && parsed.item.text) {
            outStream.write(`${parsed.item.text}\n`);
          }
          if (parsed.type === 'turn.completed' && parsed.usage) {
            actualUsage = {
              input_tokens: Number(parsed.usage.input_tokens || 0),
              cached_input_tokens: Number(parsed.usage.cached_input_tokens || 0),
              output_tokens: Number(parsed.usage.output_tokens || 0),
              reasoning_output_tokens: Number(parsed.usage.reasoning_output_tokens || 0),
              total_tokens: Number(parsed.usage.total_tokens || (
                Number(parsed.usage.input_tokens || 0) +
                Number(parsed.usage.output_tokens || 0)
              )),
            };
          }
        }
      });
    }
    if (child.stderr) child.stderr.pipe(errStream);
  }

  let timeoutHandle = null;
  let timeoutTriggered = false;
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
    timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }, timeoutSec * 1000);
    timeoutHandle.unref();
  }

  child.on('error', (error) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    finalizeStatus(statusPath, {
      member,
      state: error && error.code === 'ENOENT' ? 'missing_cli' : 'error',
      message: error.message,
      startedAt,
      finishedAt: new Date().toISOString(),
      command,
      exitCode: null,
      pid: child.pid,
    }, usagePath, prompt, readText(outPath), readText(reportPath), actualUsage);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (mode === 'exec' && jsonBuffer.trim()) {
      const line = jsonBuffer.trim();
      const parsed = safeJsonParse(line);
      if (parsed && parsed.type === 'turn.completed' && parsed.usage) {
        actualUsage = {
          input_tokens: Number(parsed.usage.input_tokens || 0),
          cached_input_tokens: Number(parsed.usage.cached_input_tokens || 0),
          output_tokens: Number(parsed.usage.output_tokens || 0),
          reasoning_output_tokens: Number(parsed.usage.reasoning_output_tokens || 0),
          total_tokens: Number(parsed.usage.total_tokens || (
            Number(parsed.usage.input_tokens || 0) +
            Number(parsed.usage.output_tokens || 0)
          )),
        };
      } else if (!parsed) {
        outStream.write(`${line}\n`);
      }
    }
    if (outStream) outStream.end();
    if (errStream) errStream.end();
    const timedOut = Boolean(timeoutTriggered) && (signal === 'SIGTERM' || signal === 'SIGKILL');
    const canceled = !timedOut && (signal === 'SIGTERM' || signal === 'SIGKILL');
    finalizeStatus(statusPath, {
      member,
      state: timedOut ? 'timed_out' : canceled ? 'canceled' : code === 0 ? 'done' : 'error',
      message: timedOut ? `Timed out after ${timeoutSec}s` : canceled ? 'Canceled' : null,
      startedAt,
      finishedAt: new Date().toISOString(),
      command,
      exitCode: typeof code === 'number' ? code : null,
      signal: signal || null,
      pid: child.pid,
    }, usagePath, prompt, readText(outPath), readText(reportPath), actualUsage);
    process.exit(code === 0 ? 0 : 1);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeCodexCommand,
  splitCommand,
};
