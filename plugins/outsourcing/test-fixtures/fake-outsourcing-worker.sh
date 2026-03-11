#!/usr/bin/env bash
set -euo pipefail

OUT_FILE=""
PROMPT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --output-schema)
      shift 2
      ;;
    -o|--output-last-message)
      OUT_FILE="$2"
      shift 2
      ;;
    *)
      PROMPT="$1"
      shift
      ;;
  esac
done

cat <<'REPORT'
[OUTSOURCING][TASK sample-task][PHASE planning][DONE]
Reporting task kickoff completion.

Assigned worker:
- sample-task outsourced implementation worker

Requested work:
- Print a planning phase report for observer validation

Task background and reason:
- This task validates the observer marker parsing path.

Work performed:
- Printed the planning phase memo block.

Deliverables:
- planning marker output

Checks:
- Kept the marker format intact.

Risks and handoff notes:
- None.

End of report.
[OUTSOURCING][END]
REPORT

sleep 1

cat <<'REPORT'
[OUTSOURCING][TASK sample-task][PHASE implementation][DONE]
Reporting implementation completion.

Assigned worker:
- sample-task outsourced implementation worker

Requested work:
- Print an implementation phase report for observer validation

Task background and reason:
- This task verifies that observer state updates on phase transitions.

Work performed:
- Printed the implementation phase memo block.

Deliverables:
- implementation marker output

Checks:
- The implementation marker appears after the planning marker.

Risks and handoff notes:
- None.

End of report.
[OUTSOURCING][END]
REPORT

if [ -n "$OUT_FILE" ]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  cat > "$OUT_FILE" <<JSON
{
  "files_created": ["mock.txt"],
  "files_modified": [],
  "status": "success",
  "summary": "The fake observer worker emitted planning and implementation markers for observer validation.",
  "signatures": ["export function sample(): void"],
  "dependencies_used": [],
  "risks": "none",
  "token_notes": ["prompt_length=${#PROMPT}"]
}
JSON
fi
