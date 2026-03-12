#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$PLUGIN_ROOT/plugins/outsourcing"

ARGS=(
  -a
  --delete
  --omit-dir-times
  --exclude
  ".claude"
  --exclude
  ".git"
  --exclude
  ".claude-plugin/marketplace.json"
  --exclude
  "plugins"
  --exclude
  ".DS_Store"
  --exclude
  "node_modules"
  --exclude
  "skills/outsourcing/.jobs"
)

if [[ "${1:-}" == "--check" ]]; then
  OUTPUT="$(rsync -ani "${ARGS[@]}" "$PLUGIN_ROOT/" "$DEST_DIR/")"
  if [[ -n "$OUTPUT" ]]; then
    printf '%s\n' "$OUTPUT"
    echo "Marketplace copy is out of sync."
    exit 1
  fi
  echo "Marketplace copy is in sync."
  exit 0
fi

mkdir -p "$DEST_DIR"
rsync "${ARGS[@]}" "$PLUGIN_ROOT/" "$DEST_DIR/"
echo "Synced marketplace copy to $DEST_DIR"
