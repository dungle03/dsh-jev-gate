# Changelog

Theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
và [Semantic Versioning](https://semver.org/lang/vi/).

## [Unreleased]

### Thêm

- **LỚP 1b — quyền của user** (`tools/pre-execute`, chạy chỉ khi lớp 1 đã kết luận
  lệnh phá dữ liệu). Hỏi Jev một câu `choice` 4 nhánh: user có tự tay yêu cầu xoá
  đúng thứ này không? Chặn chỉ khi hội đủ **phá dữ liệu VÀ không được user yêu
  cầu**. Config: `enableAuthorizationOverride` (mặc định bật),
  `authorizationTimeoutMs` (4000).

  Lý do: gate cũ không phân biệt được rác session với dữ liệu thật. Log thật cho
  thấy `rm -rf /tmp/gtest` — thư mục test do chính session tạo — bị chặn ở p=0.77,
  trong khi `rm -rf <path không tồn tại>` chỉ 0.40; một lệnh dọn rác hợp lệ bị
  chặn **7 lần liên tiếp**, và cách lách duy nhất còn lại là đổi sang
  `find -delete` (cũng bị chặn).

  Vì sao `choice` 4 nhánh (`authorized`/`narrower`/`unrelated`/`quoted`) chứ
  không `noul`: đã đo bản `noul` — cần chỉnh ngưỡng, và vẫn hở trước nội dung dán
  vào (nhờ dịch/tóm tắt một câu chứa `rm -rf` cho ra 0.75–0.93 "đã được phép").
  Bốn nhánh là bốn tình huống khác nhau về bản chất, nên không phải chọn ngưỡng,
  và nhánh `quoted` chặn được injection.

  Số đo trên API thật (`jev-1.13.0`, 6–10 lần/case):
  - Nội dung dán vào tự nhận quyền: **0/66** ra `authorized`.
  - Lệnh nguy hiểm không được yêu cầu (không liên quan, mơ hồ, mở rộng phạm vi):
    **0/48** ra `authorized`.
  - Dọn dẹp hợp lệ user yêu cầu: **46/48** ra `authorized`.
  - Handler thật + Jev thật, 12 case end-to-end: **12/12** đúng.
  - Lớp 1 giữ nguyên hiệu chuẩn cũ **10/10 nguy hiểm, 10/10 an toàn** (bằng chứng:
    câu hỏi lớp 1 dùng đúng state cũ, không thêm trường).

  Lớp này **fail-closed** (khác lớp 1 fail-open): hỏi lỗi/timeout thì giữ chặn —
  lỗi của Jev không được biến thành "cho qua". Đã kiểm: lỗi đọc session vẫn deny.

### Sửa

- README (cả hai bản): "bốn lớp" → **năm lớp**; thêm LỚP 1b vào bảng, cây kiến
  trúc và luồng một lượt; sửa số test thật (offline 35 check, live-check 15 check);
  thay `spawnThreshold` bằng `approachConfidenceThreshold` trong ví dụ config;
  thêm `enableAuthorizationOverride` + `authorizationTimeoutMs`; bổ sung số đo
  lớp 1b vào bảng "Số đo đã kiểm".

- **`notePrompt` lọc tin nhắn thật của user.** Trước đây gộp MỌI message
  `role=user` — kể cả `runtime-context`, `skill-catalog`, `agent-instructions`,
  `tool-jobs` (output job nền), và gợi ý do chính plugin chèn (`source:
  'jev-gate'`). Nghĩa là output tool có thể lọt vào trường "yêu cầu của user".
  Giờ chỉ nhận `source.kind === 'user'`; không nhận diện được thì coi là không
  phải user (thà bỏ sót còn hơn nhận nhầm).

- `collectUserRequest` lấy 3 tin nhắn user thật gần nhất (mỗi tin cắt 600 ký tự)
  làm bằng chứng cho lớp 1b — đủ cho ngữ cảnh "ok làm đi" nối tiếp yêu cầu trước,
  mà không nhồi cả hội thoại.

- Thông báo deny đổi cho đúng sự thật: bản cũ hứa "reissue it with an explicit
  justification", nhưng plugin **không có kênh nào đọc justification** —
  `rawCommandOf` chỉ lấy `args.command`. Giờ thông báo nói đúng việc cần làm:
  xin user xác nhận đúng target đó rồi chạy lại.

### Đổi

- **LỚP 4: từ `noul` "có nên spawn không?" → `choice` "hướng nào tối ưu?".**
  Lý do là một lỗ hổng đo được: với câu hỏi nhị phân, khi đáp án là "không" thì
  plugin IM LẶNG — model không nhận gì, kể cả thông tin hữu ích. Task scan ổ đĩa
  của user nhận p=0.21 → im lặng, trong khi đúng ra nên nói "dùng một lệnh duy
  nhất" (đo thật: 1 lệnh `du` mất 357ms; 4 subagent tốn 8–20s overhead).

  Bốn hướng: `one-command-scan`, `scripted-analysis`, `parallel-workers`,
  `guided-interview`. Đo 10 case đã biết đáp án: 9/10 chọn đúng.

  Config: `spawnThreshold` (0.6) → `approachConfidenceThreshold` (0.3).
  Ngưỡng chỉ là lưới an toàn: đo được conf KHÔNG tương quan với đúng/sai
  (case đúng có conf từ 0.24; case sai có conf 0.44), nên ngưỡng 0.3 thay vì
  0.5 vốn chặn oan case scan ổ đĩa đúng (conf 0.42–0.48, sd=0.021).

  Log: `type: approach_hint`, `decision: hinted | silent_low_confidence | fail_open`.

### Sửa

- README: sửa "ba lớp/ba chốt chặn" thành **bốn** ở cả hai bản; thêm LỚP 4 vào
  cây kiến trúc và luồng một lượt; sửa `verify.sh` (6 mục, không phải 6/6), số
  test thật (offline 35 check, live-check 15 check); sửa mục "Điều KHÔNG làm"
  (trước ghi "không chọn tool" trong khi LỚP 4 gợi ý dùng tool `subagent`);
  bổ sung `spawnThreshold`/`spawnTimeoutMs`/`enableSpawnHint` vào ví dụ config;
  làm rõ số đo bounded state (1.500/700/900 ký tự, 6 tool result).

### Thêm

- `assets/architecture.png` + `assets/architecture.html` + `assets/architecture.json`
  — sơ đồ kiến trúc tương tác, dựng bằng Archify, validate showcase 9/9 artifact
  check, 0 lỗi 0 cảnh báo, containment pass ở 1440×900 / 1600×1000 / 1920×1080 /
  2048×1320.

### Thêm

- **Lớp 4 — Gợi ý spawn subagent** (`agent/pre-step`, chỉ step 1): hỏi Jev
  "task này có nhiều phần ĐỘC LẬP không?". Nếu có (p ≥ 0.6), chèn một gợi ý
  nhẹ để model cân nhắc dùng tool `subagent`. Mặc định bật; tắt bằng
  `enableSpawnHint: false`.

  Giới hạn cứng: API `agent` của DSH chỉ phơi `steer()`/`followup()`/`send()`,
  không có cách gọi tool trực tiếp. Nên plugin **chỉ gợi ý**, model tự quyết —
  không đảm bảo 100% spawn.

  Đo trên 9 case: task tuần tự 0.02–0.17, task độc lập 0.74–0.94 (9/9 đúng).
  Test LỚP 4: 7/7 pass (chèn đúng, im lặng đúng, guard step 1, không chèn lặp,
  tắt được bằng config, fail-open khi Jev lỗi).

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
