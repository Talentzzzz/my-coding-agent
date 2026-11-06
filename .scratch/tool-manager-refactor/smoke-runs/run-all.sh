#!/usr/bin/env bash
# Baseline / after-change smoke runner for the ToolManager refactor.
# Usage: bash run-all.sh <output-dir> [script ...]
# One node process per script, serial, every stdout/stderr captured to <output-dir>/<name>.log.
# No server is started: smoke-api is expected to be red in this pass.
set -u
cd "$(dirname "$0")/../../.." || exit 1
out="$1"; shift
mkdir -p "$out"
# Host safe-delete shim caps "targets in one rm"; each smoke wipes its own scratch store.
export CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=100000
if [ "$#" -eq 0 ]; then
	set -- $(ls scripts/smoke-*.ts | sort)
fi
: > "$out/summary.txt"
for f in "$@"; do
	name=$(basename "$f" .ts)
	start=$(date +%s)
	node "$f" > "$out/$name.log" 2>&1
	code=$?
	end=$(date +%s)
	printf '%-32s exit=%d  %ss\n' "$name" "$code" "$((end-start))" | tee -a "$out/summary.txt"
done
echo "--- total ---"
echo "green: $(grep -c 'exit=0' "$out/summary.txt")"
echo "red:"
grep -v 'exit=0' "$out/summary.txt" || echo "(none)"
