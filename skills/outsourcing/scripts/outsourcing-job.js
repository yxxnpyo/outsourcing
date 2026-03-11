#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const PLUGIN_DIR = path.resolve(SKILL_DIR, '../..');
const WORKER_PATH = path.join(SCRIPT_DIR, 'outsourcing-job-worker.js');
const OBSERVER_PATH = path.join(SCRIPT_DIR, 'outsourcing-observer.js');
const CONFIG_FILE = path.join(PLUGIN_DIR, 'outsourcing.config.yaml');
const DEFAULT_CODEX_COMMAND = 'codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral';
const DEFAULT_OBSERVER_COMMAND = 'codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen';
const DEFAULT_TIMEOUT_SEC = 3600;

function exitWithError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [] };
  const booleanFlags = new Set(['json', 'text', 'checklist', 'help', 'h', 'observer', 'no-observer', 'verbose']);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const [key, rawValue] = token.split('=', 2);
    const normalized = key.slice(2);
    if (rawValue != null) {
      out[normalized] = rawValue;
      continue;
    }
    if (booleanFlags.has(normalized)) {
      out[normalized] = true;
      continue;
    }
    const next = args[i + 1];
    if (next == null || next.startsWith('--')) {
      out[normalized] = true;
      continue;
    }
    out[normalized] = next;
    i++;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`outsourcing - Claude PM / Codex outsourced workers

Usage:
  outsourcing-job.sh start [--config path] [--jobs-dir path] [--observer|--no-observer] [--claude-session-nonce value] "project context"
  outsourcing-job.sh status [--json|--text|--checklist] <jobDir>
  outsourcing-job.sh wait [--cursor CURSOR] [--interval-ms N] [--timeout-ms N] <jobDir>
  outsourcing-job.sh results [--json] <jobDir>
  outsourcing-job.sh gates [--json] <jobDir>
  outsourcing-job.sh redelegate --task <name> [--correction "text"] <jobDir>
  outsourcing-job.sh autofix <jobDir>
  outsourcing-job.sh stop <jobDir>
  outsourcing-job.sh clean <jobDir>
`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeFileName(name) {
  const cleaned = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return cleaned || 'task';
}

function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function sleepMs(ms) {
  const msNum = Number(ms);
  if (!Number.isFinite(msNum) || msNum <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.trunc(msNum));
}

function toFiniteNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function isoDateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: String(date.getUTCDate()).padStart(2, '0'),
  };
}

function shiftIsoDay(value, dayDelta) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return date.toISOString();
}

function resolveSessionSearchRoots(sessionsRoot, startedAt) {
  if (!sessionsRoot) return [];
  if (!fs.existsSync(sessionsRoot)) return [];
  const stat = fs.statSync(sessionsRoot);
  if (stat.isFile()) return [sessionsRoot];
  const roots = [];
  const seen = new Set();
  const candidates = [startedAt, shiftIsoDay(startedAt, -1), shiftIsoDay(startedAt, 1)].filter(Boolean);
  for (const candidate of candidates) {
    const parts = isoDateParts(candidate);
    if (!parts) continue;
    const dailyDir = path.join(sessionsRoot, parts.year, parts.month, parts.day);
    if (fs.existsSync(dailyDir) && !seen.has(dailyDir)) {
      roots.push(dailyDir);
      seen.add(dailyDir);
    }
  }
  if (roots.length === 0 && !seen.has(sessionsRoot)) roots.push(sessionsRoot);
  return roots;
}

function resolveClaudeProjectsRoot() {
  return process.env.OUTSOURCING_CLAUDE_PROJECTS_DIR || path.join(process.env.HOME || '', '.claude', 'projects');
}

function encodeClaudeProjectDirName(cwd) {
  const value = String(cwd || '').trim();
  if (!value) return null;
  return `-${value.replace(/^\/+/, '').replace(/\//g, '-')}`;
}

function resolveClaudeProjectDir(cwd) {
  const root = resolveClaudeProjectsRoot();
  const encoded = encodeClaudeProjectDirName(cwd);
  if (!root || !encoded) return null;
  const projectDir = path.join(root, encoded);
  return fs.existsSync(projectDir) ? projectDir : null;
}

function listJsonlFilesRecursive(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) return rootPath.endsWith('.jsonl') ? [rootPath] : [];
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile() && nextPath.endsWith('.jsonl')) {
        files.push(nextPath);
      }
    }
  }
  return files;
}

function buildClaudeUsageTotals(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = toFiniteNumber(usage.input_tokens);
  const cacheCreate = toFiniteNumber(usage.cache_creation_input_tokens);
  const cacheRead = toFiniteNumber(usage.cache_read_input_tokens);
  const output = toFiniteNumber(usage.output_tokens);
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    cache_tokens: cacheCreate + cacheRead,
    input_plus_output_tokens: input + output,
    total_tokens: input + cacheCreate + cacheRead + output,
  };
}

function extractClaudeRowText(row) {
  const parts = [];
  if (row == null || typeof row !== 'object') return '';
  if (typeof row.content === 'string') parts.push(row.content);
  if (row.message) {
    if (typeof row.message.content === 'string') {
      parts.push(row.message.content);
    } else if (Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (!block || typeof block !== 'object') continue;
        if (typeof block.text === 'string') parts.push(block.text);
        if (typeof block.thinking === 'string') parts.push(block.thinking);
        if (typeof block.input === 'string') parts.push(block.input);
      }
    }
  }
  return parts.join('\n');
}

function readClaudeSessionUsageSnapshot(filePath, sinceTimestamp, nonce) {
  const snapshot = {
    filePath,
    sessionId: null,
    cwd: null,
    firstTimestamp: null,
    lastTimestamp: null,
    recordsAfterSince: 0,
    messageCount: 0,
    actual_usage: null,
    entries: [],
    nonceMatched: false,
  };
  const text = readTextIfExists(filePath);
  if (!text) return snapshot;

  const sinceMs = sinceTimestamp ? Date.parse(sinceTimestamp) : NaN;
  const nonceNeedle = String(nonce || '').trim();
  const finalMessages = new Map();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.sessionId && !snapshot.sessionId) snapshot.sessionId = parsed.sessionId;
    if (parsed.cwd && !snapshot.cwd) snapshot.cwd = parsed.cwd;
    if (nonceNeedle && !snapshot.nonceMatched) {
      const textValue = extractClaudeRowText(parsed);
      if (textValue.includes(nonceNeedle)) snapshot.nonceMatched = true;
    }
    const timestamp = parsed.timestamp || null;
    if (timestamp && !snapshot.firstTimestamp) snapshot.firstTimestamp = timestamp;
    if (timestamp) snapshot.lastTimestamp = timestamp;
    const message = parsed.message;
    if (!message || !message.usage || !message.id) continue;
    if (parsed.type !== 'assistant') continue;
    if (!Number.isNaN(sinceMs) && timestamp) {
      const tsMs = Date.parse(timestamp);
      if (!Number.isNaN(tsMs) && tsMs < sinceMs) continue;
    }
    finalMessages.set(String(message.id), {
      id: String(message.id),
      timestamp,
      stop_reason: message.stop_reason || null,
      usage: buildClaudeUsageTotals(message.usage),
    });
  }

  const entries = [...finalMessages.values()].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  snapshot.entries = entries;
  snapshot.recordsAfterSince = entries.length;
  snapshot.messageCount = entries.length;
  if (entries.length > 0) {
    snapshot.actual_usage = entries.reduce((sum, entry) => {
      const usage = entry.usage || {};
      sum.input_tokens += toFiniteNumber(usage.input_tokens);
      sum.cache_creation_input_tokens += toFiniteNumber(usage.cache_creation_input_tokens);
      sum.cache_read_input_tokens += toFiniteNumber(usage.cache_read_input_tokens);
      sum.cache_tokens += toFiniteNumber(usage.cache_tokens, toFiniteNumber(usage.cache_creation_input_tokens) + toFiniteNumber(usage.cache_read_input_tokens));
      sum.output_tokens += toFiniteNumber(usage.output_tokens);
      sum.input_plus_output_tokens += toFiniteNumber(usage.input_plus_output_tokens, toFiniteNumber(usage.input_tokens) + toFiniteNumber(usage.output_tokens));
      sum.total_tokens += toFiniteNumber(usage.total_tokens);
      return sum;
    }, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_tokens: 0,
      output_tokens: 0,
      input_plus_output_tokens: 0,
      total_tokens: 0,
    });
  }
  return snapshot;
}

function readSessionUsageSnapshot(filePath) {
  const snapshot = {
    filePath,
    sessionId: null,
    startedAt: null,
    startedAtMs: null,
    cwd: null,
    source: null,
    promptHints: '',
    actual_usage: null,
    last_usage: null,
    lastTokenTimestamp: null,
  };
  const hintParts = [];
  const text = readTextIfExists(filePath);
  if (!text) return snapshot;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === 'session_meta' && parsed.payload) {
      snapshot.sessionId = parsed.payload.id || snapshot.sessionId;
      snapshot.startedAt = parsed.payload.timestamp || parsed.timestamp || snapshot.startedAt;
      snapshot.startedAtMs = snapshot.startedAt ? Date.parse(snapshot.startedAt) : null;
      snapshot.cwd = parsed.payload.cwd || snapshot.cwd;
      snapshot.source = parsed.payload.source || snapshot.source;
      continue;
    }
    if (parsed.type === 'event_msg' && parsed.payload && parsed.payload.type === 'user_message' && parsed.payload.message) {
      if (hintParts.length < 3) hintParts.push(String(parsed.payload.message));
      continue;
    }
    if (parsed.type === 'event_msg' && parsed.payload && parsed.payload.type === 'token_count' && parsed.payload.info) {
      const total = parsed.payload.info.total_token_usage || parsed.payload.info.last_token_usage || null;
      const last = parsed.payload.info.last_token_usage || null;
      if (total) {
        snapshot.actual_usage = {
          input_tokens: toFiniteNumber(total.input_tokens),
          cached_input_tokens: toFiniteNumber(total.cached_input_tokens),
          output_tokens: toFiniteNumber(total.output_tokens),
          reasoning_output_tokens: toFiniteNumber(total.reasoning_output_tokens),
          total_tokens: toFiniteNumber(total.total_tokens, toFiniteNumber(total.input_tokens) + toFiniteNumber(total.output_tokens)),
        };
        snapshot.last_usage = last ? {
          input_tokens: toFiniteNumber(last.input_tokens),
          cached_input_tokens: toFiniteNumber(last.cached_input_tokens),
          output_tokens: toFiniteNumber(last.output_tokens),
          reasoning_output_tokens: toFiniteNumber(last.reasoning_output_tokens),
          total_tokens: toFiniteNumber(last.total_tokens, toFiniteNumber(last.input_tokens) + toFiniteNumber(last.output_tokens)),
        } : null;
        snapshot.lastTokenTimestamp = parsed.timestamp || snapshot.lastTokenTimestamp;
      }
    }
  }

  snapshot.promptHints = hintParts.join('\n');
  return snapshot;
}

function scoreObserverSessionSnapshot(snapshot, options) {
  let score = 0;
  if (options.cwd && snapshot.cwd === options.cwd) score += 50;
  if (options.member) {
    const taskNeedles = [
      `Task name: ${options.member}`,
      `[TASK ${options.member}]`,
      `"task_name":"${options.member}"`,
    ];
    if (taskNeedles.some((needle) => snapshot.promptHints.includes(needle))) score += 60;
  }
  if (options.reportPath && snapshot.promptHints.includes(options.reportPath)) score += 80;
  if (options.startedAt && snapshot.startedAtMs != null) {
    const startedAtMs = Date.parse(options.startedAt);
    if (!Number.isNaN(startedAtMs)) {
      const diffMs = Math.abs(snapshot.startedAtMs - startedAtMs);
      if (diffMs <= 10 * 60 * 1000) score += 30;
      else if (diffMs <= 60 * 60 * 1000) score += 10;
      else score -= 20;
    }
  }
  if (snapshot.actual_usage && snapshot.actual_usage.total_tokens > 0) score += 20;
  return score;
}

function matchObserverSessionFile(options) {
  const searchRoots = resolveSessionSearchRoots(options.sessionsRoot, options.startedAt);
  let best = null;
  for (const rootPath of searchRoots) {
    const files = listJsonlFilesRecursive(rootPath);
    for (const filePath of files) {
      const snapshot = readSessionUsageSnapshot(filePath);
      const score = scoreObserverSessionSnapshot(snapshot, options);
      if (!best || score > best.score || (score === best.score && String(snapshot.startedAt || '') > String(best.startedAt || ''))) {
        best = { ...snapshot, score };
      }
    }
  }
  if (!best || best.score < 80) return null;
  return best;
}

function matchClaudeSessionFile(options) {
  const projectDir = resolveClaudeProjectDir(options.cwd);
  if (!projectDir) return null;
  const files = listJsonlFilesRecursive(projectDir).sort();
  let best = null;
  for (const filePath of files) {
    const snapshot = readClaudeSessionUsageSnapshot(filePath, options.startedAt, options.nonce);
    if (options.nonce && !snapshot.nonceMatched) continue;
    if (!snapshot.actual_usage || snapshot.actual_usage.total_tokens <= 0) continue;
    let score = snapshot.recordsAfterSince * 100;
    if (snapshot.cwd === options.cwd) score += 50;
    if (snapshot.nonceMatched) score += 1000;
    if (snapshot.lastTimestamp && options.startedAt) {
      const diffMs = Math.abs(Date.parse(snapshot.lastTimestamp) - Date.parse(options.startedAt));
      if (Number.isFinite(diffMs)) {
        if (diffMs <= 10 * 60 * 1000) score += 30;
        else if (diffMs <= 60 * 60 * 1000) score += 10;
      }
    }
    if (!best || score > best.score || (score === best.score && String(snapshot.lastTimestamp || '') > String(best.lastTimestamp || ''))) {
      best = { ...snapshot, score };
    }
  }
  return best;
}

function collectWorkerTemplateTokens() {
  const templateParts = [
    readTextIfExists(path.join(SKILL_DIR, 'templates', 'worker-core.md')),
    readTextIfExists(path.join(SKILL_DIR, 'templates', 'report-format.md')),
    readTextIfExists(path.join(SKILL_DIR, 'templates', 'phase-openers.json')),
    readTextIfExists(path.join(SKILL_DIR, 'templates', 'report-rules.json')),
  ].filter(Boolean);
  return approxTokens(templateParts.join('\n'));
}

function hydrateClaudeUsage(jobDir, jobMeta) {
  if (!jobMeta || !jobMeta.createdAt || !jobMeta.cwd) return null;
  const usagePath = path.join(jobDir, 'claude-usage.json');
  const existing = readJsonIfExists(usagePath);
  const session = matchClaudeSessionFile({
    cwd: jobMeta.cwd,
    startedAt: jobMeta.createdAt,
    nonce: jobMeta.claudeSessionNonce,
  });
  if (!session || !session.actual_usage || toFiniteNumber(session.actual_usage.total_tokens) <= 0) {
    return existing || null;
  }
  const payload = {
    actual_usage: session.actual_usage,
    message_count: session.messageCount,
    measurement_source: 'claude_project_session_log',
    session_file: session.filePath,
    session_id: session.sessionId,
    session_started_at: session.firstTimestamp,
    session_last_timestamp: session.lastTimestamp,
    nonce_matched: Boolean(session.nonceMatched),
  };
  atomicWriteJson(usagePath, payload);
  return payload;
}

function hydrateObserverUsage(jobDir, jobMeta) {
  if (!jobMeta || !jobMeta.observer || !jobMeta.observer.enabled) return;
  const sessionsRoot = process.env.OUTSOURCING_CODEX_SESSIONS_DIR || path.join(process.env.HOME || '', '.codex', 'sessions');
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return;

  for (const task of jobMeta.tasks || []) {
    const memberDir = path.join(jobDir, 'members', task.safeName);
    if (!fs.existsSync(memberDir)) continue;
    const status = readJsonIfExists(path.join(memberDir, 'status.json'));
    if (!status || status.mode !== 'observer') continue;

    const usagePath = path.join(memberDir, 'usage.json');
    const existingUsage = readJsonIfExists(usagePath) || {};
    if (existingUsage.actual_usage && existingUsage.measurement_source === 'exec_json') continue;

    const session = matchObserverSessionFile({
      sessionsRoot,
      cwd: task.cwd,
      member: task.name,
      reportPath: path.join(memberDir, 'report.json'),
      startedAt: status.startedAt || jobMeta.createdAt,
    });
    if (!session || !session.actual_usage || toFiniteNumber(session.actual_usage.total_tokens) <= 0) continue;

    atomicWriteJson(usagePath, {
      ...existingUsage,
      actual_usage: session.actual_usage,
      actual_usage_last: session.last_usage || null,
      measurement_source: 'observer_session_log',
      session_file: session.filePath,
      session_id: session.sessionId,
      session_source: session.source,
      session_started_at: session.startedAt,
      session_last_token_timestamp: session.lastTokenTimestamp,
    });
  }
}

function resolveConfigPath(options) {
  return options.config || process.env.OUTSOURCING_CONFIG || CONFIG_FILE;
}

function loadYaml(configPath) {
  let YAML;
  try {
    YAML = require('yaml');
  } catch {
    exitWithError(
      [
        'Missing runtime dependency: yaml',
        `Install it with: cd ${SKILL_DIR} && npm install`,
      ].join('\n')
    );
  }
  try {
    return YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    exitWithError(`Invalid YAML in ${configPath}: ${error.message}`);
  }
}

function parseOutsourcingConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {
      outsourcing: {
        defaults: {
          command: DEFAULT_CODEX_COMMAND,
          observer_command: DEFAULT_OBSERVER_COMMAND,
          observer_mode: 'tmux',
          model: 'codex-5.4',
          max_worker_count: 6,
        },
        settings: {
          timeout: DEFAULT_TIMEOUT_SEC,
          max_retries: 2,
        min_parallel_tasks: 3,
        token_estimator: {
          claude_base_prompt_weight: 1,
          claude_payload_weight: 1,
          claude_result_review_weight: 1,
          claude_final_report_weight: 1,
          claude_retry_weight: 1,
          claude_solo_worker_transfer_ratio: 1,
          worker_prompt_overhead: 1.2,
        },
      },
        context: {
          reference_files: [],
        },
        tasks: [],
      },
    };
  }

  const parsed = loadYaml(configPath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.outsourcing) {
    exitWithError(`Invalid config: missing required top-level key 'outsourcing:'`);
  }
  const outsourcing = parsed.outsourcing;
  return {
    outsourcing: {
      defaults: {
        command: DEFAULT_CODEX_COMMAND,
        observer_command: DEFAULT_OBSERVER_COMMAND,
        observer_mode: 'tmux',
        model: 'codex-5.4',
        max_worker_count: 6,
        ...((outsourcing.defaults && typeof outsourcing.defaults === 'object') ? outsourcing.defaults : {}),
      },
      settings: {
        timeout: DEFAULT_TIMEOUT_SEC,
        max_retries: 2,
        min_parallel_tasks: 3,
        token_estimator: {
          claude_base_prompt_weight: 1,
          claude_payload_weight: 1,
          claude_result_review_weight: 1,
          claude_final_report_weight: 1,
          claude_retry_weight: 1,
          claude_solo_worker_transfer_ratio: 1,
          worker_prompt_overhead: 1.2,
          ...((outsourcing.settings && outsourcing.settings.token_estimator && typeof outsourcing.settings.token_estimator === 'object')
            ? outsourcing.settings.token_estimator
            : {}),
        },
        ...((outsourcing.settings && typeof outsourcing.settings === 'object') ? outsourcing.settings : {}),
      },
      context: {
        reference_files: [],
        ...((outsourcing.context && typeof outsourcing.context === 'object') ? outsourcing.context : {}),
      },
      tasks: Array.isArray(outsourcing.tasks) ? outsourcing.tasks : [],
    },
  };
}

function buildContextString(config, workingDir) {
  const contextConfig = config.outsourcing.context || {};
  const referenceFiles = Array.isArray(contextConfig.reference_files) ? contextConfig.reference_files : [];
  const parts = [];

  if (contextConfig.project) {
    parts.push(`# Project: ${contextConfig.project}`);
    if (contextConfig.description) parts.push(`> ${contextConfig.description}`);
    parts.push('');
  }

  if (referenceFiles.length > 0) {
    parts.push('## Reference Files');
    parts.push('');
    for (const relPath of referenceFiles) {
      const absPath = path.resolve(workingDir, relPath);
      if (!fs.existsSync(absPath)) {
        parts.push(`- Missing: ${relPath}`);
        continue;
      }
      const content = fs.readFileSync(absPath, 'utf8');
      parts.push(`### ${relPath}`);
      parts.push('```');
      parts.push(content.trim());
      parts.push('```');
      parts.push('');
    }
  }

  return parts.join('\n').trim();
}

function normalizeTask(task, config, workingDir) {
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  const name = String(task.name || payload.task_name || '').trim();
  if (!name) return null;
  const cwd = String(task.cwd || payload.working_dir || workingDir);
  const normalizedPayload = {
    task_name: name,
    worker_role: String(payload.worker_role || task.worker_role || `${name} outsourced implementation worker`),
    working_dir: cwd,
    task_background: Array.isArray(payload.task_background)
      ? payload.task_background.map(String)
      : Array.isArray(task.task_background)
        ? task.task_background.map(String)
        : [],
    requests: Array.isArray(payload.requests)
      ? payload.requests.map(String)
      : Array.isArray(task.requests)
        ? task.requests.map(String)
        : task.instruction
          ? [String(task.instruction).trim()]
          : [],
    targets: Array.isArray(payload.targets)
      ? payload.targets.map((item) => ({
          path: String(item.path || ''),
          purpose: String(item.purpose || ''),
        }))
      : Array.isArray(task.targets)
        ? task.targets.map((item) => ({
            path: String(item.path || ''),
            purpose: String(item.purpose || ''),
          }))
        : [],
    signatures: Array.isArray(payload.signatures)
      ? payload.signatures.map(String)
      : Array.isArray(task.signatures)
        ? task.signatures.map(String)
        : [],
    constraints: Array.isArray(payload.constraints)
      ? payload.constraints.map(String)
      : Array.isArray(task.constraints)
        ? task.constraints.map(String)
        : [],
    recommended_skills: Array.isArray(payload.recommended_skills)
      ? payload.recommended_skills.map(String)
      : Array.isArray(task.recommended_skills)
        ? task.recommended_skills.map(String)
        : [],
  };

  return {
    name,
    safeName: safeFileName(name),
    command: String(task.command || config.outsourcing.defaults.command || DEFAULT_CODEX_COMMAND),
    observerCommand: String(task.observer_command || config.outsourcing.defaults.observer_command || DEFAULT_OBSERVER_COMMAND),
    cwd,
    round: Number(task.round) || 1,
    gates: Array.isArray(task.gates)
      ? task.gates
          .map((gate) => ({
            name: String(gate.name || 'unnamed'),
            command: String(gate.command || ''),
          }))
          .filter((gate) => gate.command)
      : [],
    payload: normalizedPayload,
  };
}

function approxTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.max(1, Math.ceil(text.length / 4));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runTmux(args) {
  return execFileSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasTmux() {
  try {
    runTmux(['-V']);
    return true;
  } catch {
    return false;
  }
}

function createWorkerFiles(jobDir, task, basePrompt) {
  const memberDir = path.join(jobDir, 'members', task.safeName);
  ensureDir(memberDir);
  atomicWriteJson(path.join(memberDir, 'payload.json'), task.payload);
  fs.writeFileSync(path.join(memberDir, 'project-context.txt'), basePrompt, 'utf8');
  atomicWriteJson(path.join(memberDir, 'status.json'), {
    member: task.name,
    state: 'queued',
    queuedAt: new Date().toISOString(),
    round: task.round,
    command: task.command,
  });
}

function launchWorkerDetached(jobDir, task, timeoutSec) {
  const child = spawn(process.execPath, [
    WORKER_PATH,
    '--job-dir', jobDir,
    '--member', task.name,
    '--safe-member', task.safeName,
    '--command', task.command,
    '--observer-command', task.observerCommand,
    '--cwd', task.cwd,
    '--mode', 'exec',
    '--timeout', String(timeoutSec),
  ], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    cwd: task.cwd,
  });
  child.unref();
}

function launchObserverWorkers(jobDir, tasks, timeoutSec) {
  if (!hasTmux()) return null;
  const sessionSuffix = path.basename(jobDir).replace(/^outsourcing-/, '').replace(/[^a-zA-Z0-9]/g, '').slice(-12) || crypto.randomBytes(4).toString('hex');
  const session = `outsourcing-${sessionSuffix}`;
  let created = false;
  for (const task of tasks) {
    const command = [
      shellQuote(process.execPath),
      shellQuote(WORKER_PATH),
      '--job-dir', shellQuote(jobDir),
      '--member', shellQuote(task.name),
      '--safe-member', shellQuote(task.safeName),
      '--command', shellQuote(task.command),
      '--observer-command', shellQuote(task.observerCommand),
      '--cwd', shellQuote(task.cwd),
      '--mode', 'observer',
      '--timeout', shellQuote(String(timeoutSec)),
    ].join(' ');
    if (!created) {
      runTmux(['new-session', '-d', '-s', session, '-n', task.safeName, command]);
      try {
        runTmux(['set-option', '-t', session, 'remain-on-exit', 'on']);
      } catch {
        // ignore tmux option errors
      }
      try {
        runTmux(['select-pane', '-t', `${session}:0.0`, '-T', task.safeName]);
      } catch {
        // ignore pane title errors
      }
      created = true;
    } else {
      runTmux(['split-window', '-t', session, '-v', command]);
      runTmux(['select-layout', '-t', session, 'tiled']);
      try {
        runTmux(['select-pane', '-t', session, '-T', task.safeName]);
      } catch {
        // ignore pane title errors
      }
    }
  }
  return session;
}

function parseObserverBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    // Codex interactive mode may prepend various prefix chars (•, │, └, *, >, etc.)
    // Use indexOf to find [OUTSOURCING] regardless of leading decorators
    const outerIdx = line.indexOf('[OUTSOURCING]');
    const stripped = outerIdx >= 0 ? line.slice(outerIdx) : '';
    const headerMatch = stripped.match(/^\[OUTSOURCING\]\[TASK ([^\]]+)\]\[PHASE ([^\]]+)\]\[DONE\]$/);
    if (headerMatch) {
      current = {
        task: headerMatch[1],
        phase: headerMatch[2],
        lines: [stripped],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
      // Check for END marker (may have leading whitespace but no box-drawing chars in practice)
      if (line.trim() === '[OUTSOURCING][END]' || stripped === '[OUTSOURCING][END]') {
        blocks.push({
          task: current.task,
          phase: current.phase,
          memo: current.lines.join('\n').trim(),
        });
        current = null;
      }
    }
  }
  return blocks;
}

function getEffectiveMemberState(member) {
  const rawState = String(member && member.state ? member.state : 'unknown');
  const observedPhase = member && member.observed ? String(member.observed.phase || '') : '';
  if (rawState === 'running' && observedPhase === 'final') return 'done';
  return rawState;
}

function captureObserverState(jobMeta) {
  if (!jobMeta || !jobMeta.observer || !jobMeta.observer.enabled || !jobMeta.observer.session || !hasTmux()) {
    return {};
  }
  try {
    const paneLines = runTmux(['list-panes', '-t', jobMeta.observer.session, '-F', '#{pane_id}']);
    const state = {};
    for (const paneId of paneLines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      const captured = runTmux(['capture-pane', '-p', '-t', paneId, '-S', '-1000']);
      for (const block of parseObserverBlocks(captured)) {
        state[block.task] = {
          phase: block.phase,
          memo: block.memo,
        };
      }
    }
    return state;
  } catch {
    return {};
  }
}

function computeStatusPayload(jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (!jobMeta) exitWithError('job.json not found');
  hydrateObserverUsage(resolvedJobDir, jobMeta);
  const membersRoot = path.join(resolvedJobDir, 'members');
  if (!fs.existsSync(membersRoot)) exitWithError('members folder not found');

  const observerState = captureObserverState(jobMeta);
  const members = [];
  for (const entry of fs.readdirSync(membersRoot)) {
    const status = readJsonIfExists(path.join(membersRoot, entry, 'status.json'));
    if (status) {
      const observed = observerState[String(status.member || '')] || null;
      members.push({ safeName: entry, observed, ...status, effectiveState: getEffectiveMemberState({ observed, ...status }) });
    }
  }

  const counts = { queued: 0, running: 0, done: 0, error: 0, missing_cli: 0, timed_out: 0, canceled: 0 };
  for (const member of members) {
    const state = String(member.effectiveState || member.state || 'unknown');
    if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state]++;
  }
  const overallState = counts.running === 0 && counts.queued === 0 ? 'done' : counts.running > 0 ? 'running' : 'queued';
  return {
    jobDir: resolvedJobDir,
    id: jobMeta.id,
    overallState,
    counts: {
      total: members.length,
      ...counts,
    },
    observer: jobMeta.observer || null,
    members: members
      .map((member) => ({
        member: member.member,
        state: member.effectiveState || member.state,
        rawState: member.state,
        startedAt: member.startedAt || null,
        finishedAt: member.finishedAt || null,
        exitCode: member.exitCode != null ? member.exitCode : null,
        message: member.message || null,
        observedPhase: member.observed ? member.observed.phase : null,
        observedMemo: member.observed ? member.observed.memo : null,
      }))
      .sort((a, b) => String(a.member).localeCompare(String(b.member))),
  };
}

function buildEffectiveStateMap(jobDir) {
  const payload = computeStatusPayload(jobDir);
  const map = new Map();
  for (const member of payload.members) {
    map.set(String(member.member || ''), member);
  }
  return map;
}

function cmdStart(options, prompt) {
  const configPath = resolveConfigPath(options);
  const jobsDir = options['jobs-dir'] || process.env.OUTSOURCING_JOBS_DIR || path.join(SKILL_DIR, '.jobs');
  ensureDir(jobsDir);

  const config = parseOutsourcingConfig(configPath);
  const workingDir = options.cwd || process.env.OUTSOURCING_CWD || process.cwd();
  const basePrompt = [buildContextString(config, workingDir), String(prompt || '').trim()].filter(Boolean).join('\n\n');
  const timeoutSec = Number(options.timeout || config.outsourcing.settings.timeout || DEFAULT_TIMEOUT_SEC);

  const tasks = (config.outsourcing.tasks || [])
    .map((task) => normalizeTask(task, config, workingDir))
    .filter(Boolean);
  if (tasks.length === 0) exitWithError('outsourcing: tasks are empty in outsourcing.config.yaml');

  const maxRound = tasks.reduce((max, task) => Math.max(max, task.round), 1);
  const currentRound = Number(options.round || 1);
  const roundTasks = tasks.filter((task) => task.round === currentRound);
  if (roundTasks.length === 0) exitWithError(`outsourcing: no tasks for round ${currentRound}`);

  const observerRequested = options['no-observer'] ? false : options.observer ? true : config.outsourcing.defaults.observer_mode === 'tmux';
  const claudeSessionNonce = String(options['claude-session-nonce'] || '').trim() || null;
  const jobId = `${new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(jobsDir, `outsourcing-${jobId}`);
  ensureDir(path.join(jobDir, 'members'));

  const jobMeta = {
    id: `outsourcing-${jobId}`,
    createdAt: new Date().toISOString(),
    configPath,
    cwd: workingDir,
    maxRound,
    currentRound,
    prompt,
    claudeSessionNonce,
    settings: {
      timeoutSec,
      maxRetries: Number(config.outsourcing.settings.max_retries || config.outsourcing.settings.maxRetries || 2),
      tokenEstimator: config.outsourcing.settings.token_estimator || {},
    },
    observer: {
      enabled: Boolean(observerRequested),
      mode: observerRequested ? 'tmux' : 'headless',
      session: null,
    },
    tasks: tasks.map((task) => ({
      name: task.name,
      safeName: task.safeName,
      cwd: task.cwd,
      round: task.round,
      command: task.command,
      observerCommand: task.observerCommand,
      gates: task.gates,
      payload: task.payload,
    })),
  };

  atomicWriteJson(path.join(jobDir, 'job.json'), jobMeta);
  fs.writeFileSync(path.join(jobDir, 'prompt.txt'), basePrompt, 'utf8');

  for (const task of roundTasks) {
    createWorkerFiles(jobDir, task, basePrompt);
  }

  let observerSession = null;
  if (observerRequested) {
    observerSession = launchObserverWorkers(jobDir, roundTasks, timeoutSec);
  }

  if (!observerSession) {
    for (const task of roundTasks) {
      launchWorkerDetached(jobDir, task, timeoutSec);
    }
  } else {
    jobMeta.observer.session = observerSession;
    atomicWriteJson(path.join(jobDir, 'job.json'), jobMeta);
  }

  fs.writeFileSync(path.join(jobsDir, '.last-job'), jobDir, 'utf8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ jobDir, ...jobMeta }, null, 2)}\n`);
  } else {
    process.stdout.write(`${jobDir}\n`);
  }
}

function cmdStatus(options, jobDir) {
  const payload = computeStatusPayload(jobDir);
  if (options.checklist && !options.json) {
    process.stdout.write(`outsourcing status (${payload.id})\n`);
    process.stdout.write(`Completed ${payload.counts.done + payload.counts.error + payload.counts.timed_out + payload.counts.canceled + payload.counts.missing_cli}/${payload.counts.total}\n`);
    for (const member of payload.members) {
      const mark = member.state === 'done' ? '[x]' : member.state === 'running' || member.state === 'queued' ? '[ ]' : '[!]';
      process.stdout.write(`${mark} ${member.member} - ${member.state}\n`);
    }
    return;
  }
  if (options.text && !options.json) {
    process.stdout.write(`tasks ${payload.counts.done}/${payload.counts.total} done; running=${payload.counts.running} queued=${payload.counts.queued}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseWaitCursor(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  return {
    done: Number(parts[1]),
    running: Number(parts[2]),
    queued: Number(parts[3]),
  };
}

function formatWaitCursor(payload) {
  return `v1:${payload.counts.done}:${payload.counts.running}:${payload.counts.queued}`;
}

function cmdWait(options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const cursorFilePath = path.join(resolvedJobDir, '.wait_cursor');
  const prevCursorRaw = options.cursor != null
    ? String(options.cursor)
    : fs.existsSync(cursorFilePath)
      ? fs.readFileSync(cursorFilePath, 'utf8').trim()
      : '';
  const prevCursor = parseWaitCursor(prevCursorRaw);
  const intervalMs = Math.max(50, Math.trunc(Number(options['interval-ms'] || 250)));
  const timeoutMs = Math.trunc(Number(options['timeout-ms'] || 0));

  let payload = computeStatusPayload(resolvedJobDir);
  let cursor = formatWaitCursor(payload);
  if (!prevCursor) {
    fs.writeFileSync(cursorFilePath, cursor, 'utf8');
    process.stdout.write(`${JSON.stringify({ ...payload, cursor }, null, 2)}\n`);
    return;
  }

  const start = Date.now();
  while (cursor === prevCursorRaw) {
    if (timeoutMs > 0 && Date.now() - start >= timeoutMs) break;
    sleepMs(intervalMs);
    payload = computeStatusPayload(resolvedJobDir);
    cursor = formatWaitCursor(payload);
    if (cursor !== prevCursorRaw) {
      fs.writeFileSync(cursorFilePath, cursor, 'utf8');
      process.stdout.write(`${JSON.stringify({ ...payload, cursor }, null, 2)}\n`);
      return;
    }
  }

  fs.writeFileSync(cursorFilePath, cursor, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...payload, cursor }, null, 2)}\n`);
}

function cmdGates(options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (!jobMeta) exitWithError('gates: job.json not found');
  const effectiveStateMap = buildEffectiveStateMap(resolvedJobDir);
  const results = {};

  for (const task of jobMeta.tasks || []) {
    const memberDir = path.join(resolvedJobDir, 'members', task.safeName);
    const status = readJsonIfExists(path.join(memberDir, 'status.json'));
    const effective = effectiveStateMap.get(task.name);
    const effectiveState = effective ? effective.state : (status ? status.state : 'unknown');
    if (!status || effectiveState !== 'done') {
      results[task.name] = { status: 'skipped', gates: [], reason: `task state: ${effectiveState}` };
      continue;
    }
    const gateResults = [];
    let allPassed = true;
    for (const gate of task.gates || []) {
      const startedAt = Date.now();
      try {
        const output = execFileSync('bash', ['-lc', gate.command], {
          cwd: task.cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        });
        gateResults.push({
          name: gate.name,
          command: gate.command,
          passed: true,
          output: output.trim().slice(0, 500),
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        allPassed = false;
        gateResults.push({
          name: gate.name,
          command: gate.command,
          passed: false,
          error: String((error.stderr || error.message || 'unknown error')).trim().slice(0, 500),
          durationMs: Date.now() - startedAt,
        });
      }
    }
    const payload = {
      status: allPassed ? 'passed' : 'failed',
      passedCount: gateResults.filter((item) => item.passed).length,
      totalCount: gateResults.length,
      gates: gateResults,
    };
    atomicWriteJson(path.join(memberDir, 'gates.json'), payload);
    results[task.name] = payload;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const [taskName, result] of Object.entries(results)) {
    const label = result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
    process.stdout.write(`${label} ${taskName}: ${result.status}\n`);
  }
}

function estimateTokenMetrics(jobDir, jobMeta, taskReports) {
  const estimator = (jobMeta.settings && jobMeta.settings.tokenEstimator) || {};
  const workerPromptOverhead = toFiniteNumber(estimator.worker_prompt_overhead, 1.2);
  const basePromptWeight = toFiniteNumber(estimator.claude_base_prompt_weight, 1);
  const payloadWeight = toFiniteNumber(estimator.claude_payload_weight, 1);
  const resultReviewWeight = toFiniteNumber(estimator.claude_result_review_weight, 1);
  const finalReportWeight = toFiniteNumber(estimator.claude_final_report_weight, 1);
  const retryWeight = toFiniteNumber(estimator.claude_retry_weight, 1);
  const transferRatio = toFiniteNumber(estimator.claude_solo_worker_transfer_ratio, 1);
  const basePrompt = readTextIfExists(path.join(jobDir, 'prompt.txt'));
  const taskPayloadTokens = (jobMeta.tasks || []).reduce((sum, task) => sum + approxTokens(task.payload), 0);
  const workerPromptTokens = (jobMeta.tasks || []).reduce((sum, task) => {
    const promptFile = path.join(jobDir, 'members', task.safeName, 'assembled-prompt.txt');
    const promptText = readTextIfExists(promptFile);
    return sum + approxTokens(promptText || task.payload);
  }, 0);
  const workerOutputTokens = taskReports.reduce((sum, report) => {
    return sum + approxTokens(report.report || '') + approxTokens(report.output || '');
  }, 0);
  const retryTokens = taskReports.reduce((sum, report) => {
    const correctionPath = path.join(jobDir, 'members', safeFileName(report.taskName), 'correction.txt');
    return sum + approxTokens(readTextIfExists(correctionPath));
  }, 0);
  const resultReviewTokens = taskReports.reduce((sum, report) => {
    const gateSummary = report.gates ? `${report.gates.status}:${report.gates.passedCount || 0}/${report.gates.totalCount || 0}` : '';
    return sum + approxTokens(report.summary || '') + approxTokens(report.risks || '') + approxTokens(gateSummary);
  }, 0);
  const finalSynthesisTokens = approxTokens(taskReports.map((report) => `${report.taskName}:${report.summary}`).join('\n')) + 40;
  const workerActualTokens = taskReports.reduce((sum, report) => {
    const actual = report.usage && report.usage.actual_usage ? Number(report.usage.actual_usage.total_tokens || 0) : 0;
    return sum + (Number.isFinite(actual) ? actual : 0);
  }, 0);
  const hasWorkerActualUsage = taskReports.some((report) => {
    return Boolean(report.usage && report.usage.actual_usage && Number(report.usage.actual_usage.total_tokens || 0) > 0);
  });
  const claudeOutsourcingTokens = Math.ceil(
    (approxTokens(basePrompt) * basePromptWeight) +
    (taskPayloadTokens * payloadWeight) +
    (resultReviewTokens * resultReviewWeight) +
    (finalSynthesisTokens * finalReportWeight) +
    (retryTokens * retryWeight)
  );
  const claudeUsage = hydrateClaudeUsage(jobDir, jobMeta);
  const claudeActualTokens = claudeUsage && claudeUsage.actual_usage
    ? Number(claudeUsage.actual_usage.input_plus_output_tokens || 0)
    : 0;
  const claudeCacheTokens = claudeUsage && claudeUsage.actual_usage
    ? Number(claudeUsage.actual_usage.cache_tokens || 0)
    : 0;
  const claudeCacheCreationTokens = claudeUsage && claudeUsage.actual_usage
    ? Number(claudeUsage.actual_usage.cache_creation_input_tokens || 0)
    : 0;
  const claudeCacheReadTokens = claudeUsage && claudeUsage.actual_usage
    ? Number(claudeUsage.actual_usage.cache_read_input_tokens || 0)
    : 0;
  const hasClaudeActualUsage = Number.isFinite(claudeActualTokens) && claudeActualTokens > 0;
  const codexWorkerTokensEstimated = Math.ceil((workerPromptTokens + workerOutputTokens) * workerPromptOverhead);
  const codexWorkerTokens = hasWorkerActualUsage ? workerActualTokens : codexWorkerTokensEstimated;
  const workerBurdenForSolo = hasWorkerActualUsage
    ? Math.min(workerActualTokens, codexWorkerTokensEstimated)
    : codexWorkerTokensEstimated;
  const shiftedImplementationTokens = Math.max(0, Math.ceil(workerBurdenForSolo * Math.max(0, transferRatio)));
  const claudeOutsourcingEffectiveTokens = hasClaudeActualUsage ? claudeActualTokens : claudeOutsourcingTokens;
  const claudeSoloEstimatedTokens = Math.ceil(Math.max(
    claudeOutsourcingTokens + shiftedImplementationTokens,
    claudeOutsourcingEffectiveTokens + shiftedImplementationTokens
  ));
  const claudeOutsourcingErrorRate = hasClaudeActualUsage && claudeActualTokens > 0
    ? Number((((claudeOutsourcingTokens - claudeActualTokens) / claudeActualTokens) * 100).toFixed(2))
    : null;
  const estimationErrorRate = hasWorkerActualUsage && workerActualTokens > 0
    ? Number((((codexWorkerTokensEstimated - workerActualTokens) / workerActualTokens) * 100).toFixed(2))
    : null;
  const savingsRate = claudeSoloEstimatedTokens <= 0
    ? 0
    : Number((((claudeSoloEstimatedTokens - claudeOutsourcingEffectiveTokens) / claudeSoloEstimatedTokens) * 100).toFixed(2));
  return {
    claude_solo_estimated_tokens: claudeSoloEstimatedTokens,
    claude_outsourcing_tokens: claudeOutsourcingEffectiveTokens,
    claude_outsourcing_tokens_estimated: claudeOutsourcingTokens,
    claude_outsourcing_tokens_actual: hasClaudeActualUsage ? claudeActualTokens : null,
    claude_cache_tokens: hasClaudeActualUsage ? claudeCacheTokens : null,
    claude_cache_creation_tokens: hasClaudeActualUsage ? claudeCacheCreationTokens : null,
    claude_cache_read_tokens: hasClaudeActualUsage ? claudeCacheReadTokens : null,
    claude_outsourcing_estimation_error_rate: claudeOutsourcingErrorRate == null ? 'N/A' : `${claudeOutsourcingErrorRate}%`,
    claude_outsourcing_measurement_mode: hasClaudeActualUsage ? 'actual' : 'estimated',
    claude_token_savings_rate: `${savingsRate}%`,
    codex_worker_tokens: codexWorkerTokens,
    codex_worker_tokens_estimated: codexWorkerTokensEstimated,
    codex_worker_tokens_actual: hasWorkerActualUsage ? workerActualTokens : null,
    codex_worker_estimation_error_rate: estimationErrorRate == null ? 'N/A' : `${estimationErrorRate}%`,
    codex_worker_measurement_mode: hasWorkerActualUsage ? (taskReports.every((report) => report.usage && report.usage.actual_usage) ? 'actual' : 'mixed') : 'estimated',
    claude_estimation_basis: 'artifact_heuristic_capped_by_worker_estimate',
  };
}

function normalizeSummary(report, fallbackState) {
  if (!report || !report.summary) return `state=${fallbackState}`;
  let text = String(report.summary);
  if (text.includes('[OUTSOURCING][')) {
    text = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('[OUTSOURCING]'))
      .filter((line) => line !== 'End of report.')
      .filter((line) => !/^(Assigned worker|Requested work|Task background and reason|Work performed|Deliverables|Checks|Risks and handoff notes):$/.test(line))
      .join(' ');
  }
  text = text.replace(/\/Users\/[^\s]+/g, '[path omitted]');
  text = text.replace(/\[[^\]]+\]\([^)]+\)/g, '[link omitted]');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return `state=${fallbackState}`;
  if (text.length > 160) return `${text.slice(0, 157)}...`;
  return text;
}

function displayMetric(value) {
  return value == null || value === '' ? 'N/A' : String(value);
}

function renderFinalReport(jobMeta, taskReports, tokenMetrics) {
  const template = readTextIfExists(path.join(SKILL_DIR, 'templates', 'final-report.md'));
  const taskSummaries = taskReports.map((item) => `- ${item.taskName}: ${item.summary}`).join('\n') || '- None';
  const retrySummary = taskReports
    .filter((item) => item.retryCount > 0)
    .map((item) => `- ${item.taskName}: ${item.retryCount} retry attempt(s)`)
    .join('\n') || '- No retries';
  const riskSummary = taskReports
    .map((item) => item.risks)
    .filter(Boolean)
    .map((risk) => `- ${risk}`)
    .join('\n') || '- No notable risks';

  return template
    .replace('{{task_summaries}}', taskSummaries)
    .replace('{{retry_summary}}', retrySummary)
    .replace('{{claude_solo_estimated_tokens}}', displayMetric(tokenMetrics.claude_solo_estimated_tokens))
    .replace('{{claude_outsourcing_tokens}}', displayMetric(tokenMetrics.claude_outsourcing_tokens))
    .replace('{{claude_outsourcing_tokens_estimated}}', displayMetric(tokenMetrics.claude_outsourcing_tokens_estimated))
    .replace('{{claude_outsourcing_tokens_actual}}', displayMetric(tokenMetrics.claude_outsourcing_tokens_actual))
    .replace('{{claude_cache_tokens}}', displayMetric(tokenMetrics.claude_cache_tokens))
    .replace('{{claude_cache_creation_tokens}}', displayMetric(tokenMetrics.claude_cache_creation_tokens))
    .replace('{{claude_cache_read_tokens}}', displayMetric(tokenMetrics.claude_cache_read_tokens))
    .replace('{{claude_outsourcing_estimation_error_rate}}', displayMetric(tokenMetrics.claude_outsourcing_estimation_error_rate))
    .replace('{{claude_outsourcing_measurement_mode}}', displayMetric(tokenMetrics.claude_outsourcing_measurement_mode))
    .replace('{{claude_token_savings_rate}}', displayMetric(tokenMetrics.claude_token_savings_rate))
    .replace('{{codex_worker_tokens}}', displayMetric(tokenMetrics.codex_worker_tokens))
    .replace('{{codex_worker_tokens_estimated}}', displayMetric(tokenMetrics.codex_worker_tokens_estimated))
    .replace('{{codex_worker_tokens_actual}}', displayMetric(tokenMetrics.codex_worker_tokens_actual))
    .replace('{{codex_worker_estimation_error_rate}}', displayMetric(tokenMetrics.codex_worker_estimation_error_rate))
    .replace('{{codex_worker_measurement_mode}}', displayMetric(tokenMetrics.codex_worker_measurement_mode))
    .replace('{{risk_summary}}', riskSummary);
}

function cmdResults(options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (!jobMeta) exitWithError('results: job.json not found');
  hydrateObserverUsage(resolvedJobDir, jobMeta);
  const effectiveStateMap = buildEffectiveStateMap(resolvedJobDir);
  const taskReports = [];

  for (const task of jobMeta.tasks || []) {
    const memberDir = path.join(resolvedJobDir, 'members', task.safeName);
    const status = readJsonIfExists(path.join(memberDir, 'status.json'));
    const report = readJsonIfExists(path.join(memberDir, 'report.json'));
    const usage = readJsonIfExists(path.join(memberDir, 'usage.json'));
    const output = readTextIfExists(path.join(memberDir, 'output.txt'));
    const gates = readJsonIfExists(path.join(memberDir, 'gates.json'));
    const retryCount = Number(readTextIfExists(path.join(memberDir, 'retry_count')).trim() || '0') || 0;
    const effective = effectiveStateMap.get(task.name);
    const effectiveState = effective ? effective.state : (status ? status.state : 'unknown');
    taskReports.push({
      taskName: task.name,
      status: effectiveState,
      rawState: status ? status.state : 'unknown',
      summary: normalizeSummary(report, effectiveState),
      risks: report && report.risks ? report.risks : '',
      report,
      output,
      gates,
      retryCount,
      usage,
    });
  }

  const tokenMetrics = estimateTokenMetrics(resolvedJobDir, jobMeta, taskReports);
  const finalJson = {
    job_id: jobMeta.id,
    status: taskReports.every((item) => item.status === 'done') ? 'success' : taskReports.some((item) => item.status === 'done') ? 'partial' : 'failed',
    task_summaries: taskReports.map((item) => ({
      task_name: item.taskName,
      status: item.status,
      summary: item.summary,
      gates: item.gates ? item.gates.status : null,
    })),
    retry_history: taskReports.filter((item) => item.retryCount > 0).map((item) => ({
      task_name: item.taskName,
      retry_count: item.retryCount,
    })),
    risks: taskReports.map((item) => item.risks).filter(Boolean),
    ...tokenMetrics,
  };
  atomicWriteJson(path.join(resolvedJobDir, 'final-report.json'), finalJson);
  fs.writeFileSync(path.join(resolvedJobDir, 'final-report.md'), renderFinalReport(jobMeta, taskReports, tokenMetrics), 'utf8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify(finalJson, null, 2)}\n`);
    return;
  }

  process.stdout.write(`outsourcing results (${jobMeta.id})\n`);
  for (const item of taskReports) {
    process.stdout.write(`- ${item.taskName}: ${item.status} - ${item.summary}\n`);
  }
  process.stdout.write(`- Claude Code solo estimate: ${displayMetric(tokenMetrics.claude_solo_estimated_tokens)}\n`);
  process.stdout.write(`- Claude Code outsourcing tokens: ${displayMetric(tokenMetrics.claude_outsourcing_tokens)}\n`);
  process.stdout.write(`- Claude Code outsourcing estimate: ${displayMetric(tokenMetrics.claude_outsourcing_tokens_estimated)}\n`);
  process.stdout.write(`- Claude Code outsourcing actual: ${displayMetric(tokenMetrics.claude_outsourcing_tokens_actual)}\n`);
  process.stdout.write(`- Claude cache tokens: ${displayMetric(tokenMetrics.claude_cache_tokens)}\n`);
  process.stdout.write(`- Claude cache creation tokens: ${displayMetric(tokenMetrics.claude_cache_creation_tokens)}\n`);
  process.stdout.write(`- Claude cache read tokens: ${displayMetric(tokenMetrics.claude_cache_read_tokens)}\n`);
  process.stdout.write(`- Claude Code outsourcing estimation error: ${displayMetric(tokenMetrics.claude_outsourcing_estimation_error_rate)}\n`);
  process.stdout.write(`- Claude Code measurement mode: ${displayMetric(tokenMetrics.claude_outsourcing_measurement_mode)}\n`);
  process.stdout.write(`- Claude Code token savings rate: ${displayMetric(tokenMetrics.claude_token_savings_rate)}\n`);
  process.stdout.write(`- Codex Worker tokens: ${displayMetric(tokenMetrics.codex_worker_tokens)}\n`);
  process.stdout.write(`- Codex Worker estimated tokens: ${displayMetric(tokenMetrics.codex_worker_tokens_estimated)}\n`);
  process.stdout.write(`- Codex Worker actual tokens: ${displayMetric(tokenMetrics.codex_worker_tokens_actual)}\n`);
  process.stdout.write(`- Codex Worker estimation error: ${displayMetric(tokenMetrics.codex_worker_estimation_error_rate)}\n`);
  process.stdout.write(`- Codex Worker measurement mode: ${displayMetric(tokenMetrics.codex_worker_measurement_mode)}\n`);
}

function relaunchTask(jobDir, jobMeta, task, correction) {
  const memberDir = path.join(jobDir, 'members', task.safeName);
  const retryCountPath = path.join(memberDir, 'retry_count');
  const currentRetryCount = Number(readTextIfExists(retryCountPath).trim() || '0') || 0;
  fs.writeFileSync(retryCountPath, String(currentRetryCount + 1), 'utf8');
  if (correction) fs.writeFileSync(path.join(memberDir, 'correction.txt'), correction, 'utf8');
  atomicWriteJson(path.join(memberDir, 'status.json'), {
    member: task.name,
    state: 'queued',
    queuedAt: new Date().toISOString(),
    command: task.command,
    retry: currentRetryCount + 1,
  });

  const timeoutSec = Number(jobMeta.settings.timeoutSec || DEFAULT_TIMEOUT_SEC);
  if (jobMeta.observer && jobMeta.observer.enabled && jobMeta.observer.session && hasTmux()) {
    const command = [
      shellQuote(process.execPath),
      shellQuote(WORKER_PATH),
      '--job-dir', shellQuote(jobDir),
      '--member', shellQuote(task.name),
      '--safe-member', shellQuote(task.safeName),
      '--command', shellQuote(task.command),
      '--observer-command', shellQuote(task.observerCommand || DEFAULT_OBSERVER_COMMAND),
      '--cwd', shellQuote(task.cwd),
      '--mode', 'observer',
      '--timeout', shellQuote(String(timeoutSec)),
    ].join(' ');
    runTmux(['split-window', '-t', jobMeta.observer.session, '-v', command]);
    runTmux(['select-layout', '-t', jobMeta.observer.session, 'tiled']);
    return;
  }
  launchWorkerDetached(jobDir, {
    name: task.name,
    safeName: task.safeName,
    command: task.command,
    observerCommand: task.observerCommand || DEFAULT_OBSERVER_COMMAND,
    cwd: task.cwd,
  }, timeoutSec);
}

function cmdRedelegate(options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (!jobMeta) exitWithError('redelegate: job.json not found');
  const taskName = options.task || options._[0];
  if (!taskName) exitWithError('redelegate: --task <name> is required');

  const task = (jobMeta.tasks || []).find((item) => item.name === taskName);
  if (!task) exitWithError(`redelegate: task "${taskName}" not found`);
  const correction = options.correction || options._[1] || '';
  relaunchTask(resolvedJobDir, jobMeta, task, correction);
  process.stdout.write(`${JSON.stringify({ task: taskName, status: 'redelegated' }, null, 2)}\n`);
}

function cmdAutofix(_options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (!jobMeta) exitWithError('autofix: job.json not found');
  const maxRetries = Number(jobMeta.settings.maxRetries || 2);
  const restarted = [];

  for (const task of jobMeta.tasks || []) {
    const memberDir = path.join(resolvedJobDir, 'members', task.safeName);
    const status = readJsonIfExists(path.join(memberDir, 'status.json'));
    const gates = readJsonIfExists(path.join(memberDir, 'gates.json'));
    const retryCount = Number(readTextIfExists(path.join(memberDir, 'retry_count')).trim() || '0') || 0;
    if (retryCount >= maxRetries) continue;

    let correction = '';
    if (status && ['error', 'timed_out', 'missing_cli'].includes(status.state)) {
      correction = `The previous attempt ended with state=${status.state}. Identify the cause and re-implement within the same scope.`;
    }
    if (!correction && gates && gates.status === 'failed') {
      const failed = (gates.gates || []).filter((item) => !item.passed).map((item) => item.name);
      correction = `Fix the following failed gates: ${failed.join(', ')}`;
    }
    if (!correction) continue;
    relaunchTask(resolvedJobDir, jobMeta, task, correction);
    restarted.push({ task: task.name, correction });
  }

  process.stdout.write(`${JSON.stringify({ status: restarted.length ? 'autofix_started' : 'no_fixes_needed', tasks: restarted }, null, 2)}\n`);
}

function killProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
}

function cmdStop(_options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  const membersRoot = path.join(resolvedJobDir, 'members');
  if (!fs.existsSync(membersRoot)) exitWithError('stop: members folder not found');
  for (const entry of fs.readdirSync(membersRoot)) {
    const status = readJsonIfExists(path.join(membersRoot, entry, 'status.json'));
    if (status && status.pid) killProcess(Number(status.pid));
  }
  if (jobMeta && jobMeta.observer && jobMeta.observer.session && hasTmux()) {
    try {
      runTmux(['kill-session', '-t', jobMeta.observer.session]);
    } catch {
      // ignore
    }
  }
  process.stdout.write('stopped\n');
}

function cmdClean(_options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (jobMeta && jobMeta.observer && jobMeta.observer.session && hasTmux()) {
    try {
      runTmux(['kill-session', '-t', jobMeta.observer.session]);
    } catch {
      // ignore
    }
  }
  fs.rmSync(resolvedJobDir, { recursive: true, force: true });
  process.stdout.write(`cleaned: ${resolvedJobDir}\n`);
}

function cmdStartRound(options, jobDir) {
  const resolvedJobDir = path.resolve(jobDir);
  const jobMeta = readJsonIfExists(path.join(resolvedJobDir, 'job.json'));
  if (!jobMeta) exitWithError('start-round: job.json not found');
  const roundNum = Number(options.round || options._[0]);
  if (!Number.isFinite(roundNum) || roundNum < 1) exitWithError('start-round: --round is required');

  jobMeta.currentRound = roundNum;
  atomicWriteJson(path.join(resolvedJobDir, 'job.json'), jobMeta);
  const basePrompt = readTextIfExists(path.join(resolvedJobDir, 'prompt.txt'));
  const tasks = (jobMeta.tasks || []).filter((task) => Number(task.round || 1) === roundNum);
  if (tasks.length === 0) exitWithError(`start-round: no tasks for round ${roundNum}`);
  for (const task of tasks) {
    createWorkerFiles(resolvedJobDir, task, basePrompt);
  }
  if (jobMeta.observer && jobMeta.observer.enabled) {
    const session = jobMeta.observer.session || launchObserverWorkers(resolvedJobDir, tasks, Number(jobMeta.settings.timeoutSec || DEFAULT_TIMEOUT_SEC));
    jobMeta.observer.session = session;
    atomicWriteJson(path.join(resolvedJobDir, 'job.json'), jobMeta);
  } else {
    for (const task of tasks) {
      launchWorkerDetached(resolvedJobDir, task, Number(jobMeta.settings.timeoutSec || DEFAULT_TIMEOUT_SEC));
    }
  }
  process.stdout.write(`${resolvedJobDir}\n`);
}

function cmdRunAll(options, prompt) {
  cmdStart(options, prompt);
  const jobsDir = options['jobs-dir'] || process.env.OUTSOURCING_JOBS_DIR || path.join(SKILL_DIR, '.jobs');
  const jobDir = fs.readFileSync(path.join(jobsDir, '.last-job'), 'utf8').trim();
  const jobMeta = readJsonIfExists(path.join(jobDir, 'job.json'));
  const maxRound = Number(jobMeta.maxRound || 1);
  for (let round = 1; round <= maxRound; round++) {
    if (round > 1) cmdStartRound({ round: String(round), _: [] }, jobDir);
    while (true) {
      const payload = computeStatusPayload(jobDir);
      if (payload.overallState === 'done') break;
      sleepMs(500);
    }
    try { cmdGates({}, jobDir); } catch { /* ignore */ }
  }
  cmdResults({}, jobDir);
}

function resolveJobDir(options, arg) {
  if (arg) return arg;
  const jobsDir = options['jobs-dir'] || process.env.OUTSOURCING_JOBS_DIR || path.join(SKILL_DIR, '.jobs');
  const lastJobFile = path.join(jobsDir, '.last-job');
  if (fs.existsSync(lastJobFile)) return fs.readFileSync(lastJobFile, 'utf8').trim();
  return null;
}

function main() {
  const options = parseArgs(process.argv);
  const [command, ...rest] = options._;
  if (!command || options.help || options.h) {
    printHelp();
    return;
  }

  if (command === 'start') {
    const prompt = rest.join(' ').trim();
    if (!prompt) exitWithError('start: project context is required');
    cmdStart(options, prompt);
    return;
  }
  if (command === 'run-all') {
    const prompt = rest.join(' ').trim();
    if (!prompt) exitWithError('run-all: project context is required');
    cmdRunAll(options, prompt);
    return;
  }
  if (command === 'start-round') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('start-round: jobDir is required');
    cmdStartRound(options, jobDir);
    return;
  }
  if (command === 'status') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('status: jobDir is required');
    cmdStatus(options, jobDir);
    return;
  }
  if (command === 'wait') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('wait: jobDir is required');
    cmdWait(options, jobDir);
    return;
  }
  if (command === 'results') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('results: jobDir is required');
    cmdResults(options, jobDir);
    return;
  }
  if (command === 'gates') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('gates: jobDir is required');
    cmdGates(options, jobDir);
    return;
  }
  if (command === 'redelegate') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('redelegate: jobDir is required');
    cmdRedelegate(options, jobDir);
    return;
  }
  if (command === 'autofix') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('autofix: jobDir is required');
    cmdAutofix(options, jobDir);
    return;
  }
  if (command === 'stop') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('stop: jobDir is required');
    cmdStop(options, jobDir);
    return;
  }
  if (command === 'clean') {
    const jobDir = resolveJobDir(options, rest[0]);
    if (!jobDir) exitWithError('clean: jobDir is required');
    cmdClean(options, jobDir);
    return;
  }

  exitWithError(`Unknown command: ${command}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  readClaudeSessionUsageSnapshot,
  matchClaudeSessionFile,
  readSessionUsageSnapshot,
  matchObserverSessionFile,
  estimateTokenMetrics,
  parseObserverBlocks,
  getEffectiveMemberState,
};
