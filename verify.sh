#!/usr/bin/env bash
# Kiểm chứng dsh-jev-gate — luật #4 của AGENTS.md: thứ bắt buộc đúng phải có
# lệnh kiểm được. Exit 1 nếu có mục hỏng.
#
# Tự phát hiện vị trí plugin (không hardcode $HOME/.dsh/plugins/dsh-jev-gate)
# để chạy được ở bất kỳ máy nào, kể cả khi cài qua `dsh plugin add`.
set -uo pipefail

PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

echo "0. Vị trí plugin"
echo "   $PLUGIN"

echo "1. Cấu trúc plugin"
for f in package.json cordis.patch.yml lib/index.mjs lib/jev-client.mjs lib/policy.mjs README.md CHANGELOG.md; do
  [ -f "$PLUGIN/$f" ] && pass "$f" || fail "thiếu $f"
done

echo "2. Syntax"
for f in lib/index.mjs lib/jev-client.mjs lib/policy.mjs; do
  if node --check "$PLUGIN/$f" 2>/dev/null; then pass "$f"; else fail "$f lỗi syntax"; fi
done

echo "3. Dependency resolve (nguyên nhân lỗi 'failed to import' trước đây)"
if [ -d "$PLUGIN/node_modules/@deepseek-ai/schemastery" ]; then
  pass "schemastery đã cài trong plugin"
else
  fail "thiếu schemastery — chạy: cd $PLUGIN && npm install"
fi
if node -e "import('$PLUGIN/lib/index.mjs').then(m=>process.exit(m.apply&&m.Config?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  pass "module nạp được, export apply + Config"
else
  fail "module không nạp được"
fi

echo "4. Đăng ký trong profile"
if timeout 60 dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "dsh-jev-gate"; then
  pass "có trong composition (profile $PROFILE)"
else
  fail "chưa đăng ký — chạy: dsh plugin --profile $PROFILE add $PLUGIN"
fi

echo "5. Boot thật (xem log apply, không đọc file config)"
LOG="${XDG_DATA_HOME:-$HOME/.local/share}/dsh-jev-gate/decisions.jsonl"
if [ -f "$LOG" ] && grep -q '"type":"boot"' "$LOG" 2>/dev/null; then
  pass "plugin đã apply: $(grep '"type":"boot"' "$LOG" | tail -1 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("model="+d["model"])' 2>/dev/null)"
else
  fail "chưa thấy log boot — khởi động lại DSH"
fi

echo "6. Jev API thật (case đã biết đáp án)"
if node "$PLUGIN/tests/live-check.mjs" 2>/dev/null; then
  pass "gate chấm đúng trên API thật"
else
  fail "live check thất bại (kiểm TYPESAFE_API_KEY và mạng)"
fi

echo
[ $FAIL -eq 0 ] && echo "TẤT CẢ MỤC PASS" || echo "CÓ MỤC HỎNG"
exit $FAIL
