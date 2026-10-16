# Phase 0: kiểm tra sơ bộ từ log vận hành

Snapshot đọc-only ngày 2026-10-15 từ `~/.local/share/dsh-jev-gate/decisions.jsonl`. Lệnh tái lập: đọc từng dòng JSON, nhóm theo `type` và `decision`; bỏ dòng JSON không hợp lệ. Tổng 1.241 records, từ 2026-10-15T09:05:33.989Z đến 2026-10-15T10:34:11.007Z.

| Loại | Tổng | Phân bố |
| --- | ---: | --- |
| `completion_check` | 4 | `continue`: 2, `accept`: 2 |
| `quality_review` | 4 | `skip_continued`: 2, `reviewed`: 2 |
| `effort_route` | 220 | `applied`: 14, `sticky`: 206 |
| `failure_recovery` | 12 | `fail_open`: 2, `hinted`: 10 |

Đây mới là thống kê event, không phải tỷ lệ đúng/sai. Cần nối session trace, task, wall-clock và nhãn độc lập theo `phase-0-baseline.md` trước khi kết luận. Số lượng thay đổi theo thời gian; script Phase 0 cần lưu snapshot/fingerprint để tái lập.

Trạng thái dispatch: profile web đã sửa `allowedModels` sang route thật — `nine-router/cx/gpt-6-luna[1m]` (text-only) và `modlens-nine-router/cx/gpt-6-luna[1m]` (qua vision bridge) — thay cho chuỗi sai `cx/gpt6-luna`; đồng thời mở `modlens.families: ['*']` nên wrapper vision phủ hết 18 model đã khai ở provider `nine-router`. Route đã resolve được trong phiên đang chạy (không cần restart, HMR nạp lại patch). Session cũ vẫn giữ policy đóng băng theo session nên chỉ thấy 2 route cũ; mở session mới để nhận allowlist đầy đủ. Có thể giao Phase 0 cho Luna A.
