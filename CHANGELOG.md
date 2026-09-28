# Changelog

Theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
và [Semantic Versioning](https://semver.org/lang/vi/).

## [0.3.2]

### Sửa

- **Prompt Lớp 5 bỏ sót artifact cùng loại.** Khi task tạo/thêm thứ mới (migration,
  tài liệu, handler, script), Jev trả 0 cho file anh em đã có trong cùng thư mục —
  dù file đó định nghĩa format và số thứ tự mà artifact mới phải khớp. Đo được:
  `src/db/migrations/0012.sql` cho task "thêm migration" chỉ **0.39** (ngưỡng 0.6),
  `docs/onboarding.md` cho task "viết tài liệu onboarding" chỉ **0.34**.

  Thêm nhánh (b) vào câu hỏi: file cần đọc khi "task creates or adds an artifact of
  the SAME KIND IN THE SAME PLACE", kèm câu chặn hiểu nhầm "a document the task is
  writing is itself the file to read, not merely orientation" và câu chặn nới quá
  rộng "sharing a directory or a file extension with the task is not enough on its
  own". Sau khi sửa: migration **0.39 → 0.87**, onboarding **0.34 → 0.65**.

  Kiểm định ba bộ độc lập (5 lần/case): gốc 3/5 → **5/5**, held-out 7/8 → **8/8**,
  đối kháng 6/6. False-positive **0** trên cả ba bộ.

### Đổi

- **Prompt Lớp 5 dài hơn ~1.4k token vào mỗi request pre-step** (7.6KB → 13.2KB
  cho 8 ứng viên, +74%). Đây là giá của nhánh (b). Đáng đổi vì Lớp 5 gộp chung
  request với Lớp 4 nên chỉ trả thêm một lần mỗi turn, không phải mỗi file.

## [0.3.1]

### Sửa

- **`source` của message chèn sai định dạng session v4 → làm hỏng log session.**
  Cả ba chỗ chèn message (`agent/pre-step`, `additionalContexts` của Lớp 1, và
  `agent.steer` của Lớp 2) đặt `source: 'jev-gate'` — một **chuỗi trần**. Session
  format v4 đã bỏ dạng đó: mọi slot message phải có `source` là object với
  `kind` không rỗng và khác `'plugin'`; một plugin khai kind riêng là
  `plugin:<tên>`. Log ghi ra vẫn append được (validate lúc ghi không kiểm
  source), nhưng **lần đọc lại kế tiếp** ném
  `SessionFormatError: format v4 message requires a producer-owned source kind`,
  và cả session bị coi là corrupt — không load lại được.

  Đã đo trên máy này: 10/95 session log có record `"source":"jev-gate"`; 9 file
  đã được vá tại chỗ (23 record), file còn lại là session đang chạy.

  Giờ dùng `source: { kind: SOURCE_KIND }` với
  `SOURCE_KIND = 'plugin:jev-gate'` — đúng giá trị mà chính DSH v3→v4 sinh ra
  cho dạng cũ, nên log cũ và log mới đọc về cùng một shape. `isGenuineUserMessage`
  vẫn chỉ nhận `source.kind === 'user'`, nên gợi ý của plugin tiếp tục bị loại
  khỏi trường "yêu cầu của user" (test có case cho cả dạng chuỗi cũ lẫn object
  mới).

### Thêm

- **LỚP 5 — chọn file nạp vào context** (gộp vào `agent/pre-step` cùng Lớp 4, chỉ
  step 1). Đây là mục tiêu chi phí rõ nhất: phần lớn token đầu vào bị đốt vào việc
  model tự đi tìm file liên quan bằng chuỗi tool call, trong khi phần lớn token đó
  chỉ để trả lời "file nào đáng đọc".

  Cách làm: plugin liệt kê ứng viên bằng **tên file** (`readdir` theo chiều rộng
  tới 4 tầng, tối đa 60 thư mục, xếp hạng theo token khớp trong task rồi tới tên
  file định hướng), rồi hỏi Jev một câu `noul` cho **mỗi** ứng viên. Mọi câu đi
  trong **cùng một request** với câu hỏi approach của Lớp 4. Host so ngưỡng
  `contextFileThreshold` (0.6), xếp giảm dần, cắt còn `contextMaxFiles` (3).

  Vì sao N câu `noul` chứ không một `choice` nhiều nhánh: danh sách file sinh động
  theo từng repo, mà `choice.criteria` phải cố định trong code.

  Config: `enableContextTriage` (bật), `contextFileThreshold` (0.6),
  `contextCandidateLimit` (12), `contextMaxFiles` (3), `contextTimeoutMs` (6000).

  Số đo trên API thật (`jev-1.13.0`). Bảng dưới là số đo LẠI khi kiểm định prompt
  lần đầu — nó phát hiện hai case biên không đạt ngưỡng:

  | Case | File nên chọn | p (prompt đầu) | Kết quả |
  |---|---|---|---|
  | Bug phiên đăng nhập | `src/auth/session.ts` | 0.88–0.89 | đạt |
  | Đổi màu logo | `assets/logo.svg` | 0.93–0.94 | đạt |
  | Thêm migration | `src/db/migrations/0012.sql` | **0.37–0.41** | KHÔNG đạt |
  | Viết tài liệu onboarding | `docs/onboarding.md` | **0.33–0.35** | KHÔNG đạt |

  Hai case hỏng cùng một nguyên nhân: task **tạo/thêm** artifact mới, nên Jev đọc
  "file này không phải thứ tôi sửa" và trả 0 — dù file anh em định nghĩa format mà
  artifact mới phải khớp. Đây là lỗi của prompt, không phải của ngưỡng: hạ ngưỡng
  xuống 0.35 sẽ kéo theo false-positive ở mọi case khác.

  **Đã sửa prompt** (xem mục "Sửa" của 0.3.2): bổ sung nhánh (b) "artifact CÙNG
  LOẠI Ở CÙNG CHỖ". Sau khi sửa:

  | Case | p trước | p sau |
  |---|---|---|
  | Thêm migration | 0.39 | **0.87** |
  | Viết tài liệu onboarding | 0.34 | **0.65** |
  | Bug phiên đăng nhập | 0.89 | 0.88–0.90 |
  | Đổi màu logo | 0.94 | 0.94 |
  | Test flaky | 0.77 | 0.77 |

  Kiểm định trên ba bộ độc lập, mỗi case 5 lần, ngưỡng 0.6, cắt 3 file:

  | Bộ | Nội dung | Trước | Sau |
  |---|---|---|---|
  | Gốc | 5 case, workspace `src/<module>/` | 3/5 | **5/5** |
  | Held-out | 8 case, cấu trúc Go/JS/Python khác | 7/8 | **8/8** |
  | Đối kháng | 6 bẫy (câu hỏi chung, chỉ đọc log, …) | — | **6/6** |

  False-positive trên cả ba bộ: **0**.

  Độ trễ: **13 câu gộp trong 1 request median 271ms** — bằng một câu đơn, xác nhận
  việc gộp câu chấm song song. Prompt dài hơn làm request nặng thêm ~1.4k token vào
  (xem mục "Đổi" của 0.3.2).

- **LỚP 6 — phục hồi khi tool lỗi** (`tools/post-execute`). Một tool lỗi thường
  khiến model thử lại y hệt vài lần rồi mới đổi cách; mỗi lần thử là một
  generation đầy đủ. Hỏi Jev một câu `choice` 4 nhánh thay cho việc đoán:
  `retry` (lỗi tạm thời) / `alternate` (cách sai) / `diagnose` (chưa rõ nguyên
  nhân) / `stop-and-report` (không tự vượt được).

  Gợi ý trả qua `additionalContexts`, được engine splice vào batch kế tiếp
  (`dsh-agent-loop/lib/index.js:1139`). Có trần `failureMaxPerTurn` (2) để một
  lệnh lỗi lặp lại không sinh vô hạn gợi ý.

  Lớp này **bỏ qua** lệnh bị chính Lớp 1 chặn (nhận biết qua
  `error.info.code === 'JEV_DESTRUCTIVE'`): đó không phải tool lỗi mà là gate
  chặn, và Lớp 1 đã có thông báo riêng.

  Config: `enableFailureRecovery` (bật), `failureMaxPerTurn` (2),
  `failureTimeoutMs` (4000).

  Số đo (`jev-1.13.0`, 6 lần/case, ổn định 6/6 mỗi case):

  | Lỗi | Nhánh Jev chọn | Kỳ vọng |
  |---|---|---|
  | `request timed out after 30000ms` | `retry` | retry ✓ |
  | `cat: ... No such file or directory` | `alternate` 0.81 | alternate ✓ |
  | test fail, chưa rõ lý do | `diagnose` 0.95 | diagnose ✓ |
  | `AWS_ACCESS_KEY_ID not set` | `stop-and-report` 0.93 | stop-and-report ✓ |
  | `ECONNREFUSED 127.0.0.1:5432` | `diagnose` | diagnose ✓ |

  Ghi chú thiết kế: kỳ vọng đầu tiên cho `ECONNREFUSED` là `retry`, nhưng đo ra
  `diagnose` 6/6 — và `diagnose` mới đúng (DB không chạy thì chạy lại vô nghĩa).
  Prompt được viết lại một lần để nói rõ worker có shell access, và tránh
  `stop-and-report` hút hết các case (ban đầu nó chiếm `ECONNREFUSED`).

### Sửa

- **`textOf` không đọc được `result.content` dạng mảng block.** Hàm cũ chỉ xử lý
  chuỗi, mảng, và object có `.content`; nhưng `result.content` của tool LÀ mảng
  block (`[{ type: 'text', text }]`), nên rơi vào nhánh cuối và trả `''`. Hệ quả:
  Lớp 6 im lặng cho mọi lỗi. Phát hiện nhờ test stub ở tầng HTTP, không phải test
  fail-open. Đã thêm nhánh nhận một content block đơn lẻ.

- **`listCandidateFiles` bỏ sót file ở tầng 3.** Bản đầu chỉ đào hai tầng, và đo
  trên workspace thật thì bỏ sót `src/auth/session.ts` — trong khi
  `src/<module>/<file>` là cấu trúc phổ biến nhất của mọi repo. Đổi sang BFS tới
  4 tầng với trần số thư mục, và thêm xếp hạng theo token khớp tên file.

### Đổi

- **Gộp Lớp 4 và Lớp 5 vào một lần gọi Jev.** Hai lớp dùng chung hook
  `agent/pre-step` ở step 1, nên gộp vào một request: 1 lần gọi trả cả hai, Lớp 5
  gần như không thêm độ trễ. Log đổi `type: 'approach_hint'` → `type: 'pre_step'`,
  với các trường `approach`, `context`, `files`.

### Sửa (tài liệu)

- README (cả hai bản): "năm lớp" → **sáu lớp**; thêm Lớp 5 + Lớp 6 vào bảng, cây
  kiến trúc và luồng một lượt; thêm 6 khoá config mới; sửa số test thật (offline
  61 check); thêm số đo Lớp 5/6 và độ trễ vào bảng "Số đo đã kiểm".

## [0.3.0] — 2026-09-28

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
