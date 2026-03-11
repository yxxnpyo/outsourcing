#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [key, rawValue] = a.split('=', 2);
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
  process.stdout.write(`outsourcing observer

Usage:
  outsourcing-observer.js start --session <name> --title <title> --command <cmd>
  outsourcing-observer.js split --session <name> --title <title> --command <cmd>
  outsourcing-observer.js capture --session <name> --pane <pane>
  outsourcing-observer.js list --session <name>
  outsourcing-observer.js kill --session <name>
`);
}

function hasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runTmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function startSession(session, title, command) {
  runTmux(['new-session', '-d', '-s', session, '-n', title, command]);
  process.stdout.write(`${session}:0.0\n`);
}

function splitPane(session, title, command) {
  const paneId = runTmux(['split-window', '-P', '-t', session, '-v', '-c', process.cwd(), command]).trim();
  try {
    runTmux(['select-layout', '-t', session, 'tiled']);
    runTmux(['select-pane', '-t', paneId, '-T', title]);
  } catch {
    // ignore layout/title errors
  }
  process.stdout.write(`${paneId}\n`);
}

function capturePane(session, pane) {
  const target = pane || `${session}:`;
  const output = runTmux(['capture-pane', '-p', '-t', target, '-S', '-200']);
  process.stdout.write(output);
}

function listPanes(session) {
  const output = runTmux(['list-panes', '-t', session, '-F', '#{pane_id}\t#{pane_title}\t#{pane_current_command}']);
  process.stdout.write(output);
}

function killSession(session) {
  runTmux(['kill-session', '-t', session]);
  process.stdout.write(`${session}\n`);
}

function main() {
  const options = parseArgs(process.argv);
  const [command] = options._;

  if (!command || options.help || options.h) {
    printHelp();
    return;
  }

  if (!hasTmux()) {
    process.stderr.write('tmux not found\n');
    process.exit(2);
  }

  const session = options.session;
  if (!session) {
    process.stderr.write('--session is required\n');
    process.exit(1);
  }

  if (command === 'start') {
    if (!options.title || !options.command) {
      process.stderr.write('--title and --command are required\n');
      process.exit(1);
    }
    startSession(session, options.title, options.command);
    return;
  }

  if (command === 'split') {
    if (!options.title || !options.command) {
      process.stderr.write('--title and --command are required\n');
      process.exit(1);
    }
    splitPane(session, options.title, options.command);
    return;
  }

  if (command === 'capture') {
    capturePane(session, options.pane);
    return;
  }

  if (command === 'list') {
    listPanes(session);
    return;
  }

  if (command === 'kill') {
    killSession(session);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}
