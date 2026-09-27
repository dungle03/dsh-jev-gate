# Changelog

Theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
và [Semantic Versioning](https://semver.org/lang/vi/).

## [Unreleased]

## [0.1.0] — 2026-09-27

Bản đầu tiên. Ba lớp gate, mỗi lớp fail-open tuyệt đối.

### Thêm

- **Lớp 1 — Gate phá dữ liệu** (`tools/pre-execute`): chặn lệnh phá dữ liệu
  không thể khôi phục bằng câu hỏi `noul` của Jev. Ngưỡng 0.7. Có `prepend`
  để chạy trước handler khác trên cùng hook.
- **Lớp 2 — Kiểm hoàn thành** (`agent/turn-stopping`): hỏi Jev 3 câu gộp
  (`complete`, `evidence`, `needs_execution`) khi model định dừng. Nếu goal
  cần thi hành mà chỉ có lời khai, đẩy tiếp bằng `agent.steer`.
- **Lớp 3 — Chọn reasoning effort** (`agent/request`): hỏi Jev 2 câu gộp
  (`effort`, `lease`) theo độ khó của **bước kế tiếp**, rồi ghi
  `reasoningEffort` — không bao giờ đổi `provider`/`model`.
- Cấu hình qua `Config` (schemastery) với mọi ngưỡng và timeout tách riêng.
- Log quyết định ra `~/.local/share/dsh-jev-gate/decisions.jsonl` (mode 0600).
- `verify.sh`: 6 mục kiểm, tự phát hiện vị trí plugin, exit 1 nếu hỏng.
- `tests/offline.mjs`: kiểm không cần secret — fail-open, bất biến model,
  chỉ gate tool shell, hợp đồng export.
- `tests/live-check.mjs`: kiểm với Jev API thật, case đã biết đáp án.
- GitHub Actions: job `offline` (mọi push/PR, Node 20 + 22) và job `live`
  (chỉ chạy khi có `TYPESAFE_API_KEY`).

### Nguyên tắc thiết kế

- **Fail-open tuyệt đối.** Jev lỗi, chậm, hay trả rác → hành động đi tiếp.
- **Pin model** `jev-1.13.0`, không dùng alias `jev-latest`.
- **Ngưỡng theo hậu quả**, không dùng một số chung cho mọi lớp.
- **Bounded state**: chỉ goal, 6 tool result gần nhất, câu trả lời cuối.

### Kiểm chứng ở bản này

| Phép đo | Kết quả |
|---|---|
| 5 test case end-to-end (handler thật + Jev thật) | 9/9 pass, tái lập 3 lần |
| Gate phá dữ liệu trên 20 lệnh thực tế | 20/20 (recall 100%, precision 100%) |
| Deny có chặn thi hành thật | có — canary còn nguyên sau `rm -rf` bị deny |
| Fail-open (mất key / store hỏng / llm vắng) | 3/3 pass |
| Effort sang số theo độ khó | `low→low→high→low→high` qua 5 bước |
| Model có bị đổi | không — bất biến qua mọi test |
| Độ trễ mỗi gate | median ~250ms |

### Giới hạn đã biết

- **Lease gần như luôn = 1.** Jev trả `lease=1` ở hầu hết trường hợp, nên
  không tái sử dụng quyết định — Jev bị gọi mỗi generation (~250ms). Không
  gây sai, chỉ tốn thời gian. Quyết định không sửa ở bản này.
- **Gate mờ với path không tồn tại.** Jev chấm theo tính thực tế của path;
  với path trông giả/không tồn tại, điểm tụt về 0.4–0.6 và dao động, có thể
  không vượt ngưỡng. Rủi ro thấp (path chưa tồn tại thì xoá cũng không mất gì).
- **Lớp 3 mặc định bật.** Nếu thấy chi phí tăng bất thường, đặt
  `enableEffortRouting: false`.
