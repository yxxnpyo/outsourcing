#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/hongyp/Desktop/hongyp/dev/codex/outsourcing/plugin/test-fixtures/practical-smoke-workspace"

rm -f "$ROOT/src/utils/truncateText.ts"
rm -f "$ROOT/src/utils/clampNumber.ts"
rm -f "$ROOT/src/utils/formatIsoDate.ts"
rm -rf "/Users/hongyp/Desktop/hongyp/dev/codex/outsourcing/plugin/skills/outsourcing/.jobs"
