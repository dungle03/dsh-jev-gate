#!/usr/bin/env bash
# Nạp lại jev-gate v0.9.0 vào dsh web.
#
# Vì sao cần: Node giữ module trong bộ nhớ; process `dsh web` đang chạy đã nạp
# code TRƯỚC đợt merge (boot 16:20, code mới 16:35). Không có supervisor và
# plugin không có file-watcher, nên chỉ restart mới nạp được code mới.
#
# Cách dùng — chạy từ terminal THẬT (không phải trong dsh):
#   bash ~/.dsh/plugins/dsh-jev-gate/restart-web.sh
set -u

PID="$(pgrep -f 'dsh web$' | head -1)"
if [ -z "$PID" ]; then
  echo "[restart] không thấy process 'dsh web' đang chạy — chỉ cần chạy: dsh web"
  exit 0
fi

CWD="$(readlink /proc/$PID/cwd 2>/dev/null || echo "$HOME")"
echo "[restart] dsh web PID=$PID, cwd=$CWD"

# Nếu chạy từ TRONG dsh (dsh là tổ tiên của shell này), kill thẳng sẽ tự sát
# shell. Dùng systemd-run ở scope độc lập để helper sống sót và khởi động lại dsh.
is_descendant_of() {
  local target="$1" cur="$PPID"
  for _ in $(seq 1 20); do
    [ -z "$cur" ] || [ "$cur" = "0" ] && break
    [ "$cur" = "$target" ] && return 0
    cur="$(awk '{print $4}' "/proc/$cur/stat" 2>/dev/null)"
  done
  return 1
}

if is_descendant_of "$PID"; then
  echo "[restart] phát hiện đang chạy trong dsh → dùng helper scope độc lập"
  exec systemd-run --user --scope --collect bash -c "
    kill $PID 2>/dev/null
    for _ in \$(seq 1 20); do kill -0 $PID 2>/dev/null || break; sleep 0.5; done
    kill -9 $PID 2>/dev/null
    sleep 1
    cd '$CWD' && nohup dsh web >/tmp/dsh-web-restart.log 2>&1 &
    sleep 3
    pgrep -f 'dsh web\$' | head -1
  "
fi

# Chạy từ terminal thật: kill + khởi động lại trực tiếp.
echo "[restart] đang dừng PID=$PID ..."
kill "$PID"
for _ in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  echo "[restart] chưa thoát, gửi SIGKILL"
  kill -9 "$PID" 2>/dev/null
  sleep 1
fi

echo "[restart] khởi động lại từ $CWD ..."
cd "$CWD" || cd "$HOME"
nohup dsh web >/tmp/dsh-web-restart.log 2>&1 &
sleep 3
NEWPID="$(pgrep -f 'dsh web$' | head -1)"
if [ -n "$NEWPID" ]; then
  echo "[restart] OK — dsh web mới PID=$NEWPID (log: /tmp/dsh-web-restart.log)"
  echo "[restart] jev-gate v0.9.0 đã được nạp."
else
  echo "[restart] CẢNH BÁO: không thấy process mới. Xem /tmp/dsh-web-restart.log"
  exit 1
fi
