#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_SCRIPT="$SCRIPT_DIR/outsourcing-job.sh"

usage() {
  cat <<EOF
outsourcing - Claude PM / Codex outsourced workers

Usage:
  $(basename "$0") start [options] "project context"
  $(basename "$0") status [--json|--text|--checklist] <jobDir>
  $(basename "$0") wait [--cursor CURSOR] [--timeout-ms N] <jobDir>
  $(basename "$0") results [--json] <jobDir>
  $(basename "$0") stop <jobDir>
  $(basename "$0") clean <jobDir>

One-shot:
  $(basename "$0") "project context"

Before running: edit outsourcing.config.yaml with your task list.
EOF
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

case "$1" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required." >&2
  exit 127
fi

case "$1" in
  run-all)
    shift
    exec node "$SCRIPT_DIR/outsourcing-job.js" run-all "$@"
    ;;
  start|start-round|status|wait|results|stop|clean|gates|redelegate|autofix)
    exec "$JOB_SCRIPT" "$@"
    ;;
esac

JOB_DIR="$("$JOB_SCRIPT" start "$@")"
echo "$JOB_DIR"

while true; do
  WAIT_JSON="$("$JOB_SCRIPT" wait "$JOB_DIR")"
  OVERALL="$(printf '%s' "$WAIT_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(d.overallState||""));')"
  "$JOB_SCRIPT" status --text "$JOB_DIR" >&2
  if [ "$OVERALL" = "done" ]; then
    break
  fi
done

"$JOB_SCRIPT" gates "$JOB_DIR" >&2 || true
"$JOB_SCRIPT" results "$JOB_DIR"
