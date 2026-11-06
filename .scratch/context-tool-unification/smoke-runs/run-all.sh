#!/usr/bin/env bash
# 跑全部 smoke 脚本,逐个记录退出码与输出。用法: bash run-all.sh <输出子目录> [脚本名...]
# 需要 CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD:safe-delete 垫片按「一次 rm 的目标数」限额,
# 这些 smoke 每个都会整目录清掉自己的临时 store(60~100 个条目),默认 50 挡在清理那一步。
set -u
cd "$(dirname "$0")/../../.." || exit 1
out="$1"; shift
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
