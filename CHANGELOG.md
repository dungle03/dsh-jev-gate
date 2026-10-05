# Changelog

Theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
và [Semantic Versioning](https://semver.org/lang/vi/).

## [Chưa phát hành] — 2026-10-05

### Sửa — call gate an toàn không còn tiêu ngân sách của lớp khác

- **Lỗi thật đo trên log vận hành**: gate (Lớp 1) gọi Jev cho MỌI lệnh shell, và
  `budgetSpend` cộng các call đó vào cùng bộ đếm lượt/session với completion/
  recovery/effort. Một turn nhiều lệnh đốt hết trần `jevMaxCallsPerTurn: 4`
  (log ghi `turnUsed=29`; một phiên có 197 lần gate nhưng chỉ 1 `completion_check`),
  khiến lớp ưu tiên cao bị cắt âm thầm — đúng kiểu "hy sinh lớp ưu tiên cao" mà
  §16 cấm. Nay safety KHÔNG tiêu trần không-an-toàn (mỗi lần gate vẫn ghi dòng
  `destructive_gate` để quan sát); gate vẫn luôn chạy bất kể ngân sách.
- `tests/budget.mjs` §11 khoá bất biến: 6 lệnh gate với trần turn 2 → completion
  vẫn chạy nguyên vẹn, không có dòng `skip_budget` nào cho `destructive_gate` hay
  `completion_check`.

### Thêm — ngân sách và phép đo đối chứng (§16/§18/§22)

- Ngân sách Jev dùng chung `jevBudgetEnabled`, `jevMaxCallsPerTurn: 4`,
  `jevMaxCallsPerSession: 100`; gate an toàn không bị bỏ qua khi cạn hạn mức.
  Những số mặc định là mức khởi đầu, cần hiệu chỉnh trên session thật.
- `tools/benchmark-trajectory.mjs` ghép cặp `(task_id, seed)` trên JSONL để so
  `vanilla/core/experimental`; thiếu arm, chỉ số chất lượng hoặc nhãn an toàn
  khiến kết luận `unknown`; false-allow mới được phát hiện theo từng cặp thay vì
  so tổng nhãn (tránh hai task xấu/tốt bù nhau). Chỉ có dữ liệu thật đã giữ riêng
  `held-out` mới xét lợi ích. Không tự chạy DSH hoặc xác minh nguồn tự khai.
- `tests/budget.mjs`, `tests/trajectory.mjs` được thêm vào CI và `verify.sh`.
  Bộ test chỉ kiểm logic, chưa phải số đo hiệu quả trên hành trình thật.
- `lib/evidence.mjs` kiểm lại file descriptor (inode, device, kích thước,
  `O_NOFOLLOW`) sau khi mở để giảm rủi ro thay file trong lúc đọc.
- `admitContext` chỉ ghi vân tay các hint **thực sự được chèn**, không tính hint
  bị trần văn bản loại bỏ.

### Thêm — Lớp 5 dựng lại trên bằng chứng file thật (§8) + trần văn bản chèn mỗi turn (§22)

- **`lib/evidence.mjs`** — trích **đoạn bằng chứng rẻ** từ chính file ứng viên:
  dòng `import`/`require`, dòng `export`, và các dòng khớp token task (kèm số
  dòng). Đọc mỗi file **tối đa một lần**; từ chối đường dẫn tuyệt đối / `..` /
  `realpath` thoát khỏi workspace root; bỏ qua symlink, file nhị phân (dò NUL
  trong 8 KB đầu), file > 256 KiB, và file lỗi — trả `null`, không bao giờ ném.
  Chỉ đọc khi `enableContextTriage` bật.
- **Lớp 5 dùng bằng chứng, không đoán theo tên** — `preStepQuestion` đưa đoạn
  trích vào `state.candidate_evidence`; câu hỏi `file_N` trỏ thẳng vào đó. Gợi ý
  chèn cho agent giờ kèm `path (p=…)` + `imports:`/`exports:`/`matching line N:`
  thay vì danh sách tên trần. Cờ mới **`contextEvidence: true`** (tắt = hành vi
  chỉ-có-tên cũ, để A/B).
- **`lib/injection.mjs` + `admitContext`** — trần **`maxPluginContextTokensPerTurn`
  (mặc định 500, ≈ chars/4)** cho tổng văn bản plugin chèn mỗi turn, áp cho L4/L5/
  L6/L8/L2/L7. Ưu tiên `safety > recovery > completion > evidence > advisory`;
  `safety`/`consent`/`real_user` **KHÔNG BAO GIỜ** bị cắt; mảnh bị bỏ ghi log
  `context_budget`. Hạng dưới `completion` (evidence/advisory) ở step 1 chừa
  **một nửa** trần cho `recovery`/`completion` đến sau trong cùng turn (first-come
  budget không được đẩy gợi ý phục hồi ra ngoài). Lý do chặn của Lớp 1 đi đường
  `kind:'deny'`, không qua trần.
- **Sửa lỗi thật ở trần mặc định (bắt bằng demo, không test nào phủ)** — khối bằng
  chứng file của Lớp 5 từng mang hạng `advisory`, cùng hạng với gợi ý approach của
  L4. Ở trần mặc định 500 (nửa trần = 250 cho hạng step-1), approach chèn trước
  thắng first-come, còn bằng chứng MỘT file (~171 token) + approach (~84 token) =
  255 > 250 nên **bằng chứng bị bỏ** — đúng thứ đáng giá nhất của §8 biến mất ở
  cấu hình mặc định. Sửa: bằng chứng mang **hạng riêng `evidence` (> `advisory`)**
  và cờ `truncatable`, nên nó **thắng** gợi ý chung và bị **cắt ngắn** (có log
  `truncated`) chứ không bị bỏ hẳn khi chật. Câu miễn trừ §23 chuyển lên **đầu**
  khối để không bị cắt mất theo đuôi.
- **Semantic dedup (§22)** — `dedupeInjection` trong `lib/injection.mjs`: vân tay
  chuẩn hoá (gộp khoảng trắng, hạ chữ) theo turn, nên cùng một gợi ý không bao giờ
  vào context hai lần. Chỉ áp cho `evidence`/`advisory`; `recovery`/`completion`
  miễn vì chúng có trần riêng theo turn và nhắc lại ở step sau là chủ ý;
  `safety`/`consent`/`real_user` miễn — thà lặp còn hơn im. Log `context_budget`
  thêm trường `deduped`.
- **Test mới** — `tests/evidence.mjs` (28 check: trích bằng chứng, `state`, chèn,
  an toàn nhị phân/quá lớn/symlink/`..`, cờ tương thích) và `tests/context.mjs`
  (49 check: mặc định, ước lượng token, `planInjection`, bảo vệ safety, cắt thật
  có log, reserve, Lớp 1 không bị trần chạm, **hồi quy trần-mặc-định**: bằng chứng
  vẫn được chèn và thắng approach, **dedup**). Cả hai thêm vào `verify.sh` và CI.
- **Vẫn `enableContextTriage: false`** — code đã dựng lại nhưng **chưa A/B thật**;
  bật khi đo được tỉ lệ agent mở đúng file tăng.

- Thêm `profile: safe|balanced|experimental|custom` để so sánh các lớp theo
  cùng một cấu hình xác định; ba profile có tên luôn giữ gate và sàn catastrophic,
  nhưng tôn trọng cấu hình người dùng nghiêm hơn (`block`, tắt tự uỷ quyền/thẻ
  đồng ý, ngưỡng phá dữ liệu thấp hơn). `custom` giữ tương thích cấu hình cũ.
- Mặc định tắt Layer 4 (`enableSpawnHint: false`) cho tới khi A/B theo hành trình
  chứng minh lợi ích ròng; Layer 5 và 8 vốn đã tắt mặc định.
- `shadowGateThreshold` ghi quyết định phản thực tế theo ngưỡng thử nghiệm
  nhưng không thay ngưỡng đang thực thi, provenance, thẻ đồng ý hay sàn catastrophic.

### Thêm — Lớp 3 chế độ ABSTAIN: `medium` thành quyết định, không phải dấu hiệu hỏng

Vấn đề của thiết kế cũ: khi `effortJevChoices` chỉ có `low`/`high`, một API chạy
được **buộc** Jev chọn một cực — kể cả khi task ở giữa. `medium` chỉ xuất hiện khi
Jev **lỗi**, tức là **dấu hiệu hỏng**, không phải quyết định. Đo trên log thật:
mức đổi `low↔high` **113/120** lần.

`effortAbstain: true` hỏi **hai câu `noul` độc lập trong MỘT request** (một call
Jev như cũ) rồi host tự ánh xạ — Jev không bao giờ bị ép chọn cực:

| `routine` | `hard` | Kết quả |
|---|---|---|
| ≥ 0.5 | < 0.5 | `low` |
| < 0.5 | ≥ 0.5 | `high` |
| còn lại (mâu thuẫn / cả hai yếu) | | `effortFallback` = `medium` (**abstain**) |

- Hai trục hiệu chỉnh độc lập: `effortRoutineThreshold`, `effortHardThreshold`.
- Sàn tín hiệu đo được **vẫn áp**: Jev nói `low` mà turn trước test fail → `high`.
- `effortJevChoices` tùy biến vẫn đúng: `low` = mức thấp nhất, `high` = cao nhất.
- **Mặc định `effortAbstain: false`** giữ nguyên đường `choice` đã đo **26/26**.
- Log `effort_route` ghi `source: 'jev_abstain'` + `routine`/`hard`.
- `lib/policy.mjs` export `effortAbstainQuestion`, `mapEffortAbstain`.

#### Đo thật trên bộ 26 nhãn — và một lỗi câu hỏi tìm được nhờ đó

Chạy đúng 26 task đã dùng để đo đường `choice` (16 easy kỳ vọng `low`, 10 hard kỳ
vọng `high`), model `jev-1.13.0`, 3 lần lặp:

| biến thể | điểm | abstain oan |
|---|---|---|
| câu `hard` bản đầu (thiết kế) | **63/78** | 15 |
| câu `hard` đã viết lại | **78/78** | 0 |

Nguyên nhân: bản đầu viết *"the answer is not yet known and must be found"* — câu
đó mô tả **đúng** việc "đọc `package.json` để biết version", nên Jev trả `hard`
cao (0,50–0,61) cho task routine và bị ABSTAIN **oan**. Ví dụ đo được:
`đọc package.json và cho biết version` → routine 0,95 / hard 0,55 → abstain,
dù đây là task dễ nhất bộ.

Bản viết lại tách hai việc khác nhau: *"work out something that **DETERMINES WHAT
TO DO**"* (uncertainty thật) so với *"Reading a file to learn a value you were
asked to report is **NOT** uncertainty"*. Sau khi sửa: **78/78**, 0 abstain oan,
và đường `choice` cũ vẫn 26/26. Test `11aa-k` khoá lại carve-out này.

#### Abstain có thêm giá trị không? — 8/12 ca khác đường `choice`

Trên 12 task "giữa" (không rõ routine, cũng không rõ cần chẩn đoán), abstain khác
`choice` ở **8/12 ca** — và abstain đúng ở những ca mà `choice` bị **ép** chọn một
cực với confidence thấp:

| task | abstain | `choice` (bị ép) | conf |
|---|---|---|---|
| thêm error handling cho API client | `medium` | `high` | 0,82 |
| gộp hai hàm trùng lặp thành một | `medium` | `low` | **0,01** |
| viết thêm test cho module config | `medium` | `high` | **0,09** |
| thêm validation cho form đăng ký | `medium` | `high` | 0,17 |
| đổi cách đặt tên biến cho nhất quán | `medium` | `high` | 0,23 |
| thêm logging vào hàm xử lý đơn hàng | `medium` | `low` | 0,45 |
| thêm type annotation cho file utils.ts | `medium` | `low` | 0,55 |
| thêm retry cho lời gọi mạng | `medium` | `high` | 0,53 |

Đây đúng là mục tiêu thiết kế: **không định hướng model khi không có tín hiệu rõ**.

### Thêm — Lớp 4 im lặng khi thiếu bằng chứng (cổng xác suất + margin)

Câu `choice` luôn trả một hướng, kể cả khi state không đủ; `confidence` **không**
tương quan với đúng/sai (ca đúng conf 0,24 nằm dưới ca sai conf 0,44), nên ngưỡng
confidence không lọc được gì.

- Thêm nhánh **`no-op`** vào criteria câu `approach` — Jev có đường khai "không đủ
  bằng chứng", một câu trả lời hợp lệ.
- Cổng mới theo **phân phối**: chèn gợi ý chỉ khi `max(probabilities) >=
  approachTopProbability` (0.5) **và** `max − second_max >= approachProbabilityMargin`
  (0.15) **và** nhánh thắng không phải `no-op` **và** `choice` khớp argmax.
- Log ghi nhãn lý do im lặng: `silent_no_op` / `silent_insufficient_evidence` /
  `silent_ambiguous`, kèm `topProbability` + `margin`.
- `approachConfidenceThreshold` chỉ còn là đường lùi khi thiếu `probabilities`.

### Thay đổi — Lớp 5 mặc định TẮT (`enableContextTriage: false`)

Lớp 5 chỉ hỏi Jev dựa trên **TÊN file + đường dẫn**, không có nội dung. Đo trên
session thật (`777a1746`): agent nhận gợi ý tên file **0/4 lần** đổi hành vi. Một
gợi ý không kèm bằng chứng còn tệ hơn không gợi ý vì nó neo model vào phỏng đoán.
Bật lại khi lớp này trích được bằng chứng thật rồi để Jev xếp hạng trên đó.

### Thay đổi — Lớp 6: phân loại lỗi TẤT ĐỊNH trước khi hỏi Jev + sàn vòng xoáy

Nửa đầu của Lớp 6 hỏi Jev cho **mọi** tool error. Nhưng phần lớn lỗi rơi vào vài
lớp nhỏ mà cách xử lý đã rõ từ chính mã lỗi — hỏi Jev là một round-trip lãng phí,
và tệ hơn: Jev có thể khuyên `retry` cho một lỗi **tất định** (thiếu file, sai cú
pháp), đúng vòng xoáy mà lớp sinh ra để chặn.

- Bảng phân loại tất định (`classifyDeterministicFailure`), chạy TRƯỚC Jev:
  `ETIMEDOUT`/`ECONNRESET`/`socket hang up` → `retry`; `ENOENT`/`command not
  found` → `alternate`; `EADDRINUSE` → `alternate`; `SyntaxError` → `alternate`;
  `EACCES`/`EPERM`/`permission denied` → `diagnose`. Lỗi không khớp bảng rơi
  xuống đúng đường cũ: hỏi Jev.
- Lỗi do chính plugin sinh (`JEV_*`) **không bao giờ** bị phân loại ở đây.
- **Sàn vòng xoáy**: đếm theo chữ ký chuẩn hoá `(tool, dạng lệnh, vân tay lỗi)`
  keyed theo session (`failureSignatureOf`). Cùng một lỗi lặp lại ⇒ `retry`
  **không còn hợp lệ**, nâng lên `alternate`. Bộ đếm chạy TRƯỚC trần mỗi turn,
  nên trần chặn gợi ý ở turn này không làm mất cảnh báo ở turn sau.
- Log `failure_recovery` thêm `origin` (`deterministic:<lớp>` hoặc `jev`) và
  `floored_from`/`repeats` khi sàn nâng nhánh.

### Thay đổi — Lớp 8: kết quả nền phải khớp vân tay task/root + mặc định TẮT

`jg` chạy nền có thể xong **sau khi user đã đổi task**. Query A "authentication
middleware ở đâu" xong sau khi user chuyển sang "debug billing webhook", và kết
quả A bị chèn vào turn mới — context SAI + anchoring noise. Gợi ý "đọc file X" của
một task khác không phải "hơi cũ", nó là sai hướng.

- Mỗi entry nền lưu **vân tay task gốc**, root, turn gốc, câu hỏi đã gửi
  (`taskFingerprint` — THUẦN, FNV-1a trên chuỗi đã chuẩn hoá).
- Ô chờ key theo **`session + hash(truy vấn) + root`**, không chỉ session. Lỗi thật đã
  đo: key chỉ theo session thì một lần chạy nền của task A còn dở sẽ **chặn task B
  MỚI leo thang** cho tới khi A xong ("task B escalation blocked by old task A
  run: true"). Thêm hash truy vấn và root ⇒ task mới hoặc workspace khác không bị
  lần chạy cũ chặn, cùng một truy vấn trong cùng workspace vẫn không chạy trùng.
- Trước khi chèn, so vân tay task HIỆN TẠI với vân tay gốc **và** root hiện tại
  với root gốc; không khớp ⇒ **cache kết quả lại, KHÔNG chèn** (quay lại đúng
  task cũ thì dùng lại được). Log `skip_stale` kèm
  `origin_task_hash`/`current_task_hash` để đo được.
- Nhánh A (leo thang khi task *đọc ra* là "tìm X ở đâu") tách thành
  `jevGrepSearchTaskHeuristic`, **mặc định TẮT**: leo thang không nên chỉ dựa
  trên "task nghe giống search" mà cần bằng chứng đo được (nhánh B: đã có
  `jevGrepSearchTaskThreshold` lệnh dò tìm thô liên tiếp).
- **`enableJevgrepEscalation` mặc định `false`** (báo cáo §12, luật pha 4): đo
  thật **41/41 lần leo thang đều `fail_open`**, truy vấn MỚI cold 66s–2m5s ⇒ Lớp
  8 tới giờ chỉ tạo overhead, chưa từng trả về gợi ý. Đưa về experimental; bật
  lại bằng `enableJevgrepEscalation: true`.

### Kiểm thử

`tests/offline.mjs` thêm mục **11aa** (11 khẳng định cho chế độ abstain: bảng ánh
xạ, sàn tín hiệu, fallback khi lỗi, ngưỡng tùy biến, choices tùy biến, log) và mục
**9b** (7 khẳng định cho cổng bằng chứng Lớp 4: thắng rõ, đỉnh thấp, margin mỏng,
`no-op`, `choice` lệch argmax, ngưỡng tùy biến, log), cộng khẳng định `no-op` trong
hình dạng câu hỏi và 4 khẳng định DEFAULTS mới. Mục **10g** (18 khẳng định) và
**10j** (9 khẳng định) khoá Lớp 6: bảng phân loại tất định, 0 lời gọi Jev cho lỗi
đã biết, đường Jev vẫn nguyên cho lỗi nhập nhằng, chữ ký vòng xoáy, sàn
`retry → alternate`, sàn còn hiệu lực qua turn dù trần đã chặn. Mục **13 B12** (7
khẳng định) khoá Lớp 8: kết quả nền task cũ không chèn vào task mới, cùng task thì
vẫn chèn, `taskFingerprint` thuần. Thêm 2 khẳng định DEFAULTS
(`enableJevgrepEscalation=false`, `jevGrepSearchTaskHeuristic=false`). Toàn bộ
suite: **0 FAIL** (số khẳng định tăng theo từng đợt bổ sung test).

## [0.13.1] — 2026-10-04

### Sửa — câu hỏi chọn effort là TURN-LEVEL, không phải per-step (Lớp 3)

Câu hỏi `effortQuestion` cũ hỏi *"which reasoning effort is sufficient for the
NEXT generation"*. Điều đó đúng với cơ chế tái dùng theo từng step ngày xưa,
nhưng **sai với thực tế hiện tại**: Lớp 3 chốt mức cho CẢ turn rồi giữ nguyên
(sticky theo turn). Hệ quả đo được trên **26 task có nhãn × 5 lần**:

| Phrasing | Đúng | easy (16) | hard (10) |
|---|---|---|---|
| cũ — "NEXT generation" | 21/26 | 16/16 | **5/10** |
| mới — "fixed for the WHOLE turn … ENTIRE request" | **26/26** | 16/16 | **10/10** |

Cả 5 ca sai của phrasing cũ cùng một dạng: yêu cầu **nêu triệu chứng cần chẩn
đoán** ("memory leak", "race condition", "query chậm chưa rõ nguyên nhân") bị
chấm `low` vì bước đầu tiên chỉ là đọc file — dù cả turn cần `high`. Phrasing mới
nói rõ mức áp cho toàn turn và "yêu cầu mà nguyên nhân chưa biết thì không phải
yêu cầu thường". Không over-escalate (easy vẫn 16/16), ổn định qua 3 lần lặp.

### Sửa — bỏ lời hứa sai về confidence trong instructions

Instructions cũ nói confidence *"is used to decide whether this level can be
carried into the following step"*. Ở chế độ `input` điều này **chưa từng đúng**:
sticky theo turn, không theo confidence. Đo trên cùng tập nhãn cho thấy ngưỡng
confidence **không tách được** ca đúng/sai (dải ca sai 0,52–0,57 nằm trọn trong
dải ca đúng 0,00–0,79). Nay instructions nói thẳng confidence chỉ được ghi log
cho người vận hành. Hành vi không đổi — chỉ bỏ một lời hứa khiến Jev hiệu chỉnh
confidence sai hướng.

### Sửa — `EFFORT_MEANING.low` bỏ carve-out per-step

Criteria là thứ Jev đọc để phân biệt các mức, nên nó phải khớp phrasing turn-level.
Bản cũ định nghĩa `low` là *"a routine or mechanical next step … including the easy
opening step of a hard task"* — đúng với phrasing cũ nhưng **tự mâu thuẫn** với
phrasing mới (vốn nói rõ mức áp cho cả turn). Nay `low` = *"the whole request is
routine or mechanical"*, `high` = *"requires resolving genuine uncertainty at some
point"*. Đo lại với criteria mới: vẫn **26/26**, easy 16/16, hard 10/10.

### Thêm — test 11z-m/11z-n/11z-o khoá phrasing turn-level

14 check mới trong `tests/offline.mjs`:
- **11z-m** — instructions chứa "WHOLE turn", "ENTIRE request", ưu tiên `high` khi
  yêu cầu nêu triệu chứng, **không** còn "NEXT generation" hay lời hứa confidence cũ.
- **11z-n** — `EFFORT_MEANING` không còn carve-out "easy opening step".
- **11z-o** — câu hỏi turn-level đi qua **đúng đường plugin**: chặn `fetch` ở tầng
  thấp nhất, chạy trọn `agent/pre-step` → `agent/request`, soi nguyên văn body gửi
  Jev (task, instructions, criteria). Đã kiểm bằng mutation: khôi phục phrasing cũ
  làm **7 check hỏng**, nên đây là test thật chứ không phải tautology.

## [0.13.0] — 2026-10-04

### Thêm — Lớp 1b: thẻ ĐỒNG Ý cho hành động do agent tự đề nghị

Yêu cầu gốc tách làm hai:

- **Yêu cầu của user là kiên quyết** — user bảo xoá thì xoá. Provenance tất định
  (v0.9.0) đã lo nhánh này: `allow_authorized`.
- **Agent tự đề nghị xoá giữa lúc chạy** thì **phải hỏi user và chờ đồng ý**,
  tuyệt đối không tự xoá khi user chưa cho phép. Trước đây nhánh này **chặn cứng**
  (`deny`), tức là user muốn cho qua cũng không có cách nào đồng ý.

Nay khi provenance **không** chứng minh được quyền, Lớp 1b dựng một **thẻ câu hỏi
nổi** qua `ctx.userQuestions` và **chờ** câu trả lời:

```
provenance không chứng minh được
  └─► thẻ ĐỒNG Ý nổi (ctx.userQuestions), chờ user
        ├── đồng ý rõ ràng ──► cho chạy (allow_consented)
        └── từ chối/bỏ qua/hết hạn/không có kênh ──► CHẶN (deny_consent)
```

- **Đồng ý** = chọn đúng một nhãn `"Run it"`, **không** gõ văn bản tự do (cùng
  quy tắc với `dsh-plan-mode`). Chạy, ghi `allow_consented`.
- **Mọi thứ khác** = CHẶN, ghi `deny_consent`, mã lỗi `JEV_CONSENT_DENIED`:
  `"Do not run it"`, `ASK_CANCELLED` (bỏ qua), `ASK_TIMED_OUT` (hết hạn),
  `ASK_ABORTED`, hoặc không có kênh hỏi.

Thẻ dùng `service.askTimed(request, callId, consentTimeoutMs)` (có đếm ngược +
claim) khi có, lùi về `service.ask(request)` khi không. Thẻ mang `detail` = lệnh
đã rút gọn, hai lựa chọn, và `intent: {kind:'jev-destructive-consent',
approve:'Run it', callId}`.

Hai config mới:

- `enableDestructiveConsent` (mặc định `true`) — tắt thì quay về chặn cứng cũ.
- `consentTimeoutMs` (mặc định `120000`) — quá hạn thì coi như từ chối.

Lớp 6 (`tools/post-execute`) thêm mã `JEV_CONSENT_DENIED` vào danh sách bỏ qua:
một lệnh bị thẻ đồng ý chặn không phải "tool lỗi" để gợi ý retry.

### Thêm — Lớp 3: tín hiệu thất bại đo được là SÀN effort

Yêu cầu gốc: effort phải dựa trên **mỗi input của user**. Nhưng bỏ qua bằng chứng
đo được (tool lỗi / test fail ở turn trước) thì vô lý. Nên nội dung input vẫn là
**nguồn chính** (Jev đọc và quyết), còn tín hiệu đo được gửi kèm Jev dưới
`state.measured_signals` như **bằng chứng bậc hai**, và đóng vai **sàn**:

- Jev chọn mức **thấp hơn** mức mà tín hiệu đòi (`effortEscalateTo` khi turn
  trước có ≥ `effortEscalateToolErrors` tool error hoặc ≥ `effortEscalateTestFailures`
  test fail) → **nâng lên sàn**. Không bao giờ hạ xuống dưới sàn.
- Model không nhận mức sàn → bỏ qua sàn, dùng mức hợp lệ gần nhất.
- Log `effort_route` ghi thêm `floored_from` + `floor` khi sàn nâng mức, và
  `signals` để kiểm chứng.

Ba config `effortEscalateTo`/`effortEscalateToolErrors`/`effortEscalateTestFailures`
giờ điều khiển cả sàn ở chế độ `input` (trước chỉ dùng ở `deterministic`).
`lib/policy.mjs` export thêm `EFFORT_ORDER`, `effortRank`, `effortFloorFromSignals`.

### Vì sao dùng `ctx.userQuestions`, không dùng `ctx.approval`

Đường `{kind:'ask'}` của `tools/pre-execute` đi qua `ctx.approval`, nhưng ở bản
deploy này `dsh-purge` đã vá `dsh-user-approval` thành **auto-grant**
(`dsh-user-approval/lib/index.js:173-178` trả thẳng `"allowed-once"` mà không hỏi
ai). Hỏi qua đó không lấy được đồng ý thật. `dsh-user-questions` còn nguyên và
đúng là kênh hỏi user thật, nên Lớp 1b dùng nó.

### Test

- Thêm 20 test Lớp 1b (`tests/offline.mjs` mục 22): đồng ý → allow +
  `allow_consented`; từ chối → deny `JEV_CONSENT_DENIED` + `deny_consent`; đồng ý
  kèm văn bản tự do → vẫn deny; hết hạn (`askTimed` trả `{pending:true}`) → deny,
  kiểm đúng `callId`/`timeoutMs`; `ASK_CANCELLED` → deny; thiếu service → deny
  `unavailable`; service ném lỗi lạ → deny (không fail-open); user nêu target →
  `allow_authorized` và **không** hỏi thẻ; `enableDestructiveConsent:false` →
  `JEV_DESTRUCTIVE`; Lớp 6 bỏ qua lệnh bị thẻ chặn.
- Thêm 6 test Lớp 3 (mục 23): Jev `low` + test fail → nâng `high` (sàn); Jev
  `high` + sạch → giữ `high`; 1 tool error (dưới ngưỡng) → giữ `low`; request gửi
  Jev có `measured_signals`; model thiếu `high` → bỏ sàn, dùng `medium`; log có
  `floored_from`/`floor`.
- `node tests/offline.mjs` → **TẤT CẢ PASS**.
- Thêm `tests/consent-integration.mjs` — chạy câu hỏi đồng ý qua
  `UserQuestionService` **THẬT** (import `dsh-user-questions` + `cordis` từ DSH
  cục bộ): câu hỏi hợp lệ qua được validation thật (không `BAD_INTENT`), parse
  answer thật ra `approved`; `intent.approve` sai hoặc thiếu `detail` → service
  ném `BAD_INTENT` (chứng minh validation thật sự chạy); đồng ý + custom →
  refused; và đường hết hạn `askTimed` thật → `{pending:true}` → CHẶN. 10 check
  PASS. File này **bỏ qua** (exit 0) khi máy không có DSH, nên CI Node 20/22
  không đỏ. `verify.sh` mục 7 chạy nó.

## [0.12.0] — 2026-10-04

### Đổi — Lớp 3 chế độ `input`: Jev chỉ quyết `low`/`high`, còn lại `medium`

Operator chốt: Jev chỉ đẩy hai đầu; mọi trường hợp khác giữ `medium`.

Thêm hai config:

- `effortJevChoices` (mặc định `['low','high']`) — tập mức Jev **được phép**
  chọn. Giao với dải `reasoningEfforts` của model; nếu giao còn **< 2 mức** thì
  không hỏi Jev nữa (không có gì để chọn) và dùng thẳng fallback.
- `effortFallback` (mặc định `'medium'`) — mức áp khi Jev lỗi / không có task /
  trả mức ngoài tập cho phép.

Hệ quả: Jev trả `max` hay `medium` (ngoài tập) đều **không** được áp — rơi về
`medium`. Đây là bất biến phân quyền: Jev chỉ đẩy 2 đầu, phần giữa do config
quyết.

### Vì sao (đo thật, không phải suy đoán)

Probe trực tiếp Jev (`effortQuestion`, 5 lần lặp mỗi độ khó, dải
`low/medium/high/max`):

| Độ khó | Kết quả 5 lần | Nhận xét |
|---|---|---|
| dễ (liệt kê file) | `low`×5, conf **1.00** | rất chắc |
| vừa (so sánh 2 lib) | `low`×5, conf 0.29–0.39 | **gộp medium vào low** |
| khó (truy vết leak) | `low`×3, `high`×2 | **dao động** |
| cực khó (chứng minh) | `max`×5, conf 0.40–0.50 | khá chắc |

`medium` gần như không bao giờ được chọn (1/14 task, conf 0.35). Jev đáng tin ở
2 đầu, mơ hồ ở giữa — nên giao 2 đầu cho Jev, giữ giữa cho config là hợp lý.

### Test

- Thêm 4 test: Jev trả `max` → không áp, rơi medium; Jev trả `medium` → giữ
  medium; model chỉ nhận 1 mức hợp lệ → không gọi Jev; `effortJevChoices` đổi
  được.
- 3 test cũ đổi kỳ vọng fallback từ `low` → `medium`.
- `offline.mjs` (13 test chế độ input), `live-check.mjs`, `attack-corpus.mjs` đều
  PASS.
- Chứng minh trong **DSH boot thật** (profile abB + overlay 9router):
  dễ → `low` (conf 0.99), khó → `high` (conf 0.52), Jev lỗi → `medium`
  (`reason: fail_open`).

## [0.11.0] — 2026-10-04

### Thêm — Lớp 3 chế độ `input`: Jev chọn effort từ nội dung tin nhắn user

Operator muốn: mỗi lượt user gửi, Jev đọc yêu cầu rồi quyết định lượt đó chạy ở
mức effort nào. Trước đây Lớp 3 là luật tất định (mặc định `low`, chỉ nâng khi
turn trước có tool error/test fail) và **không hề đọc nội dung yêu cầu**.

Thêm config `effortDecision`:

- `'input'` (**mặc định mới**) — mỗi lượt user, gọi Jev `effortQuestion` với task
  text (lấy từ `notePrompt` ở `agent/pre-step`), chọn mức theo độ khó yêu cầu.
- `'deterministic'` — luật tín hiệu cũ, giữ nguyên làm đường lui.

Bất biến giữ nguyên:

- **Sticky theo turn** ⇒ Jev chỉ được gọi **1 lần/lượt**, không phải mỗi step.
- **FAIL-OPEN** về `effortDefault` (low) khi Jev lỗi/timeout/không có task.
- Mức Jev trả **phải nằm trong dải `reasoningEfforts`** của model, nếu không lùi
  mặc định (không áp mức model không nhận).
- **Không bao giờ đổi provider/model** — chỉ ghi `reasoningEffort`.
- Log `effort_route` ghi thêm `source: 'jev_input' | 'deterministic'` và
  `confidence` để đo được lớp này có tác dụng không.

Đánh đổi đã biết (ghi rõ để không tự huyễn): chế độ `input` tốn **1 call Jev/lượt
trên đường tới hạn** (~281ms) và có thể dao động mức giữa các lượt — đúng những
gì bản classifier 2026-09 từng mắc. Khác biệt: lần này gọi **1 lần/lượt** thay vì
mỗi request, và chỉ hỏi "yêu cầu này khó không", không hỏi lại trong cùng lượt.

### Test

- Thêm 9 test mục `11z` cho chế độ `input`: Jev chọn high/low, sticky 1 call/4
  step, fail-open khi lỗi mạng, mức ngoài dải → lùi mặc định, không task → không
  gọi Jev, sang turn mới hỏi lại.
- Mục 11 cũ (20 test) và mục 19 giữ nguyên hành vi bằng cách opt-in
  `effortDecision: 'deterministic'`.
- `offline.mjs`, `live-check.mjs`, `verify.sh` đều PASS (gồm "lớp effort áp được
  reasoningEffort" trên Jev API thật).

## [0.10.3] — 2026-10-02

### Sửa — vẽ lại sơ đồ kiến trúc cho khớp v0.10.3

`assets/architecture.json/.html/.png` còn là bản cũ (30/09): không có lớp **1₀**
prefilter, **1ᶜ** cache, và mô tả **1b** như hỏi LLM `choice`. Sơ đồ đầu trang
mâu thuẫn với chính phần chữ của README.

Vẽ lại: gộp 1₀+1ᶜ+1b thành một nút "tất định — KHÔNG gọi Jev", bỏ hai cạnh
`l2-jev`/`l4-jev` (hai lớp này không gọi Jev), cập nhật card + nhãn. Validate
`--quality showcase` PASS (0 lỗi, 0 cảnh báo).

### Sửa — viết lại README cho khớp code

Viết lại `README.md` và `README.en.md` từ code + số đo thật, sửa các sai lệch:

- Bảng lớp: **1b** là provenance tất định (không `choice`); thêm **1₀** prefilter,
  **1ᶜ** cache; **3** là luật tất định.
- Sơ đồ kiến trúc + vòng đời lượt: thêm 1₀/1ᶜ vào nhánh gate; 1b provenance.
- Mục "Quyền của user": mô tả provenance + số call thật (2 → 1); chuyển bảng
  0/66·0/48·46/48 (cơ chế `choice` cũ) xuống mục "Lịch sử".
- Thêm mục "Cache verdict" (khoá, bất biến, không cache sát ngưỡng).
- Bảng "Số đo" tách **Cơ chế hiện tại (v0.10.x)** vs **Lịch sử**, mỗi hàng có mốc.
- Sửa số sai: `305`→**306** check; `live-check 24`→**10**; prefilter `42,1%`→**13,6%**;
  bỏ khẳng định "1b thêm ~250ms" (1b tất định, 0 call LLM).
- Bảng cấu hình: thêm 5 khoá cache/prefilter; xoá `authorizationTimeoutMs`.
- Ghi rõ `RETIRED_CONFIG` cảnh báo config cũ.

### Sửa — cảnh báo config đã ngừng dùng (tương thích ngược)

`authorizationTimeoutMs` đã bị xoá khỏi schema (Lớp 1b không còn gọi LLM), nhưng
nếu người dùng còn đặt khoá này trong `cordis.patch.yml`, `schemastery` bỏ qua
**im lặng** — họ tưởng nó vẫn tác dụng. Thêm nó vào `RETIRED_CONFIG` để log cảnh
báo rõ ràng (như đã làm cho `effortReuseConfidence`/`effortMaxReuseSteps`).
Tổng quát hoá cơ chế để mỗi khoá retired có thông báo riêng.

### Sửa — test không để lại rác `/tmp`

Các `mkdtempSync` trong `tests/offline.mjs` phần lớn tạo mà **không dọn** — đo
được **595 thư mục `jev-gate-*`** rác trong `/tmp` sau nhiều lần chạy (kể cả khi
tiến trình bị kill giữa đường). Gom mọi chỗ tạo temp qua một helper `tmpDir()`
đăng ký vào một registry, dọn sạch khi `exit`. Chạy test nhiều lần giờ không
sinh thêm thư mục nào.

### Sửa — README khớp code

- Bảng lớp + sơ đồ kiến trúc: Lớp **1b** là **provenance tất định** (không gọi
  Jev), không còn `choice`; thêm lớp **1ᶜ** (cache verdict) và **1₀**.
- Mục "Quyền của user": mô tả đúng cơ chế provenance + số call thật (2 → 1).
- Thêm mục "Cache verdict": khoá, bất biến (`fail_open` không cache), và lý do
  không cache sát ngưỡng.
- Bảng cấu hình: thêm `enableReadOnlyPrefilter`, `enableCatastrophicFloor`,
  `enableGateVerdictCache`, `gateVerdictCacheMax`, `gateVerdictCacheMargin`;
  xoá `authorizationTimeoutMs` (config chết sau khi bỏ call LLM thứ hai).
- Số liệu cập nhật: prefilter 37,4% → **14,0%**; test **305 check** + corpus 83 lệnh.

## [0.10.2] — 2026-10-02

Sửa nguyên nhân gốc của **381 lỗi `TypeError: fetch failed`** (25% số call Jev
ngày 02/10, tất cả đều `fail_open`): máy có bản ghi AAAA nhưng KHÔNG có route
IPv6, `fetch` hỏng ngay ở tầng connect (đo được `ms: 2–7`) và mỗi lần hỏng là một
lần gate im lặng bỏ qua lệnh.

### Sửa — `describeError` giữ `error.cause` (nguyên nhân vô hình trong log)

`fetch` của Node/undici bọc MỌI lỗi mạng trong `TypeError('fetch failed')` rồi
giấu mã thật ở `error.cause`. Bản cũ chỉ đọc `error.message`, nên **381 bản ghi
đều ghi giống hệt nhau `"TypeError: fetch failed"`** — không phân biệt được IPv6
không route (`ENETUNREACH`), DNS hỏng (`ENOTFOUND`), TLS lỗi, hay connection
reset. Sự cố thật trở nên vô hình.

- `errorCauseChain` đi theo `cause` lồng nhau (trần độ sâu 5, chống vòng lặp tự
  trỏ) và `AggregateError.errors`, gom `code`/`errno`/`syscall`, dedup.
- Nay log ghi: `TypeError: fetch failed [ENETUNREACH]`.
- Bỏ `code` SỐ của DOMException (mã legacy, `AbortError = 20`) để không làm nhiễu
  `AbortError: aborted [20]`.

### Thêm — thử lại lỗi mạng TẠM THỜI (trước đây chỉ retry 429/529)

`evaluate` chỉ retry 429/529, nên mọi lỗi mạng transient thành `fail_open` ngay
lần thử đầu — đo được **381/381** lần `fetch failed` đều bỏ qua chỉ sau 1 lần gọi.

- `isTransientNetworkError`: nhận diện lỗi tầng connect (`ENETUNREACH`,
  `EHOSTUNREACH`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`,
  `UND_ERR_*`...). KHÔNG tính abort/timeout do chính ta đặt — đó là quyết định có
  chủ ý, thử lại là sai.
- `MAX_ATTEMPTS = 3` (1 gốc + 2 lại) với backoff ngắn 50–150 ms.
- **Trần độ trễ KHÔNG đổi:** mọi lần thử vẫn nằm dưới `combined` (deadline +
  lifetime + hook signal); `sleep()` thoát ngay khi signal abort, hết ngân sách là
  `throwIfAborted` cắt. Test (f): deadline 100 ms dừng ở 131 ms.
- Lỗi cấu hình (401 key sai, 422 request sai) KHÔNG retry — vô ích, chỉ tốn ngân
  sách. Log ghi ĐÚNG MỘT `jev_error` cho cả chuỗi retry.

### Sửa — `describeError`/`isTransientNetworkError` KHÔNG BAO GIỜ ném

Cả hai chạy TRONG catch block của `evaluate`. Nếu bản thân chúng ném — getter
`cause` độc hại, `code` là object có `toString` ném, hoặc chính error là `Proxy`
trap ném — thì lỗi gốc bị thay bằng lỗi của bộ ghi log: `jev_error` không ghi
được, và `fail-open` của caller biến thành lỗi ném ra hook.

- `errorCauseChain` bọc từng bước truy cập; `describeError` bọc việc đọc
  `name`/`message`; `isTransientNetworkError` bọc toàn thân (không phân loại được
  → coi như KHÔNG transient, an toàn hơn retry mù).
- Bất biến: lỗi độc hại → ném lại ĐÚNG lỗi gốc, vẫn ghi MỘT `jev_error`.

### Bằng chứng

- Tái hiện nguyên nhân gốc: ép DNS chỉ trả AAAA → `fetch failed` / `cause.code:
  ENETUNREACH` trong 2–6 ms, khớp đúng profile `ms:4/5/6` của log thật.
- 305 check offline PASS (thêm 33 check cho các sửa này).
- Live check API thật (`jev-1.13.0`): PASS.

### Kiểm định
- 305 check offline PASS; corpus tấn công 83 lệnh — **0 lọt**.
- Test hồi quy mới: (a) transient lần 1 → thành công lần 2, không `fail_open`;
  (b) hỏng liên tục → ném sau 3 lượt, đúng MỘT `jev_error`, giữ `ENETUNREACH`;
  (c) hook abort → không retry; (d) 401 → không retry; (e) 429 → vẫn retry;
  (f) deadline ngắn chặn retry; (g) lỗi độc hại → không ném, ghi log sạch;
  (h) getter/Proxy/toString ném → `describeError` vẫn trả chuỗi.

## [0.10.1] — 2026-10-02

Sửa hai lỗ hổng quan sát/an toàn do kiểm định phản biện và end-to-end phát hiện.

### Sửa — cache verdict KHÔNG đóng băng `allow` sát ngưỡng

**Lỗ hổng thật** (đo trên Jev thật jev-1.13.0): Jev KHÔNG tất định — `rm -f <file>`
cho p vắt qua ngưỡng 0,7 (`0.67, 0.68, 0.69, 0.70`). Cache một lần rơi mẫu
`< ngưỡng` (allow) thì mọi lần sau phục vụ p cũ, **bỏ qua** các mẫu `≥ ngưỡng`
lẽ ra phải chặn — biến 2 quyết định deny thành allow.

- Thêm `gateVerdictCacheMargin` (mặc định `0.1`): **không cache** khi
  `|p − threshold| ≤ margin`. Verdict cách ngưỡng đủ xa thì dao động không đổi
  kết quả, nên cache an toàn; vùng sát ngưỡng luôn hỏi lại Jev.
- Test hồi quy (i): dãy p `[0.68, 0.72, 0.70]` → lần 2 phải DENY (không đóng băng
  allow); lệnh xa ngưỡng (0.1) vẫn cache.

### Sửa — bản ghi `allow_readonly` ghi kèm `command`

Bản ghi prefilter chỉ có `{tool, decision}` → không audit được cái gì đã được cho
qua. Nay ghi `command` (cắt 400 ký tự) như `allow`/`deny`. Test (12e) khoá bất biến.

### Kiểm định
- 280 check offline PASS; corpus tấn công 83 lệnh — **0 lọt**.

## [0.10.0] — 2026-10-02

Giảm call Jev của Lớp 1 (gate phá dữ liệu) — điểm nóng chiếm **68% call** (4.363/6.387
trong 2 ngày). Hai cơ chế, cả hai đều chứng minh được an toàn.

### Thêm — prefilter nhận vòng `for..do..done` chỉ-đọc

Prefilter cũ phủ **0,03%** lệnh tới Jev (nó bỏ cuộc với mọi lệnh ghép). Nay nó phân tích
tầng token: một vòng `for VAR in <list literal>; do <body>; done` được coi là chỉ-đọc khi
thân — sau khi thay `$VAR` bằng placeholder không-phải-lệnh — chứng minh được là chỉ-đọc.
Mọi nghi ngờ (`$()`/backtick/heredoc/redirect ghi/`$VAR` ở vị trí lệnh/for lồng) → `false`.

- Yield thật: **1 → 457 lệnh allow nhận** (0,03% → **14,0%**).
- Bất biến an toàn: corpus **329 lệnh phá dữ liệu — 0 lọt**; fuzz 384+39 biến thể — 0 lọt.
- Bằng chứng thực thi: chạy **bash thật trong sandbox**, chụp hash cây thư mục trước/sau →
  **0 lỗ hổng** (không lệnh nào vừa được nhận vừa gây hư hại).

### Thêm — cache verdict gate theo `(tool, command, cwd)`

Lệnh trùng y hệt (byte-identical) + cùng cwd là CÙNG một hành động → cache verdict.

- Yield thật: **~6,4%** call gate (lệnh trùng y hệt).
- **Chỉ cache verdict rõ ràng:** `allow` (p < ngưỡng) và `deny` (đã qua Lớp 1b).
  **`fail_open` KHÔNG bao giờ cache** — lỗi tạm thời không được đóng băng.
- Khoá dùng chuỗi command byte-identical (không chuẩn hoá) + cwd. Trần bộ nhớ có eviction.
- Cờ `enableGateVerdictCache` (mặc định `true`).
- Bất biến: cache `deny` → lần sau vẫn `deny`; cache `allow` → vẫn `allow`; khác 1 ký tự
  hoặc khác cwd → miss. Kiểm bằng probe độc lập chạy qua hook thật `tools/pre-execute`.

### Tổng yield

**~20,5% call Jev của gate** (457 prefilter + 210 cache trên 3.260 lệnh allow) — không
đánh đổi an toàn: 0 lệnh phá dữ liệu nào lọt qua 83-lệnh corpus tấn công độc lập.

## [0.9.0] — 2026-10-02

Đợt tối ưu sau khi 0.8.2 chạy thật. Ba việc: hai lỗi "lớp im lặng" ở Lớp 1b và
prefilter chỉ-đọc, và bổ sung chỉ số quan sát cho gate — thứ trả lời được câu
hỏi mà việc đếm thuần không trả lời được.

### Thêm — `gate_useful_ratio` (module `lib/metrics.mjs`)

Gate chạy **11.657 lần** trên log thật (02/10) nhưng chỉ **113 lần `deny`** —
`useful_ratio ≈ 0,0097`. Đếm số lần chạy không lộ ra điều đó: gate gần như chỉ
tốn một round-trip API để nói "cho qua". Chỉ số này lộ ra ngay.

- `lib/metrics.mjs` (mới): `summarize(records)` là hàm **thuần** nhận mảng bản
  ghi đã parse → trả `{ total, allow, deny, fail_open, other, useful_ratio,
  decisions }`. Không đọc file, không I/O ⇒ test offline được.
- CLI độc lập, **không hook vào vòng chạy**: `node lib/metrics.mjs [đường-dẫn]`
  in một dòng JSON. Mặc định đọc `~/.local/share/dsh-jev-gate/decisions.jsonl`.
- `deny` gộp `deny` / `deny_catastrophic` / `auth_fail_closed` (đều là CHẶN
  thật); `fail_open` tách riêng vì "Jev lỗi" khác "gate nhạy". Bất biến
  `allow + deny + fail_open + other == total`.
- `parseJsonl` đếm `malformed` thay vì ném — log append-only có thể bị cắt giữa
  dòng, một dòng hỏng không được làm mất toàn bộ số đo.

### Lớp 1b — bỏ call LLM authorization, dùng provenance tất định (ĐÃ hợp nhất)

Bản cũ, khi Jev phán lệnh phá dữ liệu, hỏi thêm **một call LLM thứ hai**
(`authorizationQuestion`) "user có yêu cầu xoá đúng thứ này không?". Đo trên log:
lớp này fail-closed phần lớn thời gian và thêm một round-trip nằm TRÊN đường tới
hạn của mọi lệnh bị chặn.

**Sửa:** suy quyền từ chính nguồn gốc lệnh (provenance tất định), không hỏi
model. Trích target của lệnh (đường dẫn/tên file của `rm`/`mv`/`truncate`/…),
so khớp chuỗi con với tin nhắn THẬT của user (`source.kind === 'user'`). Có
target → `allow_authorized`; không chứng minh được → **`deny` (fail-closed)**.

**Bất biến an toàn giữ nguyên:** không chứng minh được thì CHẶN. Deny nhiều hơn
chấp nhận được; allow nhầm thì không. Kiểm bằng test end-to-end chạy qua hook
`tools/pre-execute` thật (mục 7b/7c): trước = 2 request Jev mỗi lần gate chặn
(`destructive` + `authorized`), sau = **1** (`destructive`), và khi không chứng
minh được thì **0** request bổ sung.

### Prefilter `python3 -c` / `node -e` — BÁC BỎ, có bằng chứng lọt cụ thể

⚠️ **KHÔNG mở rộng prefilter cho one-liner trình thông dịch.** Mục 0.7.x của
chính file này đã bác bỏ ý tưởng đó. Một nhánh thử nghiệm đã viết blocklist
token (`open`/`write`/`import`/`require`/…); kiểm trực tiếp cho thấy nó **LỌT**
các lệnh ghi dữ liệu thật:

```
python3 -c "f=open;f('x','w')"                       → bị coi là chỉ-đọc (SAI)
python3 -c "getattr(__builtins__,'open')('x','w')"    → bị coi là chỉ-đọc (SAI)
python3 -c "__builtins__.__dict__['open']('x','w')"   → bị coi là chỉ-đọc (SAI)
```

Blocklist không thể đầy đủ với ngôn ngữ Turing-complete; đây đúng là "đoán bừa
là lỗ hổng gate". **Nhánh đó đã bị loại bỏ, không hợp nhất.** Code hiện tại giữ
đúng: `node -e`/`python3 -c` trả `false` và đi qua Jev.

### Test

- **Mục 18** — `summarize`/`parseJsonl`: phân loại từng nhánh, bất biến tổng,
  mẫu rỗng → `0` (không `NaN`), đầu vào rác không ném, dòng hỏng giữ dòng tốt.
  Không đọc log thật (dữ liệu sống ⇒ khẳng định sẽ giòn).
- **Mục 19** — hồi quy Lớp 2: vá `fetch`, khẳng định `signal` đã abort của hook
  `agent/turn-stopping` **KHÔNG** được truyền xuống Jev. Nếu truyền, `AbortSignal.any`
  abort ngay và fetch không chạy (`throwIfAborted` ném trước lời gọi) — test bắt được.
- **Mục 20** — hồi quy Lớp 3: ngưỡng nâng effort đọc từ **config**, không hard-code.
  Đổi `effortEscalateToolErrors` xuống 3 thì 2 tool error không đủ để nâng; đồng thời
  khoá hằng số DEFAULTS (2 tool error / 1 test fail / `stopTimeoutMs > 0`).

## [0.8.2] — 2026-10-01

Sửa HỒI QUY do chính 0.8.1 tạo ra: nâng `jevGrepTimeoutMs` lên 70s biến Lớp 8
thành thứ **chặn turn tới 210 giây** — đúng loại overhead mà cả dự án này sinh
ra để tránh.

### Sửa — Lớp 8 chạy NỀN, không còn chặn turn

**Phát hiện quyết định: cache `jg` theo TỪNG TRUY VẤN, không theo repo.**

Bản 0.8.1 tưởng "cold 64s một lần cho cả repo". Đo lại, sai:

| Tình huống | Thời gian |
|---|---|
| truy vấn đã hỏi (cache ấm) | 7,5–10,2s |
| **truy vấn MỚI (chưa từng hỏi)** | **66s – 2m5s** |

Mỗi truy vấn mới đều cold. Nên bất kỳ timeout nào trong hook AWAIT cũng sai:
thấp thì không bao giờ chạy được, cao thì treo turn. Với `jevGrepTimeoutMs: 70000`
× `jevGrepFailureBreaker: 3` = **210s chặn turn**.

**Sửa: `jg` chạy nền, kết quả chèn ở lần `pre-step` kế tiếp.** Turn không bao giờ
chờ. `jevGrepBackground: true` là mặc định mới; đặt `false` để về hành vi await.

Kết quả có thể "cũ" một nhịp (turn sau nhận gợi ý của turn trước). Chấp nhận:
`jg` tìm theo repo, không theo turn, và gợi ý "đọc file X" hữu ích ở turn sau y
như ở turn phát sinh.

**Đo trên `jg` THẬT** (không phải giả):

```
1st call (khởi động nền):  5 ms     ← trước đây: chờ tới 2 phút
2nd call (sau khi jg xong): 1 ms    ← chèn được gợi ý
```

Log có `decision: started_background` rồi `hinted` với `background: true` để đo
được. `jevGrepTimeoutMs: 70000 → 120000` (không còn chặn turn nên để rộng được).

### Test

B1–B9 chuyển sang `jevGrepBackground: false` (chúng kiểm đường await). Thêm
B9b/B9c cho chế độ nền: lời gọi đầu không chèn, lời gọi sau chèn, không chèn lặp,
log có `started_background` + `hinted` với `background: true`.
**Tổng 201 check pass**, 5/5 lần chạy ổn định. `verify.sh` TẤT CẢ MỤC PASS.

## [0.8.1] — 2026-10-01

Bốn lỗi thật tìm được khi **kiểm tra hiện trạng sau khi 0.8.0 chạy thật**, không
phải bằng cách đọc code. Ba trong bốn là "lớp im lặng không làm gì" — loại lỗi
nguy hiểm nhất vì test vẫn xanh.

### Sửa — `jev_error` ghi `"unknown"`, không chẩn đoán được

Đo trên log: **10 bản ghi `jev_error` có `message: 'unknown'` và `ms: 0`**.

Nguyên nhân gốc: `AbortSignal.throwIfAborted()` ném ra **chính giá trị `reason`**
truyền cho `abort(reason)`. Khi DSH abort với một chuỗi hoặc object (không phải
`Error`), giá trị ném ra cũng không phải `Error`:

```js
const c = new AbortController();
c.abort('some string reason');
c.signal.throwIfAborted();   // ném ra chuỗi, KHÔNG phải Error
```

Bản cũ ghi `error instanceof Error ? error.message : 'unknown'` → `'unknown'`.

Sửa: `describeError(error)` xử lý **mọi kiểu** — `Error` (giữ cả `name`, nên
phân biệt được `AbortError` vs `TimeoutError`), chuỗi, object, `undefined`,
`null`, số. Thay cả **7 chỗ** `'unknown'` trong `index.mjs` và 2 chỗ trong
`jevgrep.mjs`. Test 17 kiểm 7 trường hợp.

### Sửa — Lớp 8 chưa từng chạy được, và `jevGrepTimeoutMs: 12000` là số SAI

Đo `jg` thật trên repo này:

| Tình huống | Thời gian |
|---|---|
| cache lạnh (lần đầu cho một truy vấn) | **64 giây** |
| cache ấm (cùng truy vấn) | 7,5–10,2 giây |

Trần cũ 12s nghĩa là mọi lần cold **chắc chắn timeout**, mà vẫn trả giá 12s.
Đo trên log: **41/41 lần leo thang đều `fail_open`** — chưa lần nào chạy được.
Fix exit-code ở v0.7 chỉ chuyển lỗi từ `jg exited 2` sang `timeout`; bản chất
vẫn là chưa từng hoạt động.

Sửa: `jevGrepTimeoutMs: 12000 → 70000` (chịu được cold start).

**Ghi chú trung thực về lần thành công đầu tiên.** Lúc 04:33:58Z có bản ghi
`decision: "hinted"`, `ms: 7455`, 5 file — nhưng đó **không phải** bằng chứng cho
fix timeout: process đang chạy boot lúc 04:22Z (trước khi fix ghi lúc 04:33Z), và
7455ms vốn nằm DƯỚI ngưỡng cũ 12000ms. Thành công đó là do **cache `jg` đã ấm**
từ lần chạy thủ công để đo. Giá trị của fix là ở **cold start 64s** — chưa xác
nhận trên process thật, cần restart rồi đo lại.

### Thêm — Circuit breaker cho Lớp 8

`jg` cold mất 64s, và hook `agent/pre-step` **await** nó → turn treo 64s. Đó là
overhead trên đường tới hạn — đúng thứ plugin này sinh ra để tránh. Đo được
41/41 lần hỏng nghĩa là tới giờ Lớp 8 **chỉ tạo overhead, chưa từng trả gợi ý**.

Thêm `jevGrepFailureBreaker: 3` — `jg` hỏng LIÊN TIẾP 3 lần thì tạm tắt Lớp 8
cho phần còn lại của phiên. Lần thành công đầu tiên reset về 0. Log ghi
`decision: skip_breaker` + `consecutiveFailures` để đo được. Test B6b/B6c.

### Sửa — Lớp 2 là CODE CHẾT, không phải "fail 53%"

Lớp 2 `return` khi thiếu `agent.goal.objective`. Nhưng operator gần như không
dùng goal: đếm trên **162 session, chỉ 8 sự kiện `goal/change`** — và Lớp 2
**không chạy lần nào từ 29/09** (im lặng 3 ngày).

Sửa: dùng `taskOf(agent)` — goal ưu tiên, rồi tới prompt THẬT của user do
`notePrompt` ghi lại từ `agent/pre-step`. Lớp 2 giờ thực sự chạy.

### Sửa — ABORT bị đếm là tool error, làm Lớp 3 nâng effort vô cớ

`turnSignals` đếm `data.error` là `toolErrors`. Nhưng `data.error` có mặt ở CẢ
hai trường hợp: tool lỗi thật, VÀ tool bị **HUỶ** giữa đường (`AbortError`/
`ABORTED`/`TimeoutError`). Abort không nói gì về độ khó bước sau — nó chỉ nói
turn bị dừng. Đếm nó làm Lớp 3 nâng `high` sai.

Quan sát trực tiếp sau khi 0.8.0 chạy: 4/5 quyết định effort là `high` với
`reason: tool_errors:2`, phần lớn do abort.

Sửa: loại `AbortError`/`ABORTED`/`TimeoutError` khỏi `toolErrors`. Test 11t/11u:
3 lần abort → giữ `low`; 2 lỗi thật (ENOENT/EEXIST) → nâng `high`.

### Test

`tests/offline.mjs`: thêm section 17 (7 check cho `describeError`), B6b/B6c
(breaker), test dương cho Lớp 2 không có goal, và 11t/11u (abort vs lỗi thật).
Tổng **196 check pass**, 3/3 lần chạy ổn định. `verify.sh` TẤT CẢ MỤC PASS.

## [0.8.0] — 2026-10-01

Đổi CƠ CHẾ cho hai lớp nóng, sau khi đo lại trên log thật và corpus 11.349 lệnh
bash. Mục tiêu: bớt "vẽ việc", tăng tốc vòng lặp.

### Đổi — Lớp 3 bỏ classifier per-request, thay bằng luật tất định sticky theo turn

**Vấn đề đo được** (120 request liên tiếp, 8 session thật):

| | |
|---|---|
| Đổi mức `low↔high` | **113/120 lần** (dãy `low,high,low,high,…`) |
| Quyết định `applied` có confidence < 0,5 | **54,5%** |
| Chiếm token Jev | **55%**, mỗi call ~281ms TRÊN đường tới hạn |

Tức lớp tốn kém nhất đang đổi một quyết định gần như ngẫu nhiên. Cả "lease"
(Jev trả 1 ở 97% lần) lẫn ngưỡng confidence đều là máy móc che một tín hiệu
không có thật.

**Thiết kế mới.** Mặc định `effortDefault` (low); nâng `effortEscalateTo` (high)
CHỈ khi turn trước có bằng chứng thất bại ĐO ĐƯỢC (`turnSignals`: ≥2 tool error
hoặc ≥1 test fail). Sticky trong turn, sang turn mới mới tính lại. **KHÔNG gọi
Jev** — hết 6.363 call/3,5 ngày.

Research xác nhận: tín hiệu đo được thắng tín hiệu "đoán độ khó"
(arXiv 2505.00127, 2608.13571); router per-step chỉ thắng khi là model nhỏ đã
TRAIN (<5ms, arXiv 2603.07915), không phải API classifier 1.180 token.

Bỏ hẳn: `effortReuseConfidence`, `effortMaxReuseSteps`, `recentToolCalls()`,
`toolCallCount()`, `collectProgress()`, `effortQuestion`. Thêm config:
`effortDefault`, `effortEscalateTo`, `effortEscalateToolErrors`,
`effortEscalateTestFailures`. Log ghi `reason` + `signals` + `decision: sticky`.

### Đổi — Lớp 1 prefilter nhận thêm `curl` GET / `node --check` / `dsh` đọc

Phủ trên 11.349 lệnh thật: **39,2% → 42,1%** (+330 lệnh không cần gọi Jev).

Ba luật mới, mỗi luật **chứng minh được** là chỉ-đọc:

- `curl` — **allowlist** (xem mục "curl chuyển sang ALLOWLIST" bên dưới). Nhóm
  lớn nhất: 220/835 lệnh `curl` thật được rút ngắn.
- `node --check` — chỉ phân tích cú pháp; loại nếu kèm `-e`/`-p`/`-r`/`--import`.
- `dsh plugin list` / `dsh --version` / `dsh --help` — loại mọi subcommand khác.

**Một con số trong brief trước đã SAI và được sửa.** Brief nói prefilter có thể
giành lại **−38%** call gate bằng cách xử lý `python3 -c`/`node -e`/vòng `for`.
Sai: **không thể chứng minh** một one-liner Python/Node tuỳ ý là chỉ-đọc — phân
tích code động là không khả thi và đoán bừa là lỗ hổng gate. Số đúng là **10,2%**
nếu chỉ tính luật an toàn chứng minh được; phần lớn là `curl` GET.

Corpus test mở rộng: **287 lệnh phá dữ liệu** (0 lọt) + **106 lệnh chỉ-đọc**
(phải nhận ra), gồm cả các dạng vừa thêm (`curl -XPOST`, `curl -Tf`,
`node --check --eval`, `dsh plugin add`).

### Sửa — Lớp 2 truyền `signal` đã abort xuống Jev

`agent/turn-stopping` chạy ĐÚNG LÚC turn đang dừng nên `signal` của nó đã abort.
Truyền vào `AbortSignal.any` làm fetch bị huỷ tức thì. Đo log thật: **48/49** lần
fail là `This operation was aborted` (cửa sổ 28/09 07:43→08:55). Bỏ `signal`
khỏi lời gọi; lớp dùng ngân sách riêng `stopTimeoutMs`.

### Thêm — Observability

- Bản ghi `allow` của gate **ghi kèm `command`** (cắt 400 ký tự). Trước đây chỉ
  có `{tool, decision, p}` nên không thể audit cái gì đã cho qua — chỉ đếm được
  số lượng. Không có nó thì không đo được FNR thật của gate.
- Ghi chú: `completion_check` không chạy lần nào từ 29/09 vì plugin yêu cầu
  `agent.goal.objective`, mà operator gần như không dùng goal (8 lần
  `goal/change` trong 162 session). Xem mục "Điểm yếu đã biết".

### Test

`tests/offline.mjs`: section 11 viết lại 16 check cho thiết kế mới (KHÔNG gọi
Jev, mức đúng theo tín hiệu, sticky, tách session, log có `reason`/`signals`);
section 16 thêm corpus cho ba luật prefilter mới. Tổng **176 check pass**, 8/8
lần chạy ổn định (một test cũ kiểm thứ tự dòng log đã sửa thành kiểm theo tập
hợp — recorder ghi fire-and-forget nên thứ tự không đảm bảo).

`verify.sh`: TẤT CẢ MỤC PASS (gồm gate chấm đúng trên API thật).

### Sửa — 7 dạng `curl` LỌT qua bản prefilter đầu tiên (lỗ hổng do bản vá tự tạo)

Bản `curlIsReadOnly` đầu tiên so cờ dài bằng khớp TOÀN CHUỖI (`^--flag$`), nên
không khớp dạng `--flag=value`. Tìm ra bằng cách **thử thật từng biến thể**, không
phải bằng cách đọc code — đúng bài học đã ghi ở v0.6.0 ("bản viết bằng cách đọc
code để lọt 12 dạng").

Bảy dạng đã lọt, giờ đều bị chặn:

```
curl --output=/tmp/leak http://x     # dạng --flag=value
curl --json {"a":1} http://x         # --json gửi POST
curl --form-string f=@secret http://x
curl --upload-file=f http://x
curl --remote-name-all http://x/y
curl --request=POST http://x
curl --config=cfg http://x
```

Sửa: khớp TIỀN TỐ cho cờ dài (`^--(output|json|form|upload-file|request|config|
trace|dump-header|output-dir|create-dirs|…)`), nên bắt cả `--flag` lẫn
`--flag=value`; thêm `--trace-ascii`, `--dump-header`, `--output-dir`,
`--create-dirs` vào danh sách. `-o /dev/null` và `--output /dev/null` vẫn được
cho qua (vứt output, không ghi gì thật).

Bảy dạng này đã vào corpus chống hồi quy của `tests/offline.mjs`.

### Thêm — Cảnh báo khoá config đã bỏ

`schemastery` bỏ qua khoá lạ một cách im lặng, nên người dùng còn đặt
`effortReuseConfidence: 0.9` sẽ tưởng nó vẫn có tác dụng. Giờ plugin ghi một bản
ghi `retired_config` + `logger.warn` một lần lúc nạp, nói rõ khoá nào bị bỏ và
thay bằng gì. Test 8b kiểm điều này.

### Sửa — hai lỗi thật trong chính Lớp 3 mới, tìm được ngay sau khi restart

Cả hai đều thuộc loại "chạy thật mới lộ", và cả hai đều làm Lớp 3 **nâng effort
vô cớ** — đúng thứ thiết kế này sinh ra để tránh.

**1. Chữ `FAIL` trong nội dung file bị tính là test fail.**

Bản đầu quét text của MỌI `tool/result` để tìm chữ `FAIL`, không kiểm LỆNH nào
sinh ra output. Khi agent `cat` một file test, `grep` trong log, hay đọc output
cũ, chữ `FAIL` trong NỘI DUNG bị tính là test fail.

Đo trên 1.791 `tool/result` thật: **46 khớp, và 46/46 là false positive (100%)**
— không lần nào là test fail thật. Quan sát trực tiếp sau restart: một turn đọc
file test bị chấm `reason: test_failure:6` và đẩy lên `high`.

Sửa: thêm `TEST_RUNNER_PATTERN` — CHỈ tính khi chính lệnh sinh ra output là
trình chạy test (`node --test`, `npm test`, `pytest`, `go test`, `cargo test`, …).
Chữ `FAIL` trong output của `cat`/`grep` không nói gì về việc code có đúng không.

**2. Phép nối `tool/result` ↔ `tool/call` đọc SAI field — hỏng 100%.**

`toolCallId` nằm trong `data.message.toolCallId`, KHÔNG phải `data.toolCallId`.
Bản đầu đọc `data.toolCallId` nên luôn `undefined`: đo trên 1.791 `tool/result`
thật, **0/1.791 nối được (0%)** → tính năng im lặng không làm gì cả.

Đây đúng loại lỗi "đọc sai field thì thất bại im lặng" đã ghi ở đầu repo (xem
mục "Ba API đã đoán sai"). Sửa: đọc `message.toolCallId`, dự phòng
`message.source.callId`.

Sau khi sửa: **1.791/1.791 nối được (100%)**, và 46 false positive → **0**.
Trên dữ liệu thật của máy này hiện **0 true positive** — nghĩa là Lớp 3 hầu như
sẽ giữ `low`, đúng như thiết kế (không nâng effort khi không có bằng chứng).

Ba test chống hồi quy mới (11o/11p/11r/11s) dùng ĐÚNG shape thật của session,
không phải shape thuận tiện — nếu ai đổi lại thành `data.toolCallId` thì FAIL.

### Sửa — `curl` chuyển sang ALLOWLIST (lần sửa thứ ba, hai lần trước đều lọt)

Hai bản trước liệt kê cờ NGUY HIỂM. Cả hai đều lọt, và mỗi lần chỉ thử thật mới thấy:

| Bản | Cách làm | Lọt |
|---|---|---|
| 1 | so `^--flag$` | không khớp `--flag=value` → **7 dạng** |
| 2 | khớp tiền tố | `-D` (ghi header file), `-c`/`--cookie-jar` (ghi cookie jar), `--libcurl` (ghi C source), `-w '%output{file}'` (ghi file), `--stderr`, `--etag-save` → **6 dạng nữa** |

`curl` có **hơn 200 cờ** và mỗi phiên bản lại thêm. Denylist không bao giờ đầy.

**Đảo thành allowlist.** Chỉ-đọc khi MỌI token là URL, hoặc cờ nằm trong allowlist
(chỉ cờ đổi CÁCH GỬI/CÁCH IN, không cờ nào mở đường ghi), hoặc giá trị của cờ đó.
Cờ LẠ → `false` → đi qua Jev.

Kiểm chứng: **43 cờ nguy hiểm bị chặn, 15 dạng hợp lệ qua**. Corpus test:
**306 lệnh phá dữ liệu (0 lọt)**, 111 lệnh chỉ-đọc (nhận hết).

Đánh đổi đo được: phủ trên 11.349 lệnh thật **42,5% → 42,1%** (−0,4%). Mất 45
lệnh để đổi lấy một luật không thể lọt thêm cờ mới — đúng hướng.

`-o /dev/null` giờ KHÔNG qua: allowlist loại mọi `-o` cho đơn giản, thay vì thêm
một nhánh đặc cách dễ sai. `-w` cũng bị loại (`%{json}` in stdout nhưng
`%output{file}` ghi file — phân biệt hai dạng này đòi phân tích chuỗi, đúng kiểu
phân tích dễ sai).

**Bài học ghi lại:** đây là lần thứ ba trong repo này một bản vá viết bằng cách
suy luận từ danh sách cờ để lọt dạng mới. Cách duy nhất tìm ra là **thử thật
từng biến thể** — không phải đọc code.



## [0.7.0] — 2026-10-01

Hai lỗi thật tìm được bằng cách **đo log và chạy thử**, không phải đọc code. Cả
hai đều thuộc loại "test xanh nhưng hành vi sai".

### Sửa — Lớp 8 vứt bỏ kết quả của `jg` vì mã thoát 2

**Lỗi.** `jg` dùng exit code để nói mức ĐẦY ĐỦ, không phải thành/bại. Đọc thẳng
`dist/bin/index.js` của `jg@0.3.1`:

```js
process.exitCode = result.status === "interrupted" ? 130
                 : result.status === "incomplete" ? 2 : 0;
status: input.signal.aborted ? "interrupted"
      : issues.size ? "incomplete" : "complete"
```

Exit **2 = `incomplete`** nghĩa là có `issues` (thường là `resource_limit`), chứ
output vẫn được render **đầy đủ và hợp lệ**. Bản trước coi MỌI exit ≠ 0 là thất
bại và vứt toàn bộ output.

**Bằng chứng đo được.** Log thật ghi **4/4 lần leo thang đều `fail_open: jg
exited 2`** — 100% thất bại. Tôi tái hiện lại trên thư mục thật: `jg` trả **421
dòng / 23.448 bytes** (11 file liên quan + excerpt verbatim) rồi thoát 2. Đúng
thứ Lớp 8 sinh ra để cung cấp, mà bị vứt đi chỉ vì mã thoát.

**Tổng chi phí bị đốt:** 6 lần leo thang × 5–15s = **58,9 giây** không thu được gì.

**Sửa.** Chấp nhận cả exit 0 và exit 2 miễn là có output; `interrupted` (130) và
lỗi thật vẫn fail-open. Test B7b dựng `jg` giả thoát 2 kèm output đầy đủ và yêu
cầu gợi ý ĐƯỢC chèn; tiêm lại bug → FAIL.

### Sửa — Trạng thái "lần cuối thấy" là singleton toàn cục, rò giữa các agent

**Lỗi.** `lastSeenSession` / `lastSeenGoal` / `lastSeenPrompt` là biến
**module-level** (`let lastSeenSession`), tức một singleton dùng chung cho MỌI
agent. DSH chạy nhiều agent cùng lúc — `dsh-experimental-agent-team` có trong
profile và `subagent` được dùng thật — nên agent này ghi đè trạng thái của agent
kia.

**Bằng chứng đo được.** Trong dãy `effort_route` của log thật, `turn` **giảm 291
lần** (14 → 1 → 14 → 1) — dấu hiệu hai agent xen kẽ nhau. Mỗi lần xen kẽ, hook
của agent A có thể đọc `lastSeenPrompt`/`lastSeenGoal` do agent B ghi, tức hỏi
Jev về **task của agent khác**.

**Mức hại thật (đo, không phóng đại):**

| Đường | Bị ảnh hưởng? | Bằng chứng |
|---|---|---|
| `workspaceRootOf` (root repo) | **Không** | ưu tiên `agent.session.header.cwd` trước → root vẫn đúng |
| Lớp 3 tái dùng effort | **Không** | guard `prev.turn === turn` chặn: 0/291 lần reuse sai |
| Task text gửi Jev | **CÓ** | `pre_step` / `failure_recovery` / `jevgrep_escalation` hỏi về task của agent khác |

**Sửa.** State keyed theo session (`sessionKeyOf`), có fallback theo agent id rồi
theo chính đối tượng session (WeakMap) cho đường không có id. Giữ trần
`evictOldest`. Test 11j dựng hai agent, nạp task khác nhau, rồi đọc **thân
request thật** gửi Jev và yêu cầu đúng task của agent gọi; tiêm lại bug (trả một
khoá chung) → FAIL đúng thông điệp "LẪN task của agent B".

### Sửa — lỗ hổng an toàn `>&`: prefilter bỏ qua lệnh GHI ĐÈ file

**Lỗi (nghiêm trọng nhất trong bản này).** Bash cho `>&` hai nghĩa:

```
cmd >&2       — nhân bản fd 2 (an toàn)
cmd >& file   — chuyển stdout+stderr tới FILE, GHI ĐÈ file đó
```

`splitSegments` cho `>&`/`<&` qua như "dup fd vô hại" **không kiểm token theo
sau**, nên `echo new >& victim.txt` được coi là chỉ-đọc và **bỏ qua Jev hoàn
toàn**. Đã tái hiện bằng shell: nội dung file bị xoá.

**Vì sao test cũ không bắt.** Corpus có `'cmd >& out'` — nhưng `cmd` là lệnh lạ
nên bị loại vì **lý do khác**, che mất lỗ hổng. Đây đúng ca "test xanh, logic
sai". Corpus mới dùng lệnh chỉ-đọc thật (`echo`/`ls`/`cat`/`printf`).

**Sửa.** `>&`/`<&` chỉ qua khi token theo sau là **số** (fd). `2>&1` vẫn qua
đúng vì tokenizer gộp nó thành `>&` với target `1`. Corpus: 248 lệnh phá dữ liệu
(0 lọt) + 87 lệnh chỉ-đọc, gồm 6 case `>&` ghi file và 5 case `>&` nhân bản fd.

### Sửa — quyết định effort key theo `route`, dùng chung giữa các agent

`lastDecision` key chỉ theo `route` (provider/model). Agent chính và subagent
thường dùng CÙNG model ⇒ cùng route ⇒ dùng chung state, nên subagent đọc
`prev.toolCallCount` của agent chính (con số thuộc session khác) và có thể tái
dùng mức effort của agent kia. Sửa: key theo `sessionKey + route`. Test 11l; tiêm
lại bug → FAIL.

### Sửa — trần theo-turn dùng chung giữa agent chính và subagent

`hintedTurns` (Set) và `failuresSeen` (Map) key theo `turn` TRẦN. Cả hai agent
đều đánh số turn từ 1, nên `turn = 1` của subagent trùng agent chính: gợi ý của
subagent bị nuốt, ngân sách phục hồi chia chung. Sửa: dùng `agentTurnKey()` chung
(đã tách theo session). Test 11m; tiêm lại bug → FAIL.

### Sửa — eviction là FIFO, đẩy ra session ĐANG hoạt động

**Lỗi.** `evictOldest` xoá từ ĐẦU Map, mà Map giữ thứ tự chèn ⇒ chính sách là
**FIFO**. Một session đang làm việc nhưng được chèn sớm vẫn bị đẩy ra trước một
session đã chết vừa được chèn.

**Bằng chứng đo được.** Tái hiện: agent A nạp task, 250 session khác đi qua xen
kẽ với A. Với FIFO, task của A biến mất — request gửi Jev mang `task="Unknown
task"`. Với LRU, task còn nguyên.

**Sửa.** `seenFor()` chạm entry đang dùng (`delete` + `set` để đưa về cuối Map).
Tách `seenEntryOf()` cho đường ĐỌC. `sessionOf()` đọc thẳng `agent.session` thay
vì tra Map — engine luôn fuse session vào payload, tra Map chỉ thêm phụ thuộc mà
không thêm thông tin. Test 11k; tiêm lại FIFO → FAIL.

### Thêm — log ghi danh tính session (đo được per-agent)

Audit trên **23.045 dòng log thật** cho thấy **không dòng nào có `sessionId`**,
nên không thể trả lời "hook X hiệu quả với agent nào" hay xác minh rò state chéo
agent — đúng câu hỏi quan trọng nhất. Mọi bản ghi quyết định nay kèm trường
`session` (khoá rút gọn, không ghi nội dung session). Test 11n; tiêm lại bug
(bỏ trường) → FAIL.

### Sửa — 19/23 bản ghi thiếu danh tính session (lỗi do bản vá observability gây ra)

**Lỗi.** Khi thêm tham số thứ hai cho `record()`, tôi chỉ vá **một phần** call
site. Kiểm bằng script đếm: **19/23** bản ghi không truyền `agent` — trong đó có
toàn bộ nhánh `deny`/`auth_fail_closed`/`allow_authorized` của gate, tức nhánh
**quan trọng nhất** (lệnh phá dữ liệu bị chặn) lại không đo được per-agent.

**Vì sao test đầu không bắt.** Test 11n chỉ chạy nhánh `applied` của
`agent/request`. Nhánh deny cần **hai** lời gọi Jev (destructive → authorization),
mà test không chạm tới.

**Bài học phương pháp.** Đọc code đã bỏ sót 19 chỗ; phải **chạy nhánh thật rồi
soi log**. Test 11o dựng đúng đường deny và yêu cầu mọi bản ghi có `session`.

**Sửa.** Truyền `agent` cho mọi bản ghi có agent trong scope (gate, phục hồi,
hoàn thành, effort, review). `jev_ok`/`jev_error` nằm trong `jev-client.mjs`
(client dùng chung) nên thêm tham số `agent` tuỳ chọn cho `evaluate()`, và truyền
từ cả 6 call site.

**Một bẫy nữa bắt được khi viết test:** `createJev` **chụp**
`globalThis.fetch` lúc được tạo, nên gán `fetch` sau `loadPlugin()` không có tác
dụng — client vẫn dùng fetch thật và mọi lời gọi fail_open, khiến test "xanh" mà
không chạm được nhánh cần kiểm. Phải cài `fetch` TRƯỚC `loadPlugin()`.

`boot` là bản ghi mức plugin, không thuộc agent nào — miễn trừ có chủ ý.

### Thêm — SÀN TẤT ĐỊNH cho lệnh phá huỷ toàn hệ thống (`lib/catastrophic.mjs`)

**Lỗ hổng thiết kế.** Gate dựa hoàn toàn vào Jev, mà Jev **fail-open**: đo trên
log thật, **252/6.442 lần (3,9%)** gọi Jev thất bại (144 timeout, 63 abort) và
lệnh đi thẳng không được kiểm. Với một guard an toàn thì đó là lỗ hổng — API lỗi
nghĩa là `rm -rf /` chạy.

Tài liệu `jev-1.13` cũng nói state gửi vào có thể bị viết để lái câu trả lời, nên
lớp phán đoán **không được** là thứ cuối cùng chắn giữa input không tin cậy và
hành động không hoàn tác được. `dsh-jev-tools` và `dsh-jev-verify` đều áp dụng
nguyên tắc này: blacklist tất định chạy TRƯỚC, Jev chỉ phán đoán phần còn lại.

**Sàn.** `catastrophicMatch()` — thuần cú pháp, **không mạng, không Jev, không
I/O**, nên không có đường fail-open. Chặn 7 nhóm: `rm` từ gốc filesystem, `mkfs`/
`wipefs`/`blkdiscard`, `dd of=/dev/<block>`, redirect vào thiết bị khối, fork
bomb, `chmod -R 777 /`, `mv /* /dev/null`.

**Cố ý HẸP.** `rm -rf /tmp/x`, `rm -rf node_modules`, `rm -rf ./build`,
`dd of=/tmp/x` vẫn qua bình thường — sàn không được thành chướng ngại cho việc
hợp lệ.

**Hai test cũ mã hoá chính lỗ hổng này.** Cả `offline.mjs` (1b) và
`live-check.mjs` đều dùng `rm -rf /` để kiểm "abort → allow". Tức chúng khẳng
định một lệnh xoá cả ổ đĩa được cho qua chỉ vì signal đã abort. Đã tách thành hai
case: lệnh thường + abort → allow; lệnh phá huỷ + abort → **VẪN CHẶN**.

**Kiểm chứng quan trọng nhất:** dựng Jev chết hoàn toàn (fetch ném lỗi + key store
hỏng) → sàn **vẫn chặn** `rm -rf /`, `rm -rf /*`, `dd of=/dev/sda`, `mkfs`. Đây
là bất biến chứng minh lỗ hổng fail-open đã đóng.

Config: `enableCatastrophicFloor` (mặc định true).

### Ghi nhận — kiểm chứng bên ngoài xác nhận nghi ngờ về lớp guard

Khảo sát tài liệu công khai (không phải ý kiến): các failure mode của lớp
guard/judge dùng LLM **đã được đo lặp lại nhiều lần** — ICLR 2025 (self-critique
làm sập performance; chỉ verifier có ground-truth mới giúp), arXiv 2507.08794
("master keys" lừa judge, FPR 60–90%), arXiv 2603.06621 (PRM chỉ là fluency
detector: PRM >0.9 trong khi accuracy <4%), METR 2025-06-05 (30,4% run hack).

Và A/B test công khai của `zhangxaochen/dsh-jev` trên 20 task DeepSWE: **2 thắng ·
2 thua · 13 hoà, −1.10pp** — không phát hiện lợi ích, nhiễu cùng-arm tới 55pp.

**Kết luận áp vào plugin này:** các lớp guard ở đây hoạt động ĐÚNG như thiết kế
(đếm được, fail-open, không false-positive), nhưng **chưa có bằng chứng nào cho
thấy chúng cải thiện kết quả cuối**. Điều đó không phủ nhận giá trị kỹ thuật —
nó chỉ có nghĩa: đừng kỳ vọng điểm số tăng, và hãy đo trên task của chính mình.

## [0.6.1] — 2026-10-01

### Sửa — thêm trần chuỗi tái dùng effort (đo sau khi fix guard)

Sau khi sửa guard mù, đo lại mới thấy fix đó **làm TĂNG chi phí**, không giảm:

| | Token |
|---|---|
| P1 prefilter tiết kiệm | −1.549.688 |
| P4 guard fix thêm | **+3.700.676** |
| **NET** | **+2.150.988** |

**Vì sao.** Bug cũ làm guard mù → 83% số lần reuse là "tái dùng mù" (miễn phí
nhưng giữ effort sai 32–41% số lần). Fix làm guard tỉnh → hỏi Jev mỗi khi có
tool call mới → +268ms/step, turn 50 step tốn thêm ~13s.

**Cân bằng.** Thêm `effortMaxReuseSteps` (mặc định **20**): giữ độ chính xác ở
đoạn đầu turn — nơi effort thật sự thay đổi — mà không hỏi lại ở đoạn cuối turn
đã ổn định. Đo phân bố chuỗi tái dùng thật:

| Chặn tối đa | Reuse giữ | Token thêm |
|---|---|---|
| Không trần | 2.212 | +3.700.676 |
| **20** | **1.116** | **+1.833.608** |
| 10 | 723 | +2.491.097 |

Chọn 20: giữ 1.116 lần tái dùng hợp lệ, tiết kiệm ~1,8M token so với bỏ hẳn.
Đặt 0 để tắt tái dùng hoàn toàn.

**Bài học ghi lại:** một fix đúng về *logic* vẫn có thể sai về *chi phí*. Phải
đo lại sau khi fix, không chỉ đo trước.

### Thêm — `reuseSkipReason`: đo được vì sao KHÔNG tái dùng effort

Trần `effortMaxReuseSteps` vừa thêm nhưng **không kiểm chứng được bằng log**:
cả bốn nguyên nhân không tái dùng (turn mới, có tool call mới, chạm trần,
confidence thấp) đều rơi vào cùng một dòng `applied`, không phân biệt được.
Nghĩa là không thể trả lời "trần 20 có thật sự chặn gì không" trên máy thật.

Thêm trường `reuseSkipReason` vào bản ghi `applied`, một trong:
`no_prior_decision` · `new_turn` · `new_tool_call` · `reuse_cap_reached` ·
`confidence_below_threshold` · `effort_unsupported`.

Test 11i dựng 4 step (chấm đầu → tái dùng → chạm trần → turn mới) với trần 1 và
đọc thẳng `decisions.jsonl`, yêu cầu phân biệt được cả ba lý do. Kiểm chứng
ngược: bỏ trường này → test FAIL.

## [0.6.0] — 2026-10-01

### Thêm — prefilter chỉ-đọc cho Lớp 1 (cắt phần lớn call Jev của gate)

**Vì sao.** Đo trên log thật `decisions.jsonl` (2026-09-27 → 09-30), phân bố
theo lớp:

| Lớp | call | input token | % token | avg/call | p50 |
|---|---|---|---|---|---|
| `effort_route` | 3.343 | 5.597.126 | **55%** | 1.674 | 268ms |
| `destructive_gate` | 5.600 | 4.024.561 | **40%** | 718 | 289ms |
| `pre_step` | 142 | 445.395 | 4,4% | 3.136 | 362ms |
| còn lại | 123 | 79.130 | 0,8% | — | — |

Trong 5.600 call của Lớp 1, **80,7%** có `p ≤ 0.02` — Jev trả "chắc chắn không
phá gì". Tức phần lớn là round-trip API để nghe lại điều suy ra được bằng phân
tích cú pháp cục bộ.

**Cách làm.** `lib/readonly.mjs` — tokenizer có ghi nhớ nháy, trả `true` chỉ khi
**chứng minh được** lệnh không thể ghi. Trần phủ sót đo trên **3.197 lệnh bash
thật** của máy này: **37,4%**.

Ba lần đo liên tiếp cho thấy quét regex sai theo cả hai hướng, nên bản cuối là
tokenizer thật:

| Bản | Cách làm | Phủ sót | Lỗi |
|---|---|---|---|
| 1 | quét chuỗi thô | 2,3% | `\bdsh\b` khớp đường dẫn `~/.dsh/` → giết oan 2.100 lệnh |
| 2 | tách theo vị trí | 13,7% | `>` trong nháy (`sed 's/x/=<set>/'`) tính là redirect |
| 3 | **tokenizer** | **37,4%** | — |

**Bất biến an toàn.** `tests/offline.mjs` chạy **242 lệnh phá dữ liệu** và yêu
cầu **0 lệnh được phép lọt**, cộng 384 biến thể fuzz đột biến.

### Sửa — 12 dạng lọt qua bản 0.6.0 đầu tiên

Bản đầu tiên được viết bằng cách **đọc code và suy luận**, và nó để lọt 12 dạng
lệnh. Tìm ra bằng cách chạy `--help` thật trên từng lệnh trong danh sách trắng
rồi **thử ghi file trong sandbox**, không phải bằng cách đọc lại code:

| Dạng lọt | Cơ chế |
|---|---|
| `trap "rm -f victim" EXIT` | `trap` **chạy lệnh tuỳ ý**; payload nằm trong nháy nên phép kiểm `$(...)` không bắt được |
| `hostname NEWNAME` | đối số vị trí **đặt** tên máy |
| `date 010112002026` | đối số vị trí **đặt** lại đồng hồ hệ thống |
| `xxd in out`, `uniq in out` | đối số thứ hai là file **GHI** |
| `file -C -m f` | `-C` ghi `magic.mgc` |
| `less -o f`, `more -o f` | `-o` ghi file |
| `history -w f` | `-w` ghi file history |
| `rg --pre CMD` | chạy CMD trên mỗi file |
| `fd -x CMD` | chạy chương trình tuỳ ý |
| `sort --compress-program=PROG` | chạy chương trình tuỳ ý |
| `git --ext-diff` | gọi diff ngoài |
| `set -- $(rm f)` | `$(...)` **vẫn chạy trong nháy kép** |

Ba cơ chế sửa, mỗi cái là một lớp khác nhau của cùng vấn đề:

1. **Bỏ khỏi danh sách trắng**: `trap`, `history`, `hostname`, `xxd`, `uniq`,
   `split`, `csplit`, `tee`. Đo trên 3.197 lệnh thật: nhóm này xuất hiện **0–2
   lần** mỗi cái, nên chi phí phủ sót gần bằng không.
2. **`POSITIONAL_OUTPUT_COMMANDS`**: lệnh mà đối số vị trí thứ N là file ghi
   (`uniq in out`, `xxd in out`, `hostname NEW`). Phải **đếm đối số**, không thể
   phân biệt bằng tên cờ vì cả hai dạng đều hợp lệ.
3. **`CONDITIONAL_COMMANDS.rejectFlags` theo từng lệnh**: cờ phải gắn với lệnh
   cụ thể, không kiểm chung toàn câu. `-o` ghi file với `sort`/`less` nhưng chỉ
   là "in phần khớp" với `grep -o`; `-x` chạy lệnh với `fd` nhưng là "file thực
   thi được" với `test -x`. Kiểm chung từng loại oan 68 lần dùng `export` và 36
   lần dùng `read`.

**Một hồi quy do chính bản sửa gây ra, bắt được ngay:** đưa `git` vào
`CONDITIONAL_COMMANDS` khiến `git reset --hard` được coi là chỉ-đọc, vì bảng cờ
chạy trước `gitIsReadOnly` và trả "không có cờ ghi" mà không hề xét `reset` là
nhánh ghi. Sửa bằng cách cho các lệnh có logic riêng (`git`/`sed`/`find`/`awk`/
`env`/`command`) chạy **trước** bảng cờ.

**Kiểm chứng ngược:** tiêm lại từng nhóm lỗi → test FAIL đúng nhóm đó
(`trap` → bất biến an toàn; `--output`/`-C`/`--pre` → bất biến an toàn;
bỏ đếm đối số → bất biến phủ báo sót `hostname`).

**Ba lệnh được giữ lại sau khi kiểm chứng là an toàn thật**: `od`, `strings`,
`hexdump` (mọi cách gọi chỉ ghi stdout; `strings -o` là alias của `--radix`), và
nhóm builtin `export`/`set`/`read`/`alias` (mọi đường chạy lệnh của chúng đều đi
qua `$(...)`/backtick, đã bị chặn ở tầng tokenize).

Config mới: `enableReadOnlyPrefilter` (true). Tắt để quay lại hành vi cũ.

### Sửa — guard "có thông tin mới" của Lớp 3 bị mù sau 6 tool call

**Lỗi.** `recentToolCalls()` cắt `.slice(-6)` để giới hạn payload gửi Jev, nhưng
guard tái dùng effort lại so `.length` của chính mảng đã cắt đó:

```js
const hasNewToolCall = !prev || history.length !== prev.toolCallCount;
```

Sau khi một turn vượt 6 tool call, `history.length` đứng nguyên ở **6 mãi mãi**,
nên guard không bao giờ thấy "có gì mới" nữa và tái dùng vô hạn.

**Bằng chứng trên log thật:**

- 1.700/2.080 lần `reuse_high_confidence` có `reusedFor ≥ 5` (đã qua mốc 6)
- một mức effort bị giữ **150 step liên tiếp**
- 37/40 turn (92%) có hơn 6 step

Tức **82% số lần tái dùng** diễn ra trong trạng thái guard đã mù.

**Sửa.** Thêm `toolCallCount(session)` đếm **không cắt trần**, tách khỏi
`recentToolCalls()` (vẫn cắt 6 để giới hạn payload). Test 11g dựng đúng 8 tool
call rồi thêm 1; kiểm chứng ngược bằng cách tiêm lại lỗi cũ → test FAIL.

### Ghi nhận — ba đề xuất tối ưu bị dữ liệu bác bỏ

Giữ lại để lần sau không đề xuất lại:

1. **"completionCheck fail_open 53% → tinh chỉnh"** — SAI. Cả 49 lần `fail_open`
   đều thuộc **duy nhất ngày 2026-09-28** (sự cố key/timeout). Từ 09-29 đến nay:
   **0 lần**. Không phải lỗi hệ thống, không cần đổi gì.
2. **"nâng `effortReuseConfidence` để tái dùng nhiều hơn"** — SAI. Đo lại trên
   log: `conf ≥ 0.6 → step sau giữ nguyên 59–68%`, tức 32–41% **sai**. Guard hiện
   tại đã tái dùng **mọi** step `conf ≥ 0.6` mà không có tool call mới; những lần
   `applied` ở mức conf cao chính là lúc có output mới → hỏi lại là ĐÚNG.
3. **"Lớp 5 lãng phí, cắt `contextCandidateLimit`"** — SAI. A/B thật: 12 → 6
   candidate tiết kiệm 42,5% token nhưng **mất một file migration anh em cần thiết**
   trong 1/3 case. Lớp 5 chỉ chiếm 4,4% chi phí — không đáng đổi.


## [0.5.0] — 2026-09-30

### Thêm — Lớp 8: leo thang tìm nguồn bằng `jg` (skill `jevgrep`)

**Vì sao có lớp này.** Lớp 5 liệt kê ứng viên file bằng **TÊN** (readdir BFS +
khớp token). Đo trên một session thật (`777a1746`, 2026-09-30) cho thấy nó gần
như vô dụng:

- Lớp 5 hint `weknora-dsh-setup-guide.md` ở **4 turn liên tiếp**; agent **không
  đọc file đó một lần nào** (0/4). Tên file không đủ để model tin.
- Cùng session: **152** lệnh `grep`/`find`/`rg` thô, **0** lần dùng skill
  `jevgrep` — dù nó có trong catalog với mô tả `MUST USE`.

`jg` trả về **nội dung verbatim** (file + khoảng dòng + trích nguồn), đúng thứ
Lớp 5 thiếu. Lớp 8 leo thang ở hai thời điểm, cùng một hành động:

- **A. `agent/pre-step` (step 1)** — khi task của user đọc ra là "tìm X ở đâu":
  `chỗ nào xử lý`, `tìm file nào`, `where is X handled`, `which file implements`,
  `trace this bug`. Chạy trước khi agent kịp tiêu phí lệnh nào.
- **B. `tools/post-execute`** — khi đã có `jevGrepSearchTaskThreshold` (3) lệnh
  dò tìm thô **liên tiếp** trong cùng turn. Bắt ca task không tự khai là tìm-kiếm
  nhưng thực tế agent đang mò.

**Ngưỡng 3 không phải số đoán.** Đo run dò-tìm liên tiếp dài nhất mỗi turn trên
session thật: turn tìm-kiếm (1, 3, 4, 5, 7, 8) đều **≥3**; turn trả lời ngắn
(2, 9, 10) chỉ **1**. Lệnh không phải dò tìm thì reset chuỗi.

**Vì sao không thay hẳn Lớp 5.** `jg` đo thật **~0.9s ấm / ~2.6s nguội**, cộng
vào step 1 của *mọi* turn kể cả turn không phải việc tìm kiếm. Leo thang có điều
kiện giữ turn thường rẻ.

**An toàn.** Fail-open tuyệt đối: `jg` không có trên PATH, thoát khác 0, timeout,
output rỗng → im lặng bỏ qua, việc đi tiếp. Chỉ **chèn gợi ý** kèm escape clause
("chỉ dùng nếu khớp với những gì bạn thấy; kiểm lại với file thật"), không sửa
file, không chạy gì khác. Trần `jevGrepMaxPerTurn` (1) chặn gọi lặp.

**File mới.** `lib/jevgrep.mjs` — spawn `jg`, parse output theo dấu hiệu (không
cứng theo format, có đường lui trả nguyên văn), nhận diện task tìm-kiếm và lệnh
dò tìm thô, dò `jg` trên PATH có cache.

**Config mới.** `enableJevgrepEscalation` (true), `jevGrepSearchTaskThreshold` (3),
`jevGrepMaxPerTurn` (1), `jevGrepTimeoutMs` (12000), `jevGrepExcerptCap` (4000).

**Test.** `tests/offline.mjs`: **99 → 159** check. 60 check mới cho Lớp 8, dùng
một script `jg` **giả** đặt trên PATH — không bao giờ gọi `jg` thật, nên chạy
được trong CI không có mạng lẫn không có `jg`. E2E với `jg` thật đã kiểm riêng:
chèn đúng excerpt 2 file, 2.4s qua handler thật.

### Sửa

- **`verify.sh` thiếu `lib/jevgrep.mjs`** trong mục "Cấu trúc plugin" và "Syntax".
  Bổ sung cả hai.
- **Test `enableFailureRecovery:false` đọc sai sau khi thêm Lớp 8.**
  `tools/post-execute` giờ do HAI lớp dùng (Lớp 6 và Lớp 8), nên phép kiểm
  "tắt Lớp 6 thì không có hook" phải tắt cả Lớp 8 mới cô lập được. Sửa để kiểm
  đúng ý định gốc thay vì kiểm nhầm lớp.
- **Trạng thái Lớp 8 key theo `turn` trần thay vì `agentId:turn`.** `turn` là số
  thứ tự bên trong một session, nên agent chính và mỗi subagent đều có turn 1, 2,
  3... riêng — dùng chung khoá thì subagent tiêu mất ngân sách của agent chính.
  Đúng loại lỗi Lớp 2 đã gặp và đã sửa; giờ Lớp 8 dùng cùng khoá. Kèm test.
- **`clip()` bị cài hai lần.** `policy.mjs` và `jevgrep.mjs` mỗi bên tự viết lại
  cùng phép cắt head+tail (chia 0.6/0.4, cùng chuỗi `…[omitted N chars]…`). Tách
  primitive `truncateText()` trong `policy.mjs`; `clip()` bọc nó để giữ cờ
  `truncated`, `jevgrep.mjs` import thẳng. Sửa một nơi là hết lệch.
- **Log Lớp 8 thiếu `ms` ở nhánh thoát sớm.** Năm nhánh tự dựng object `record()`
  riêng, nên `skip_*` không có `ms` — đúng chỗ cần nhất để biết vì sao lớp im
  lặng. Gom về một cửa `log()` duy nhất: `type`/`turn`/`reason`/`ms` luôn có mặt,
  mọi nhánh đều để lại dấu vết. Kèm section test "Hợp đồng log quyết định".
- **Dò `jg` không còn đẩy chuỗi qua shell.** `isJevgrepAvailable()` bản đầu gọi
  `spawn('command', ['-v', 'jg'], { shell: true })`. Không có injection (mọi tham
  số là hằng) nhưng nó vẫn là một interpreter sink cho một câu mà hệ thống file
  trả lời được. Thay bằng quét `PATH` với `access(dir/jg, X_OK)` — bỏ shell, bỏ
  một tiến trình con, kết quả tất định. (`jg` khai `os: [darwin, linux]` nên
  không cần `PATHEXT`.)
- **`map.clear()` khi state vượt 200 entry — lỗi mà Lớp 2 đã sửa, nhưng bốn nơi
  khác còn sót.** Lớp 6 và Lớp 8 (mới) dùng `clear()`, xoá sạch mọi khoá kể cả
  của turn/agent đang chạy → turn cũ fire lại (đúng lỗi đã ghi trong comment của
  Lớp 2: 16 lần fire trên cùng turn=9). Lớp 2 và Lớp 7 thì tự cài lại cùng một
  vòng FIFO bằng tay. Gom cả sáu nơi về một helper `evictOldest(map, max)` — xoá
  từ cũ nhất, giữ entry mới. Export để test trực tiếp (nó là hợp đồng chung của
  năm lớp, và chỉ chạy khi state vượt trần nên hồi quy sẽ im lặng). Kèm 7 check.

## [0.4.3] — 2026-09-30

### Sửa (tài liệu + ảnh)

- **Ảnh kiến trúc đầu README vẽ 4 chốt chặn, nhưng plugin đã có 7 lớp.**
  `assets/architecture.json`/`.png`/`.html` vẫn là bản 4 lớp (lớp 1–4), thiếu
  Lớp 1b, 2 (đổi số), 5, 6, 7. Vẽ lại toàn bộ bằng archify với 7 lớp đúng thứ tự,
  gồm cả Lớp 1b (`tools/pre-execute`, chỉ khi Lớp 1 chặn).

  Ảnh mới: 2020×1248 (2×), nền sáng, không UI chrome. Spec qua `archify validate
  --quality showcase`: **9/9 artifact checks, 0 lỗi, 0 cảnh báo**. Thêm bản HTML
  tương tác (pan/zoom, sáng/tối, tìm kiếm) và link tới nó trong cả hai README.

- **README mô tả sai Lớp 3 — còn câu `lease` đã bị bỏ ở 0.4.0.**
  Viết `choice ×2: "... giữ bao lâu?"`, nhưng câu hỏi `lease` đã bị xoá hẳn ở
  0.4.0 (xem mục 0.4.0). Sửa thành `choice` một câu. Cùng lỗi trong README.en.md
  (`choice ×2: "for how long?"`).

- **Số check trong README lỗi thời: 89 → 99.** Cả hai bản README đều ghi
  `node tests/offline.mjs # 89 check`; con số thật hiện tại là **99**.

- **README.en.md thiếu `completionMaxPerTurn`** trong khối cấu hình mẫu (thêm ở
  0.4.1 nhưng chỉ cập nhật README.md).

- **Bảng "Bảy lớp" không có số thứ tự** — thêm `1 / 1b / 2 / 3 / 4+5 / 6 / 7`
  cho khớp ảnh và mục "Kiến trúc".

- **Bảng số đo thiếu kết quả 0.4.1–0.4.2.** Bổ sung: Lớp 7 chạy thật lần đầu
  (154 dòng/3 file), Lớp 1b tìm được yêu cầu ở tin 10/25 và 18/25, nới cửa sổ
  10 tin không đủ, và bug `\b` tiếng Việt có dấu. Cập nhật mốc ngày
  `2026-09-27 → 28` thành `→ 30`.

- **Bảng số đo có dòng lặp nguyên văn.** `Handler thật + Jev thật, 12 case
  end-to-end | 12/12 đúng` và `Lớp 5+6 end-to-end | 12/12 đúng` là **cùng một
  phép đo** ghi hai lần; `Lớp 7 — handler thật + MCP thật` lặp ý với dòng
  `Lớp 7 — jev_review được gọi bao nhiêu`. Gộp lại, giữ bản có ngữ cảnh đầy đủ
  hơn. Cả hai README giờ **0 dòng bảng lặp nguyên văn** (kiểm bằng script đếm).

- **Tên lớp không nhất quán trong bảng số đo.** Dùng `Lớp quyền user` (bản cũ)
  thay vì `Lớp 1b · quyền của user` (tên chuẩn ở mục "Bảy lớp" và trong ảnh).
  Đồng bộ cả hai README.

### Kiểm chứng ở bản này

| Phép đo | Kết quả |
|---|---|
| `archify validate --quality showcase` | **9/9 artifact checks**, 0 lỗi, 0 cảnh báo |
| Spec hash khớp HTML đã deliver | `27008e8f…` — HTML sinh đúng từ spec này |
| `tests/offline.mjs` | **TẤT CẢ PASS**, 99 check |
| `verify.sh` | exit 0, 6/6 mục |

## [0.4.2] — 2026-09-30

### Sửa

- **Lớp 1b quên yêu cầu của user khi hội thoại dài — chặn oan.**

  `collectUserRequest` chỉ lấy **3 tin nhắn gần nhất** (`texts.slice(-3)`). Nếu
  user yêu cầu xoá ở tin thứ 4 trở đi, rồi vài tin khác xen vào, yêu cầu gốc
  **rơi khỏi cửa sổ** → Jev nhận `unrelated` → CHẶN dù user đã yêu cầu.

  Đây là lỗi **phân loại**, không phải lỗi cửa sổ nhỏ: quyền bị **suy đoán lại**
  từ một cửa sổ trượt ở mỗi lệnh, nên cùng một lệnh có thể cho kết quả khác nhau
  giữa các lần — đúng hiện tượng `rm -rf /tmp/gtest` bị chặn 5 lần liên tiếp.

  **Sửa.** Thay `slice(-3)` bằng `selectEvidence()` — xếp hạng theo **liên quan**
  thay vì vị trí:

  | Tín hiệu | Điểm | Vì sao |
  |---|---|---|
  | Token khớp giữa tin nhắn và lệnh sắp chạy | +10 / token | Mạnh nhất: tin nhắc đúng đường dẫn thì liên quan |
  | Có động từ xoá (`rm`/`xoá`/`delete`/`dọn`…) | +3 | Yếu, chỉ phân biệt trong nhóm đã khớp |
  | Recency | +0..1 | Chỉ phá hoà, không lấn át hai tín hiệu trên |

  Ba tin được chọn rồi **sắp lại theo thứ tự thời gian** để Jev đọc mạch liền.

  **Đo được** (Jev API thật, hội thoại 25 tin):

  | Yêu cầu xoá ở | `slice(-3)` cũ | `selectEvidence` mới |
  |---|---|---|
  | tin 10/25 | `unrelated` → CHẶN | **`authorized` → CHO CHẠY** |
  | tin 18/25 | `unrelated` → CHẶN | **`authorized` → CHO CHẠY** |
  | tin 22/25 | `authorized` | `authorized` |

  Nới cửa sổ (`slice(-10)`) **không giải được** — vẫn chặn ở tin 10/25. Hội
  thoại dài bao nhiêu cũng có giới hạn, nên phải tìm theo **nội dung**, không
  theo **vị trí**.

  **An toàn không đổi.** `selectEvidence` chỉ **sắp xếp**, không mở rộng nguồn.
  Tầng lọc `source.kind === 'user'` chạy **trước** nó, nên nội dung dán vào không
  tới được đây. Đo lại 3 case injection (`quoted` ×2, `unrelated` ×1):
  **0/3 leak** — không hồi quy.

  Vì sao KHÔNG xây "sổ quyền" (grant store) như bản nháp: session log **đã là**
  store bền, có thứ tự, có provenance (`seq`), và `collectUserRequest` vốn đã
  duyệt qua nó. Thêm store thứ hai chỉ để lưu thứ đã nằm trong store thứ nhất.
  Bug thật là **cách truy xuất** (ném đi 99% bằng chứng rồi bắt Jev đoán lại),
  không phải **thiếu nơi lưu**. Sửa đúng chỗ đó tốn ~40 dòng thay vì một tầng
  state mới phải đồng bộ, hết hạn, thu hồi.

- **`DELETE_HINT` trượt tiếng Việt có dấu — phát hiện ngay sau khi vá.**

  Bản vá xếp hạng dùng `\b` cho biên từ:

  ```js
  /\b(rm|unlink|rmdir|xoá|xóa|delete|remove|dọn|dẹp|clean|wipe|purge)\b/iu
  ```

  `\b` của JS chỉ hiểu **ASCII word char**. `xóa` kết thúc bằng `a` (ASCII) nên
  khớp, nhưng **`xoá` kết thúc bằng `á` (non-ASCII, không phải `\w`) nên TRƯỢT**
  — bỏ sót đúng cách viết phổ biến nhất. Cùng lỗi với `dẹp`, `xoá` ở giữa câu…

  **Sửa.** Lookaround Unicode thay `\b`:

  ```js
  /(?<![\p{L}\p{N}_])(rm|unlink|rmdir|xoá|xóa|…)(?![\p{L}\p{N}_])/iu
  ```

  `\p{L}` phủ mọi chữ cái Unicode, nên `xoá` và `xóa` đều khớp; `form`/`firm`
  vẫn không khớp oan.

  **Vì sao test cũ không bắt được:** test 6d dùng yêu cầu có path đầy đủ, nên
  token-path khớp **+60** lấn át hẳn `DELETE_HINT` **+3** — regex trượt mà test
  vẫn xanh. Thêm test 6f cô lập tín hiệu: tin nhắn **chỉ có động từ**, không
  token nào khớp command, và >3 tin để `limit=3` thực sự phải lọc.

  Kiểm chứng ngược: tiêm lại `\b` → **FAIL** đúng case `xoá`; khôi phục → pass.

### Kiểm chứng ở bản này

| Phép đo | Kết quả |
|---|---|
| `tests/offline.mjs` | **TẤT CẢ PASS** (thêm 3 check: tin 10, tin 22, chống injection; +5 check `DELETE_HINT`) |
| E2E Jev API thật — yêu cầu ở tin 10/18 | `unrelated` → **`authorized`** |
| E2E Jev API thật — 3 case injection | **0/3 leak** |
| Test bắt bug `\b` (tiêm lại) | **FAIL** case `xoá` — test có hiệu lực |
| `verify.sh` | exit 0, 6/6 mục |
| **Lớp 7 chạy thật lần đầu** | `decision:"reviewed"`, 154 dòng, 3 file |

## [0.4.1] — 2026-09-30

### Sửa

- **LỚP 7 chưa từng chạy một lần nào — sai hợp đồng `workspaceChanges.diff`.**
  Đây là bug nghiêm trọng nhất kể từ khi plugin ra đời, và nó **âm thầm**: lớp
  vẫn fire, vẫn ghi log, chỉ không bao giờ gọi `jev_review`.

  **Bằng chứng đo được** trên log thật (`~/.local/share/dsh-jev-gate/decisions.jsonl`,
  16.905 dòng): Lớp 7 fire **66 lần** — `skip_no_changes` 51, `skip_empty_diff` 15 —
  và **`decision: "reviewed"` xuất hiện đúng 0 lần**. Toàn bộ mục đích của lớp
  ("có tool không bằng tool được dùng") không đạt được.

  **Nguyên nhân.** `buildTurnDiff` đọc `summary.files[index].seq`:

  ```js
  // bản 0.4.0 — SAI
  fileDiff = await service.diff(session.id, summary.files[index].seq ?? 0, index);
  ```

  Nhưng `WorkspaceChangedFile` của `dsh-workspace-changes@0.2.0-rc.2` **không có
  field `seq`** — `changedFile()` chỉ sinh `path/display/added/deleted/binary/oversized`.
  Nên biểu thức luôn là `undefined ?? 0` → `service.diff(id, 0, index)`. Provider
  tra `records.get(0)`, không có record nào ở seq 0, trả `undefined` →
  `renderFileDiff` trả `''` → `diff.trim()` rỗng → `skip_empty_diff`.

  `seq` cần dùng là seq của **event** `workspace/changes`, mà `workspaceSummaryOf`
  đã có sẵn nhưng ném mất khi `return service.summary(session.id, seq)`.

  **Sửa.** `workspaceSummaryOf` giờ trả `{ summary, seq }` (seq của event);
  `buildTurnDiff` nhận `eventSeq` qua tham số và truyền thẳng vào `service.diff`,
  kèm `signal` để huỷ được:

  ```js
  // bản 0.4.1 — ĐÚNG
  fileDiff = await service.diff(session.id, eventSeq, index, signal);
  ```

  Kiểm chứng: tái hiện trên provider thật (files không `seq`) trước sửa cho
  `diff.length = 0`; sau sửa cho `diff.length = 52` với nội dung unified-diff đúng.

- **Test cũ che chính bug trên.** `tests/offline.mjs` tự thêm `seq: 100 + i` vào
  `fileList`, và mock `diff` bỏ qua tham số `_seq`, luôn trả diff. Nghĩa là dù
  gate truyền sai seq (0), 89 check vẫn xanh.

  Sửa mock bám đúng hợp đồng provider: `fileList` **không còn `seq`**, và `diff`
  **trả `undefined` khi seq không khớp `CHANGES_EVENT_SEQ`**. Đã kiểm chứng
  ngược: tiêm lại bug cũ vào `lib/index.mjs` → **5 check FAIL** (trước đây pass
  hết); khôi phục bản vá → pass. Mock mới thực sự bắt được bug.

- **LỚP 2 không có trần số lần chạy trên mỗi turn.** Log thật: turn=9 fire **16
  lần liên tiếp**, Jev lần nào cũng trả `complete=0.1`, **không lần nào accept** —
  chỉ tốn tiền và chèn 16 lời nhắc giống nhau vào context. Lớp 6 có
  `failureMaxPerTurn`, Lớp 7 có `reviewMaxPerTurn`, Lớp 2 không có gì.

  Thêm `completionMaxPerTurn` (mặc định **2**). Khoá dedup gồm `turn`, nên turn
  mới vẫn có ngân sách riêng — trần không cản tiến độ thật.

- **`Map.clear()`/`Set.clear()` khi >200 entry làm turn cũ fire lại.** Cả Lớp 2
  và Lớp 7 đều dùng `if (size > 200) clear()` — một session spawn nhiều subagent
  đẩy kích thước tới 200 nhanh, `clear()` xoá **sạch**, và turn cũ có khoá mới
  nên fire lại. Đổi sang xoá **theo thứ tự chèn** (Map giữ thứ tự) đúng số lượng
  vượt trần. Đây là lời giải thích khả dĩ nhất cho 16 lần fire trên turn=9.

### Kiểm chứng ở bản này

| Phép đo | Kết quả |
|---|---|
| `tests/offline.mjs` | **TẤT CẢ PASS** (thêm 2 check cho `completionMaxPerTurn`) |
| Test bắt được bug (tiêm lại bug cũ) | **5 check FAIL** — mock mới có hiệu lực |
| `verify.sh` | exit 0, 6/6 mục |
| Tái hiện Lớp 7 trên provider thật | trước: `diff.length=0` · sau: `diff.length=52` |

## [0.4.0] — 2026-09-28

### Đổi (phá vỡ tương thích: cơ chế lease bị thay)

- **LỚP 3 — thay cơ chế lease bằng tái dùng theo confidence.** Lớp 3 là chỗ tốn
  nhất trong toàn bộ plugin: đo trên 9.263 dòng log thật, nó chiếm **65% chi phí
  Jev** (3.238.650 / 4.958.494 input token, 1.831 lần gọi, 1.768 token/lần).

  Cơ chế cũ dựa vào câu hỏi `lease` ("giữ mức này bao lâu?") gần như **chết**:
  Jev trả `lease=1` ở **1.777/1.830 lần (97%)**, kể cả khi confidence 0.9. Ở mọi
  mức confidence, lease trung bình chỉ 1.00–1.08 — đó là hành vi nhất quán, không
  phải lỗi, nên hỏi lại cũng không cho lease dài hơn.

  Cái quyết định được là **confidence của chính câu effort**. Đo trên 1.225 cặp
  step liên tiếp, confidence của step trước tương quan mạnh với việc step sau giữ
  nguyên effort:

  | conf | step sau giữ nguyên |
  |------|--------------------|
  | 0.1  | 46% |
  | 0.4  | 78% |
  | 0.6  | 88% |
  | 0.7  | 93% |
  | 0.9  | 95% |

  Giờ: confidence ≥ `effortReuseConfidence` (0.6) **và** không có tool call mới
  **và** cùng turn → giữ nguyên mức, không hỏi Jev. Đo được: bỏ 32% số lần gọi,
  chỉ đoán sai 8% (bỏ sót TĂNG 4,3%).

  Ba điều kiện chặn là bắt buộc, mỗi cái có lý do đo được:
  - **Cùng turn** — sang turn mới, goal và lịch sử tool khác hẳn, quyết định cũ
    không còn là bằng chứng.
  - **Không có tool call mới** — một tool result mới là thông tin mới về độ khó;
    tái dùng khi đã có thông tin mới là mù với thực tế.
  - **Mức cũ vẫn được route nhận** — route có thể đã đổi.

  Vì sao KHÔNG nâng 1 bậc khi tái dùng để bù rủi ro: đo được nâng 1 bậc làm
  **95,7% trường hợp cao hơn mức cần** — đốt reasoning token trên mọi step để
  phòng 4,3% trường hợp, đắt hơn nhiều so với tiết kiệm.

- **BỎ câu hỏi `lease` khỏi `effortQuestion`.** Không còn ai dùng nó. Đo được
  tiết kiệm **148 input + 43 output token mỗi lần gọi**. Xoá kèm `LEASE_MEANING`,
  hằng `LEASES`, và config `maxLeaseSteps`.

### Thêm

- **LỚP 7 — tự gọi `jev_review` khi turn kết thúc** (`agent/turn-stopping`).

  Lý do: đo trên 110 session thật, tool `mcp__jev-review__jev_review` **được đăng
  ký và có trong prompt** (section `mcp:jev-review` do `dsh-mcp-client` chèn qua
  `systemPrompt.section`), nhưng được gọi **1 lần duy nhất** — và đó là lần tác
  giả plugin tự test. Trong công việc thật: **0 lần**.

  Nghĩa là "có tool" không bằng "tool được dùng". Mọi kênh Jev trừ `dsh-jev-gate`
  đều thụ động (MCP tool, skill, CLI đều chờ agent quyết định gọi); chỉ hook
  engine là chạy tự động. Nên lớp này cắm `jev_review` vào hook.

  Gọi qua `ctx.tools.execute({ name: 'mcp__<server>__jev_review' })` — đúng đường
  của DSH, không tự spawn tiến trình, không tự quản key.

  BỐN CHỐT chống lạm dụng (hook này chặn turn, nên mỗi chốt đều cần):
  1. Chỉ khi turn thật sự kết thúc — review code dở dang là vô nghĩa.
  2. Chỉ turn chính, không phải subagent (`delegationDepth === 0`) — subagent
     không sở hữu workspace change và sẽ nhân số lần review theo số worker.
  3. Chỉ khi thay đổi đủ lớn (`reviewMinChangedLines`, 20 dòng) — review diff
     rỗng hay sửa typo là đốt tiền không đổi lại gì.
  4. Trần `reviewMaxPerTurn` (1) — không có nó thì mỗi lần turn-stopping chạy lại
     là một lần gọi.

  Điểm số trả về qua `agent.steer` dưới dạng **báo cáo**, không phải mệnh lệnh:
  điểm là bằng chứng, không phải mục tiêu để tối ưu. Tắt bằng
  `enableQualityReview: false`.

  Config mới: `enableQualityReview`, `reviewMinChangedLines` (20),
  `reviewMaxPerTurn` (1), `reviewMaxDiffChars` (24000), `reviewServerName`
  ('jev-review'), `reviewReportToAgent` (true).

### Sửa

- **`agent/request` THỰC SỰ nhận `agent`** — note cũ trong
  `~/.dsh/notes/jev-gate.md` ghi ngược lại và đã lỗi thời. Engine fuse `agent`
  vào MỌI payload agent-scoped (`dsh-agent/lib/index.js:242`), kể cả
  `agent/request`. Hệ quả của việc không đọc nó: guard "có tool call mới" đọc
  lịch sử tool từ `lastSeenSession` cũ nên luôn thấy mảng rỗng, và tái dùng cả
  khi đã có thông tin mới. Phát hiện nhờ test stub đếm số lần gọi.

- **Đọc service tuỳ chọn bằng `ctx.get(name, false)`**, không phải
  `ctx.inject([...], cb)`. `ctx.inject` là loader plugin bất đồng bộ, KHÔNG phải
  service getter — dùng nó sẽ luôn trả `undefined`. `workspaceChanges` là service
  tuỳ chọn (do `dsh-workspace-changes` cung cấp), không được đưa vào `inject` của
  plugin vì sẽ làm cả plugin không nạp khi service vắng.

### Xoá

- **Xoá skill `jev-review` khỏi catalog.** Trước đây tồn tại song song hai nguồn
  dạy agent dùng `jev_review`: skill này, và hướng dẫn của chính MCP server
  (**1.242 ký tự**, do `dsh-mcp-client` chèn vào system prompt qua
  `systemPrompt.section`).

  Bằng chứng quyết định:

  - Đo trên **115 session thật**: hướng dẫn MCP có mặt trong **26 session** →
    tới model **độc lập với skill**.
  - So nội dung: phần lớn skill trùng hướng dẫn MCP — vòng lặp
    chấm→sửa→chấm lại, baseline, `previousEvaluation`, không lặp lời gọi, không
    game điểm.
  - Skill **chưa từng dẫn tới một lời gọi review nào trong công việc thật**.
    Kiểm 4 lần `jev_review` từng được gọi: `f5a2e8a7` có gọi skill trước (tác giả
    test), `6865243e` **không** gọi skill (test tích hợp MCP). Cả 4 đều là test.

  Nên chỉ giữ **một** nguồn hướng dẫn: MCP server + Lớp 7 tự gọi khi turn xong.
  Tool `jev_review` không đổi — vẫn đăng ký qua `mcp-jev-review`, agent vẫn gọi
  được, hướng dẫn vẫn vào prompt.

  Backup skill đã xoá: `~/.dsh/notes/backups/jev-review-skill-<timestamp>/`.

  Lưu ý về một kết luận sai trước đó: bản 0.4.0 ban đầu **giữ** skill với lý do
  "hai cơ chế bổ sung, không trùng". Kết luận đó dựa trên so sánh *chức năng* mà
  bỏ qua việc MCP server đã tự mang hướng dẫn tương đương — và bỏ qua dữ liệu
  cho thấy skill chưa từng được dùng trong việc thật.

### Sửa (vệ sinh test)

- **`makeWorkspace` để lại rác trong `/tmp`.** Hàm dựng workspace tạm cho test Lớp 5
  nhưng không ai dọn: đo được **42 thư mục `jev-gate-test-*`** sau vài lần chạy.
  Giờ đăng ký dọn qua `process.on('exit')`. Kiểm chứng: chạy test, số thư mục
  trong `/tmp` không tăng.

- **`live-check.mjs` dao động 2/3 lần pass.** Một timeout thoáng qua làm
  `jev.evaluate` ném lỗi và sập **cả suite**, nên kết quả phản ánh mạng chứ không
  phản ánh chất lượng code. Giờ có helper `evaluate` thử lại 3 lần khi lỗi tạm
  thời (timeout/429/5xx), nhưng ném ngay với lỗi 401/422 (sai key, request hỏng).
  Kiểm chứng: **4/4 lần chạy exit 0**.

### Kiểm chứng ở bản này

| Phép đo | Kết quả |
|---|---|
| Offline (không cần secret) | **89 check pass**, 0 fail (trước 61) |
| Live-check (Jev thật) | 21 check pass |
| `verify.sh` | exit 0, 6/6 mục |
| Lớp 3 tái dùng — handler thật + Jev thật | step 2 tái dùng, chỉ 1 lần gọi Jev |
| Lớp 7 — handler thật + MCP thật | gọi `jev_review` 1 lần, steer điểm về agent |
| Bỏ câu `lease` | tiết kiệm 148 input + 43 output token mỗi lần gọi |

## [0.3.3]

### Sửa

- **Log kiểm định lẫn vào log quyết định thật.** `tests/offline.mjs` và
  `tests/live-check.mjs` nạp `lib/index.mjs` qua `apply()`, mà `LOG_DIR` tính từ
  `XDG_DATA_HOME` lúc nạp module — nên test ghi chung `decisions.jsonl` với DSH
  thật. Hệ quả đo được: trong 8,945 dòng log có **575 dòng `boot`** (60 cụm test),
  **152 `jev_error` "Jev API key invalid"** từ key giả của test, và `pre_step`
  `turn:1` lặp 22 lần. Mọi số đo trên log phải lọc tay mới tách được session thật
  khỏi test — và bảng "tỷ lệ lỗi 14%" đọc lên gây hiểu nhầm.

  `apply()` giờ nhận config `logDir`; cả hai test trỏ vào `mkdtempSync()` và tự
  xoá khi thoát. Kiểm chứng: chạy cả hai test, `decisions.jsonl` thật **0 dòng
  thêm, mtime không đổi**; DSH thật vẫn ghi bình thường.

  Config mới: `logDir` (không default — thiếu khoá thì dùng đường mặc định cũ).

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
