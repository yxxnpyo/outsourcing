# practical smoke workspace

This workspace exists only for real Codex delegation tests of the `outsourcing` plugin.

Expected outputs:
- `src/utils/truncateText.ts`
- `src/utils/clampNumber.ts`
- `src/utils/formatIsoDate.ts`

These files are intentionally small and independent so Claude Code can validate:
- single-task observer behavior
- three-task parallel delegation
- gate execution
- final token metric reporting
