#!/usr/bin/env bash
# 同一套 smoke,但在另一个树里跑(基线工作树)。用法: bash run-all-at.sh <仓库根> <输出子目录>
set -u
root="$1"
out="$2"
shift 2
cd "$root" || exit 1
mkdir -p "$out"
if [ "$#" -eq 0 ]; then
  set -- $(ls scripts/smoke-*.ts)
fi
export CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=100000
: > "$out/summary.txt"
for f in "$@"; do
  name=$(basename "$f" .ts)
  start=$(date +%s)
  node "$f" > "$out/$name.log" 2>&1
  code=$?
  end=$(date +%s)
  printf '%-32s exit=%d  %ss\n' "$name" "$code" "$((end-start))" | tee -a "$out/summary.txt"
done
echo "--- 总计 ---"
echo "绿: $(grep -c 'exit=0' "$out/summary.txt")"
echo "红:"
grep -v 'exit=0' "$out/summary.txt" || echo "(无)"
