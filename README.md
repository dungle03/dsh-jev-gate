# dsh-jev-gate

[English](README.en.md) · **Tiếng Việt**

![Kiến trúc dsh-jev-gate](assets/architecture.png)

*Sơ đồ tương tác (pan/zoom, đổi theme sáng/tối, tìm kiếm): mở
[`assets/architecture.html`](assets/architecture.html) trong trình duyệt.*

Đưa [Jev](https://typesafe.ai/) (TypeSafe System One) vào **những khoảnh khắc đắt
giá** của [DeepSeek Harness](https://github.com/deepseek-ai/dsh), theo nguyên tắc:

> **LLM hiểu và làm. Jev chỉ trả lời câu hỏi ĐÓNG ở khoảnh khắc mà một quyết
> định sai gây tốn kém.**
>
> **Cái gì code suy ra được thì đừng gọi model.**

Jev không sinh văn bản, không lập kế hoạch, không viết code. Nó chỉ chấm một câu
hỏi đóng và trả về xác suất. Plugin này dùng Jev làm **chốt chặn**, không phải
bộ não thứ hai.

## Phiên bản và phạm vi hỗ trợ

Bản phát hành `0.14.0` hỗ trợ chính xác DSH `0.2.0-rc.2`, khớp
`engines.dsh` và kiểm thử host thật bắt buộc trong CI. Không suy ra hỗ trợ các
bản DSH cũ hoặc mọi bản tương lai từ một phiên bản đã kiểm chứng.

| Host | Hợp đồng |
|---|---|
| DSH `0.2.0-rc.2` | Được hỗ trợ, kiểm thử CI bắt buộc |
| DSH master | Chỉ quan sát, job không chặn phát hành; không nằm trong phạm vi hỗ trợ |

## Các lớp

Tám khoảnh khắc Jev được hỏi, cộng các cơ chế **tất định không gọi Jev** (đánh dấu
`—` ở cột Kiểu): prefilter chỉ-đọc (**1₀**) và cache verdict (**1ᶜ**). Lớp **1b**
cũng tất định, nhưng khi không chứng minh được quyền thì hỏi user qua thẻ nổi
(Kiểu `ask`). Lớp 3 gọi Jev ở chế độ `input`; chỉ thành tất định khi đặt
`effortDecision: 'deterministic'`. Trạng thái mặc định lấy trực tiếp từ `DEFAULTS`
trong `lib/index.mjs`.

| Lớp | Hook | Câu hỏi / cơ chế | Kiểu | Mặc định |
|---|---|---|---|---|
| **1** · Gate phá dữ liệu | `tools/pre-execute` + `ctx.tools.guard` | Jev hỏi lệnh có phá dữ liệu; sàn catastrophic chạy lại ở guard monotonic sau waterfall | `noul` + — | **bật** |
| **1₀** · Prefilter chỉ-đọc | `tools/pre-execute` (trước 1) | Chứng minh cục bộ lệnh không thể ghi → bỏ qua Jev | — | **bật** |
| **1ᶜ** · Cache verdict | `tools/pre-execute` (trước khi gọi Jev) | Trùng khoá `tool+command+cwd` → dùng lại verdict | — | **bật** |
| **1b** · Quyền của user | `tools/pre-execute` (chỉ khi 1 chặn) | Động từ phá dữ liệu + đúng mọi target + không phủ định/bàn luận; còn nghi vấn → hỏi user | `ask` | **bật** |
| **2** · Kiểm hoàn thành | `agent/turn-stopping` | Xong chưa? Có bằng chứng chưa? Có cần thực thi không? | `noul` ×3 | **bật** |
| **3** · Chọn effort | `agent/request` | Jev đọc nội dung tin nhắn user → `low`/`high`; còn lại `medium`; tín hiệu đo được nâng lên sàn | 1/lượt | **bật** |
| **4+5** · Chọn hướng + chọn file nạp | `agent/pre-step` (step 1) | Hướng nào tối ưu? File nào cần đọc trước? | `choice` + `noul` ×N | **cả hai tắt** |
| **6** · Phục hồi khi tool lỗi | `tools/post-execute` | Retry, đổi cách, điều tra, hay báo user? | `choice` | **bật** |
| **7** · Review chất lượng | `agent/turn-stopping` | Tự gọi `jev_review` khi turn xong và diff đủ lớn | tool MCP | **bật** |
| **8** · Leo thang tìm nguồn | `agent/pre-step` + `tools/post-execute` | Chạy `jg` khi việc là "tìm X nằm ở đâu"; đối chiếu task/root/turn trước khi chèn kết quả nền | CLI `jg` | **tắt** |

Ba cơ chế **không gọi Jev** — **1₀** prefilter, **1ᶜ** cache, **1b** provenance.
Đây là các quyết định suy ra được từ cú pháp lệnh / exit code / nguồn gốc tin
nhắn. (Lớp **3** ở chế độ `input` có gọi Jev; đặt `effortDecision: deterministic`
để nó cũng thành tất định. Lớp **1b** khi provenance KHÔNG chứng minh được sẽ
hỏi user qua thẻ nổi — xem mục "Quyền của user" bên dưới.)

### Vì sao có lớp "Prefilter chỉ-đọc" (1₀)

Lớp 1 gọi Jev cho **mọi** lệnh `bash`. Đo trên log thật (2026-09-27 → 09-30):
5.600 call, trong đó **80,7%** có `p ≤ 0.02` — phần lớn là round-trip API để
nghe lại điều suy ra được bằng phân tích cú pháp cục bộ. Ở p50 ~289ms và ~718
token/call, đó là khoản chi lớn nhất của gate.

`lib/readonly.mjs` trả `true` chỉ khi **chứng minh được** lệnh không thể ghi.

**v0.10.0 — thêm vòng `for..do..done`.** Phân tích ở tầng token: một vòng
`for VAR in <list literal>; do <body>; done` được coi là chỉ-đọc khi thân — sau
khi thay `$VAR` bằng placeholder **không phải lệnh** (`__LOOPVAR__`) — chứng minh
được là chỉ-đọc. Mọi nghi ngờ (`$()`/backtick/heredoc/redirect ghi/`$VAR` ở vị trí
lệnh/for lồng) → `false`.

Đo trên log thật (3.369 lệnh `allow` của gate, snapshot 2026-10-02): prefilter phủ
**13,6%** (459 lệnh) — trước v0.10.0 là **0,03%** (1 lệnh). 455 lệnh nhận thêm
đều chứa token `for` (không rò rỉ ngoài phạm vi).

Đây KHÔNG phải nới lỏng bảo vệ. Mọi nghi ngờ — heredoc, backtick, redirect ghi,
`$()` (kể cả trong nháy kép), `find -delete`, `sed -i`, `git reset`, trình thông
dịch, lệnh lạ — đều rơi xuống đường Jev như cũ. `tests/offline.mjs` chạy **329
lệnh phá dữ liệu** và yêu cầu **0 lệnh được phép lọt**, cộng **384 + 39 biến thể
fuzz**. `tests/attack-corpus.mjs` chạy thêm **83 lệnh tấn công** độc lập (56 vòng
`for` nguy hiểm + 16 luôn-deny + 11 cặp ngụy trang) — yêu cầu **0 lọt**.

**Danh sách trắng hẹp hơn trực giác, và đó là kết quả của đo đạc.** Bản đầu viết
theo suy luận đã để lọt **12 dạng**, tìm ra bằng cách chạy `--help` thật rồi thử
ghi file trong sandbox: `trap "rm -f victim" EXIT` (chạy lệnh tuỳ ý),
`hostname NEW` (đặt tên máy), `date 010112002026` (đặt đồng hồ), `xxd in out` và
`uniq in out` (đối số thứ hai là file ghi), `file -C`, `less -o`, `history -w`,
`rg --pre CMD`, `fd -x CMD`, `sort --compress-program`, `git --ext-diff`.

Ba cơ chế bù lại, mỗi cái cho một lớp vấn đề khác nhau:

| Cơ chế | Xử lý |
|---|---|
| Bỏ khỏi danh sách trắng | `trap`, `history`, `hostname`, `xxd`, `uniq`, `split`, `tee` — đo được chỉ dùng 0–2 lần/3.197 lệnh |
| `POSITIONAL_OUTPUT_COMMANDS` | `uniq in out`, `xxd in out`, `hostname NEW` — phải đếm đối số vị trí |
| `CONDITIONAL_COMMANDS` theo lệnh | `sort -o`, `date -s`, `less -o`, `rg --pre`, `fd -x` — cờ phải gắn với lệnh cụ thể, vì `-o` khác nghĩa ở `grep` và `sort` |

### Vì sao có lớp "Cache verdict" (1ᶜ)

Gate gọi Jev cho lệnh `bash` chưa qua prefilter. Snapshot lịch sử cho thấy
**~6,2%** lệnh `allow` có chuỗi trùng (cùng tool + command + cwd), **không phải
cache hit**. Trên log vận hành 2026-10-04 chỉ thấy **4 dòng `cached:true`**;
kết quả tiết kiệm thực tế cần đo riêng, không suy ra từ tỷ lệ lệnh trùng.

Khoá cache = `tool + command (nguyên văn) + cwd + declared workdir`. Chỉ cache
verdict **rõ ràng**: `allow` (p cách ngưỡng xa) và `deny`. **`fail_open` KHÔNG
bao giờ cache** — lỗi tạm thời không được đóng băng thành verdict.

**v0.10.1 — không cache sát ngưỡng.** Jev **không tất định**: đo trên `jev-1.13.0`,
`rm -f <file>` cho p vắt qua ngưỡng 0,7 (`0.67, 0.68, 0.69, 0.70`). Nếu cache một
lần rơi mẫu `< ngưỡng` (allow) thì mọi lần sau phục vụ p cũ, **bỏ qua** các mẫu
`≥ ngưỡng` lẽ ra phải chặn — cache biến deny thành allow. Nên `gateVerdictCacheMargin`
(mặc định `0.1`) chặn cache khi `|p − threshold| ≤ margin`; verdict cách ngưỡng
đủ xa thì dao động không đổi kết quả.

Trần bộ nhớ `gateVerdictCacheMax` (500) với eviction FIFO + LRU-touch khi hit.
Tắt bằng `enableGateVerdictCache: false`.

### Vì sao có lớp "Quyền của user" (1b)

Gate phá dữ liệu cũ **không phân biệt được rác session với dữ liệu thật**. Log
thật cho thấy `rm -rf /tmp/gtest` (thư mục test do chính session tạo) bị chặn ở
p=0.77, trong khi `rm -rf <path không tồn tại>` chỉ 0.40 — nên dọn rác hợp lệ bị
chặn oan và phải thử lại nhiều lần (một lệnh bị chặn **7 lần** liên tiếp).

Lớp này chỉ chạy **khi** lớp 1 đã kết luận lệnh là phá dữ liệu, và chỉ để trả
lời một câu: user có tự tay yêu cầu xoá đúng thứ đó không. Chặn chỉ xảy ra khi
hội đủ hai điều — **phá dữ liệu VÀ không được user yêu cầu**:

```
p ≥ 0.7  ──► kiểm provenance: user yêu cầu phá dữ liệu tường minh,
               │   nêu đủ mọi target và không phủ định/bàn luận/trích dẫn?
              ├── có    ──► CHO CHẠY  (allow_authorized)
              └── không / không chứng minh được
                    └──► HỎI USER bằng thẻ ĐỒNG Ý nổi, CHỜ trả lời
                          ├── đồng ý rõ ràng ──► CHO CHẠY (allow_consented)
                          └── từ chối / bỏ qua / hết hạn / không có kênh hỏi
                                └──► CHẶN (deny_consent)
```

**v0.13.0 — thẻ ĐỒNG Ý cho hành động do agent tự đề nghị.** Trước đây nhánh
"không chứng minh được" **chặn cứng**. Nhưng yêu cầu gốc tách làm hai: yêu cầu
**của user** là kiên quyết (user bảo xoá thì xoá — provenance lo nhánh này), còn
khi **agent tự đề nghị** xoá giữa lúc chạy thì phải **hỏi user và chờ đồng ý**,
tuyệt đối không tự xoá khi user chưa cho phép. Nên nhánh sau giờ dựng một **thẻ
câu hỏi nổi** và chờ:

- **Đồng ý** = user chọn đúng một nhãn `"Run it"`, **không** gõ thêm văn bản tự
  do (cùng quy tắc với `dsh-plan-mode`). Khi đó chạy, ghi `allow_consented`.
- **Mọi thứ khác** = CHẶN, ghi `deny_consent`, mã lỗi `JEV_CONSENT_DENIED`:
  chọn `"Do not run it"`, bỏ qua thẻ (`ASK_CANCELLED`), hết hạn
  (`ASK_TIMED_OUT`), hoặc không có kênh hỏi user.

**Im lặng KHÔNG phải là đồng ý.** Hết hạn, bỏ qua, hay không có kênh hỏi (agent
con do agent khác sở hữu không có người trả lời) đều **CHẶN**. Không hành động
phá dữ liệu nào chạy mà thiếu đồng ý rõ ràng — đây vẫn là lớp **fail-closed**.

**Vì sao dùng `ctx.userQuestions`, không dùng `ctx.approval`.** Đường `{kind:'ask'}`
của `tools/pre-execute` đi qua `ctx.approval`, nhưng ở bản deploy này `dsh-purge`
đã vá `dsh-user-approval` thành **auto-grant** (`dsh-user-approval/lib/index.js:173-178`
trả thẳng `"allowed-once"` mà không hỏi ai). Hỏi qua đó cũng như không — không
lấy được đồng ý thật. `dsh-user-questions` còn nguyên và đúng là kênh hỏi user
thật (thẻ nổi, user gõ/chọn được), nên lớp 1b dùng nó. Tiền lệ: thẻ "Plan review"
của `dsh-plan-mode`.

Hai config điều khiển: `enableDestructiveConsent` (mặc định `true`; tắt thì quay
về chặn cứng cũ) và `consentTimeoutMs` (mặc định `120000` — quá hạn thì coi như
từ chối). Lớp 6 cũng **bỏ qua** lệnh bị thẻ đồng ý chặn (mã `JEV_CONSENT_DENIED`)
— một lệnh bị chặn không phải "tool lỗi" để gợi ý retry.

**v0.9.0 — bỏ call LLM thứ hai.** Bản cũ hỏi Jev một câu `choice` ("user có yêu
cầu không?") — một round-trip nữa nằm TRÊN đường tới hạn của mọi lệnh bị chặn.
Nay suy quyền từ **provenance tất định**: lấy tin nhắn **thật** của user, yêu cầu
động từ phá dữ liệu tường minh, loại yêu cầu phủ định/bàn luận/trích dẫn, rồi
kiểm mọi target trích được từ lệnh (`rm`/`mv`/`truncate`/…). Lệnh ghép, glob,
biến shell, `find -exec` hoặc redirect phức tạp không được tự cấp quyền: chúng
luôn cần thẻ đồng ý. Không chứng minh đủ thì hỏi lại qua thẻ đồng ý. Đo trên hook thật (`tests/offline.mjs` mục 7b/7c): trước = **2** request
Jev mỗi lần gate chặn (`destructive` + `authorized`), sau = **1** (`destructive`),
và khi không chứng minh được thì **0** request bổ sung.

Bằng chứng `user_request` **chỉ** lấy tin nhắn thật của user (`source.kind ===
'user'`). Trước đây `notePrompt` gộp mọi message `role=user` — kể cả output job
nền (`tool-jobs`) và gợi ý do chính plugin chèn — nên nội dung không tin cậy có
thể lọt vào trường "yêu cầu của user". Provenance tất định dùng đúng nguồn này.

Lớp này **fail-closed**: không chứng minh được thì CHẶN (hoặc hỏi user, và mọi
câu trả lời không phải đồng ý rõ ràng cũng CHẶN). Lớp 1 nay mặc định hỏi khi Jev lỗi — vì
đây là lớp phòng thủ, "không biết" phải nghiêng về phía an toàn.

### Lớp 3 — Jev chọn effort theo nội dung tin nhắn user

Mặc định (chế độ `input`): mỗi **lượt** user gửi, Jev đọc yêu cầu và quyết mức
effort cho lượt đó. Ở đường mặc định, **Jev chỉ được chọn `low` hoặc `high`**; mọi
trường hợp khác (Jev lỗi, không có task, trả mức ngoài tập) rơi về `medium`. Đặt
`effortAbstain: true` để đổi sang đường **hai câu `noul`** cho phép Jev chủ động
abstain (xem mục v0.14.0 bên dưới). Sticky trong turn nên chỉ tốn **1 call
Jev/lượt**, không phải mỗi step.

Hai config điều khiển:

- `effortJevChoices` (mặc định `['low','high']`) — tập mức Jev được phép chọn,
  giao với dải `reasoningEfforts` của model. Giao còn < 2 mức thì không hỏi Jev.
- `effortFallback` (mặc định `'medium'`) — mức áp khi Jev không quyết được.

**v0.13.0 — tín hiệu THẤT BẠI đo được là SÀN, không phải nguồn chính.** Yêu cầu
gốc: effort phải dựa trên **mỗi input của user**. Nhưng bỏ qua bằng chứng đo được
(tool lỗi / test fail ở turn trước) thì vô lý — bước trước đã hỏng là lý do chính
đáng để nâng effort. Nên: nội dung input vẫn là **nguồn chính** (Jev đọc và
quyết), còn tín hiệu đo được gửi kèm Jev dưới `state.measured_signals` như **bằng
chứng bậc hai**, và đóng vai **sàn**:

- Nếu Jev chọn mức **thấp hơn** mức mà tín hiệu đòi (`effortEscalateTo` khi turn
  trước có ≥ `effortEscalateToolErrors` tool error hoặc ≥ `effortEscalateTestFailures`
  test fail), mức được **nâng lên sàn**. Không bao giờ hạ xuống dưới sàn.
- Nếu model không nhận mức sàn, sàn bị bỏ qua và dùng mức hợp lệ gần nhất.
- Dòng log `effort_route` ghi `floored_from` + `floor` khi sàn nâng mức, và
  `signals` để kiểm chứng.

Ba config `effortEscalateTo`/`effortEscalateToolErrors`/`effortEscalateTestFailures`
giờ điều khiển cả sàn ở chế độ `input` (trước chỉ dùng ở `deterministic`).
`lib/policy.mjs` export `EFFORT_ORDER`, `effortRank`, `effortFloorFromSignals` để
tính sàn tất định.

Đặt `effortDecision: 'deterministic'` để quay lại luật tín hiệu cũ (mặc định
`effortDefault`, nâng `effortEscalateTo` khi turn trước có tool error/test fail,
**không gọi Jev**).

**Vì sao Jev chỉ quyết 2 đầu (đo thật 2026-10-04).** Probe trực tiếp
`effortQuestion`, 5 lần lặp mỗi độ khó, dải `low/medium/high/max`:

| Độ khó | Kết quả 5 lần | Nhận xét |
|---|---|---|
| dễ (liệt kê file) | `low`×5, conf **1.00** | rất chắc |
| vừa (so sánh 2 lib) | `low`×5, conf 0.29–0.39 | **gộp medium vào low** |
| khó (truy vết leak) | `low`×3, `high`×2 | **dao động** |
| cực khó (chứng minh) | `max`×5, conf 0.40–0.50 | khá chắc |

`medium` gần như không bao giờ được chọn (1/14 task, conf 0.35). Jev đáng tin ở
2 đầu, mơ hồ ở giữa — nên giao 2 đầu cho Jev, giữ giữa cho config.

**v0.13.1 — câu hỏi effort phải là TURN-LEVEL, không phải per-step.** Phrasing cũ
hỏi *"which reasoning effort is sufficient for the NEXT generation"* — đúng với
cơ chế tái dùng theo step ngày xưa, nhưng SAI với thực tế: Lớp 3 chốt mức cho CẢ
turn rồi giữ nguyên (sticky). Hệ quả đo được trên **26 task có nhãn × 5 lần**:

| Phrasing | Đúng | easy (16) | hard (10) |
|---|---|---|---|
| cũ — "NEXT generation" | 21/26 | 16/16 | **5/10** |
| mới — "fixed for the WHOLE turn … ENTIRE request" | **26/26** | 16/16 | **10/10** |

5 ca sai của phrasing cũ đều cùng một dạng: yêu cầu **nêu triệu chứng cần chẩn
đoán** ("memory leak", "race condition", "query chậm chưa rõ nguyên nhân") bị chấm
`low` vì bước đầu tiên chỉ là đọc file — dù cả turn cần `high`. Phrasing mới nói
rõ mức áp cho toàn turn và "yêu cầu mà nguyên nhân chưa biết thì không phải yêu
cầu thường"; nó **không** over-escalate (easy vẫn 16/16) và ổn định qua 3 lần lặp.

**Confidence KHÔNG dùng để gate.** Đo trên cùng tập nhãn: dải confidence của ca
SAI (0,52–0,57) nằm trọn trong dải ca ĐÚNG (0,00–0,79) — mọi ngưỡng cắt được ca
sai cũng cắt mất ca đúng. Vì vậy `confidence` chỉ được ghi vào log
`effort_route` cho người vận hành; instructions không còn hứa rằng nó quyết định
việc tái dùng (điều đó chưa từng đúng ở chế độ `input`).

Cùng lúc, `EFFORT_MEANING` (criteria Jev đọc) được sửa cho khớp: `low` bản cũ
định nghĩa *"…including the easy opening step of a hard task"* — carve-out
per-step tự mâu thuẫn với phrasing turn-level. Nay `low` = *"the whole request is
routine or mechanical"*. Đo lại: vẫn **26/26**.

**v0.14.0 — `medium` thành ABSTAIN thật (`effortAbstain`, mặc định TẮT).** Vấn đề
của thiết kế cũ: khi `effortJevChoices` chỉ có `low`/`high`, một API chạy được
buộc Jev phải chọn **một cực** — kể cả khi task ở giữa. `medium` chỉ xuất hiện
khi Jev **lỗi**, tức là một **dấu hiệu hỏng**, không phải một quyết định. Đo trên
log thật: mức đổi `low↔high` **113/120** lần.

Chế độ `effortAbstain: true` hỏi **hai câu `noul` độc lập trong MỘT request**
(một call Jev như cũ), rồi host tự ánh xạ — Jev không bao giờ bị ép chọn cực:

| `routine` | `hard` | Kết quả | Nghĩa |
|---|---|---|---|
| ≥ `effortRoutineThreshold` (0.5) | < ngưỡng | **`low`** | rõ là routine/máy móc |
| < ngưỡng | ≥ `effortHardThreshold` (0.5) | **`high`** | rõ là cần giải quyết điều chưa biết |
| còn lại (mâu thuẫn / cả hai yếu) | | **`effortFallback` = `medium`** | **abstain** — Jev tự khai "không chắc" |

Ví dụ theo thiết kế: `routine=0.91, hard=0.06 → low`; `0.08, 0.88 → high`;
`0.44, 0.41 → medium`; `0.70, 0.68 → medium` (mâu thuẫn).

- Hai trục **hiệu chỉnh độc lập** qua `effortRoutineThreshold` /
  `effortHardThreshold`, thay vì một ngưỡng confidence duy nhất không tách được
  ca đúng/sai.
- Câu `routine`/`hard` đều nói rõ: yêu cầu **nêu triệu chứng để chẩn đoán** (leak,
  race, regression, crash) **không** phải routine — kể cả khi bước đầu chỉ là đọc
  file — để giữ đúng 10/10 ca hard của phrasing turn-level.
- **Sàn tín hiệu đo được vẫn áp**: Jev nói `low` mà turn trước có test fail thì
  mức bị nâng lên `high`. Bằng chứng đo được thắng phỏng đoán độ khó.
- **Tùy biến**: `effortJevChoices` vẫn là tập mức hợp lệ; `low` = mức thấp nhất
  trong tập, `high` = mức cao nhất. Ví dụ `['medium','high']` thì "routine mạnh"
  chọn `medium`, "hard mạnh" chọn `high`.
- **Tương thích**: mặc định `effortAbstain: false` giữ nguyên đường một câu
  `choice` đã đo **26/26**; bật cờ là đổi sang đường hai `noul`. Log
  `effort_route` ghi `source: 'jev_abstain'` kèm `routine`/`hard` để audit.

**Đo thật trên bộ 26 nhãn.** Chạy đúng 26 task đã dùng để đo đường `choice`
(16 easy kỳ vọng `low`, 10 hard kỳ vọng `high`), model `jev-1.13.0`, 3 lần lặp:

| biến thể câu `hard` | điểm | abstain oan |
|---|---|---|
| bản đầu (theo thiết kế) | **63/78** | 15 |
| đã viết lại | **78/78** | 0 |

Lỗi thật tìm được nhờ đo: bản đầu viết *"the answer is not yet known and must be
found"* — câu đó mô tả **đúng** việc "đọc `package.json` để biết version", nên
Jev trả `hard` cao (0,50–0,61) cho task routine và bị ABSTAIN **oan**. Bản viết
lại tách *"work out something that **DETERMINES WHAT TO DO**"* khỏi *"Reading a
file to learn a value you were asked to report is **NOT** uncertainty"*. Test
`11aa-k` khoá carve-out này.

**Abstain có thêm giá trị không?** Trên 12 task "giữa", abstain khác đường
`choice` ở **8/12 ca** — và abstain đúng ở những ca `choice` bị **ép** chọn cực
với confidence thấp (ví dụ: `gộp hai hàm trùng lặp` → abstain `medium` còn
`choice` ép `low` conf **0,01**; `viết thêm test cho module config` → `medium`
so với `high` conf **0,09**). Đây đúng mục tiêu thiết kế: **không định hướng
model khi không có tín hiệu rõ**.

**Lịch sử.** Lớp này từng là classifier per-request gọi Jev MỌI request
(2026-09), rồi bị thay bằng luật tất định (2026-10-01) vì đo được cơ chế cũ đổi
mức `low↔high` **113/120 lần**, 54,5% quyết định conf < 0,5, chiếm **55%** token
Jev. Chế độ `input` hiện tại khác bản cũ ở chỗ: gọi **1 lần/lượt** (không phải
mỗi request), chỉ hỏi "yêu cầu này khó không", và **giới hạn Jev trong 2 đầu**.

Ghi chú cache: trên router này đổi effort **không** xoá prompt cache — đo được
96% cache hit sau khi đổi.

### Vì sao Lớp 4 im lặng khi thiếu bằng chứng (cổng xác suất + margin)

Câu `choice` **luôn** trả về một hướng, kể cả khi state không đủ để chọn — nó
không có đường khai "không biết". Vấn đề: `confidence` **không** tương quan với
đúng/sai (đo được ca ĐÚNG conf 0,24 nằm dưới ca SAI conf 0,44), nên một ngưỡng
confidence **không lọc được gì**. Hệ quả: model bị neo vào một hướng **đoán bừa**
ngay step 1 — mà gợi ý không kèm bằng chứng còn tệ hơn không gợi ý.

Hai thay đổi:

1. **Thêm nhánh `no-op`** vào criteria của câu `approach`: Jev có đường khai
   *"văn bản task không đủ để đề xuất hướng nào"* — một câu trả lời hợp lệ, không
   phải lỗi.
2. **Cổng bằng chứng theo PHÂN PHỐI, không theo `confidence`.** Response `choice`
   mang đủ `probabilities` cho mọi nhánh, nên host chèn gợi ý **chỉ khi**:

   - đỉnh phân phối `max(probabilities) >= approachTopProbability` (0.5), **và**
   - đỉnh bỏ xa nhì `max − second_max >= approachProbabilityMargin` (0.15), **và**
   - nhánh thắng không phải `no-op`, **và** `choice` khớp argmax.

   Ngược lại → **im lặng**. Ví dụ theo thiết kế: `parallel .86 / script .22 /
   one .10` → chèn; `script .48 / parallel .43 / one .39` → im lặng (đỉnh thấp,
   margin mỏng).

Mọi nhánh im lặng ghi nhãn riêng vào log `pre_step` — `silent_no_op`,
`silent_insufficient_evidence`, `silent_ambiguous` — kèm `topProbability` và
`margin`, để đọc được **vì sao** im lặng chứ không chỉ "không chèn". Ngưỡng chỉnh
được qua `approachTopProbability`/`approachProbabilityMargin`.
`approachConfidenceThreshold` chỉ còn là **đường lùi** khi response thiếu
`probabilities` (không nên xảy ra với jev-client hiện tại).

### Vì sao có lớp "Chọn file nạp vào context" (Lớp 5) — ĐÃ DỰNG LẠI TRÊN BẰNG CHỨNG

> **Trạng thái 2026-10-05: `enableContextTriage` vẫn mặc định `false`** — code đã
> dựng lại, nhưng **chưa A/B trên session thật** nên chưa bật. Xem "Còn nợ" bên dưới.

Bản cũ chỉ hỏi Jev "file này có cần đọc không?" dựa trên **TÊN file + đường dẫn**,
KHÔNG có nội dung file — Jev phải đoán từ tên. Đo trên session thật (`777a1746`):
agent nhận gợi ý tên file **0/4 lần** đổi hành vi. Một gợi ý **không kèm bằng
chứng** còn tệ hơn không gợi ý: nó neo model vào một phỏng đoán ngay step 1.

Bản mới (§8, 4 giai đoạn):

1. **Sinh ứng viên tất định** — `listCandidateFiles`: một lần `readdir` theo chiều
   rộng, xếp hạng theo token khớp trong task (không đọc nội dung file nào).
2. **Trích bằng chứng rẻ** — `lib/evidence.mjs` đọc **tối đa** mỗi file một lần và
   chỉ lấy: dòng `import`/`require`, dòng `export`, và các dòng khớp token task
   (kèm số dòng). Không nạp cả file vào context.
3. **Jev xếp hạng TRÊN bằng chứng** — `preStepQuestion` đưa đoạn trích vào
   `state.candidate_evidence`, và câu hỏi `file_N` trỏ thẳng vào đó: "phán từ đoạn
   trích này, đừng phán từ tên". Vẫn một câu `noul` cho mỗi ứng viên, tất cả trong
   **cùng một request**.
4. **Chèn đường dẫn + đoạn trích cho agent** — không còn danh sách tên trần. Agent
   thấy `src/auth.ts (p=0.90)` kèm `imports:`/`exports:`/`matching line N:` nên
   quyết được ngay mà không phải mở file để kiểm.

An toàn (§8, `lib/evidence.mjs`): chỉ đọc đường dẫn **tương đối nằm trong workspace
root**; từ chối đường dẫn tuyệt đối, `..`, và mọi thứ `realpath` ra ngoài gốc; bỏ
qua **symlink**, file **nhị phân** (dò NUL trong 8 KB đầu), file **> 256 KiB**, và
file lỗi — trả `null`, không bao giờ ném. Đọc file chỉ xảy ra khi
`enableContextTriage` bật. `contextEvidence: false` quay về hành vi cũ chỉ-có-tên,
để A/B tách bạch "bằng chứng có giúp không" khỏi "lớp có giúp không".

**Ưu tiên khi chật ngân sách chèn (§22).** Khối bằng chứng file mang hạng riêng
`evidence`, xếp **trên** gợi ý approach chung (`advisory`): `safety > recovery >
completion > evidence > advisory`. Ở trần mặc định 500 token, gợi ý approach
(~84 token) và bằng chứng một file (~171 token) không cùng vừa nửa trần dành cho
hạng step-1 (250) — nên **bằng chứng thắng**, và nếu vẫn chật thì bằng chứng bị
**cắt ngắn** (có log `context_budget.truncated`) chứ **không bị bỏ hẳn**: một đoạn
trích ngắn vẫn là bằng chứng, còn bỏ hẳn thì agent mất luôn manh mối. Câu miễn trừ
§23 ("đây là gợi ý, không phải mệnh lệnh") đặt ở **đầu** khối để không bị cắt mất.

**Không chèn trùng (§22).** Mỗi turn giữ vân tay nội dung đã chèn (chuẩn hoá khoảng
trắng, hạ chữ), nên cùng một gợi ý không bao giờ vào context hai lần. Chỉ áp cho
`evidence`/`advisory`; `recovery`/`completion` miễn vì chúng có trần riêng theo
turn và nhắc lại ở step sau là chủ ý; `safety`/`consent`/`real_user` miễn — thà lặp
còn hơn im.

**Còn nợ (chưa làm):** (a) A/B thật `contextEvidence: true|false` trên session có
task nêu rõ file, đo tỉ lệ agent mở đúng file — đó mới là điều kiện bật mặc định;
(b) đồ thị import / `ripgrep` ký hiệu (giai đoạn 2 mở rộng) — bản này chỉ dùng
`imports`/`exports`/dòng khớp của chính file, chưa truy vết chéo file.

### Vì sao có lớp "Leo thang tìm nguồn" (Lớp 8)

> **Trạng thái 2026-10-05: `enableJevgrepEscalation` mặc định `false`.** Đo thật
> **41/41 lần leo thang đều `fail_open`** — chưa từng trả về gợi ý nào, chỉ tạo
> overhead (truy vấn MỚI cold 66s–2m5s). Luật pha 4: chỉ lớp nào chứng minh được
> net-positive mới default-on. Bật lại bằng `enableJevgrepEscalation: true` khi
> đã đo được lợi ích.

Lớp 5 liệt kê ứng viên bằng **TÊN file**. Đo trên một session thật (`777a1746`):
agent nhận hint file **0/4 lần** — hint nằm trong context mà agent không mở file
lần nào. Session đó chạy **152 lệnh `grep`/`find`/`rg` thô** và **0** lần dùng
skill `jevgrep` dù nó có trong catalog.

Lớp 8 bù đúng chỗ đó bằng CLI `jg` (skill `jevgrep`): nó hỏi Jev "hành vi này
nằm ở file/dòng nào" và trả về **trích nguồn verbatim**. Hai nhánh:

- **A. `agent/pre-step` (step 1)** — khi task của user đọc ra là "tìm X ở đâu"
  (`looksLikeSearchTask`). Nhánh này là **suy đoán từ chuỗi**, không phải bằng
  chứng agent đang mò, nên tách thành `jevGrepSearchTaskHeuristic` và **mặc định
  TẮT**.
- **B. `tools/post-execute`** — khi đã có `jevGrepSearchTaskThreshold` (3) lệnh
  dò tìm thô liên tiếp (`isRawSearchCommand`). Đây mới là bằng chứng đo được, nên
  là nhánh mặc định.

Ngưỡng 3 dựa trên đo: run dò-tìm liên tiếp dài nhất trong session thật — turn
tìm-kiếm 1/3/4/5/7/8 đều **≥3**; turn ngắn 2/9/10 chỉ **1**.

`jg` chạy **NỀN** (`jevGrepBackground: true`), kết quả chèn ở lần `pre-step` kế
tiếp — turn không bao giờ chờ. Vì sao: cache `jg` theo **từng truy vấn**, không
theo repo — truy vấn MỚI cold mất 66s–2m5s, nên bất kỳ timeout nào trong hook
await cũng sai (thấp thì không chạy được, cao thì treo turn). Vì sao không thay
hẳn Lớp 5: `jg` đo thật ~0.9s ấm / ~2.6s nguội, cộng vào mỗi turn là lãng phí.

**Kết quả nền chỉ được chèn khi task CHƯA đổi.** Mỗi lần chạy nền lưu vân tay
task gốc + root + turn; trước khi chèn, plugin so vân tay task hiện tại và root
hiện tại với gốc. Không khớp ⇒ **cache kết quả lại, KHÔNG chèn** (log `skip_stale`);
nếu user quay lại đúng task đó thì gợi ý được dùng lại. Lý do: `jg` chạy
nền có thể xong **sau khi user đã đổi task** — query A "authentication middleware
ở đâu" xong sau khi user chuyển sang "debug billing webhook"; chèn kết quả A vào
turn mới là context SAI + anchoring noise, không phải "gợi ý hơi cũ".

**Ô chờ key theo `session + hash(truy vấn) + root`** (không chỉ session). Vì sao:
key chỉ theo session thì một lần chạy nền của task A còn dở sẽ **chặn task B MỚI
leo thang** cho tới khi A xong (đo được: "task B escalation blocked by old task A
run: true"). Thêm hash truy vấn chuẩn hoá và root ⇒ task mới hoặc workspace khác
có ô riêng, còn cùng truy vấn trong cùng workspace không chạy trùng.

### Vì sao có lớp "Phục hồi khi tool lỗi" (Lớp 6)

Tool lỗi là tín hiệu rẻ và mạnh: nó cho biết bước vừa rồi đã sai. Trần
`failureMaxPerTurn` (2) để không nhắc lặp.

**Lỗi ĐÃ BIẾT được phân loại tất định, KHÔNG tốn round-trip Jev.** Phần lớn lỗi
rơi vào vài lớp mà cách xử lý đã rõ từ mã lỗi:

| Dấu hiệu | Nhánh |
|---|---|
| `ETIMEDOUT` / `ECONNRESET` / `socket hang up` | `retry` |
| `ENOENT` / `command not found` | `alternate` |
| `EADDRINUSE` | `alternate` |
| `SyntaxError` / `Unexpected token` | `alternate` |
| `EACCES` / `EPERM` / `permission denied` | `diagnose` |

Lỗi **không** khớp bảng nào mới hỏi Jev (phần nhập nhằng). Lỗi do chính plugin
sinh (`JEV_*`) không bao giờ bị phân loại ở đây.

**Sàn vòng xoáy**: plugin đếm số lần CÙNG một lỗi lặp lại, theo chữ ký chuẩn hoá
`(tool, dạng lệnh, vân tay lỗi)` keyed theo session. Cùng lỗi tái diễn ⇒ `retry`
không còn hợp lệ, **nâng lên `alternate`** — chặn vòng `retry → retry → retry`.

Lớp này **bỏ qua** lệnh bị chính Lớp 1 chặn: đó không phải tool lỗi mà là gate
chặn, và Lớp 1 đã có thông báo riêng. Nhận biết qua `error.info.code ===
'JEV_DESTRUCTIVE'`.

### Vì sao có lớp "Review chất lượng" (Lớp 7)

Khi turn kết thúc và diff đủ lớn (`reviewMinChangedLines`, 20 dòng), plugin tự
gọi `jev_review` (MCP) và báo điểm về cho agent như một báo cáo. Trần
`reviewMaxPerTurn` (1) để hook không gọi lặp.

### Vì sao không cần skill `jev-review` nữa

Trước đây plugin cài kèm một skill `jev-review` để agent tự gọi. MCP server
`jev-review` đã tự mang hướng dẫn, nên giữ một nguồn hướng dẫn duy nhất là MCP
server, cộng Lớp 7 tự gọi khi turn xong.

## Kiến trúc

Plugin là một lớp mỏng giữa **DSH engine** và **Jev API**. Nó chỉ đăng ký hook,
hỏi Jev một câu đóng, rồi trả quyết định về cho engine. Không đổi model, không
sinh nội dung, không giữ transcript.

```
dsh-jev-gate
│
├── LỚP 1 · gate phá dữ liệu          hook: tools/pre-execute
│   ├── LỚP 1₀ · prefilter chỉ-đọc (phân tích cục bộ, KHÔNG gọi Jev)
│   │   └── chứng minh được chỉ-đọc ──► cho chạy ngay (13,6% lệnh thật)
│   ├── LỚP 1ᶜ · cache verdict (khoá tool+command+cwd, KHÔNG gọi Jev)
│   │   └── trùng khoá + p cách ngưỡng xa ──► dùng lại verdict cũ (6,2%)
│   └── còn lại ──► hỏi Jev (noul): "lệnh này có phá dữ liệu không thể khôi phục?"
│       ├── p < 0.7  ──► cho chạy
│       └── p ≥ 0.7  ──► xét tiếp LỚP 1b
│
├── LỚP 1b · quyền của user            hook: tools/pre-execute (chỉ khi lớp 1 chặn)
│   └── provenance TẤT ĐỊNH (KHÔNG gọi Jev): target có trong yêu cầu THẬT của user?
│       ├── có ──► cho chạy (allow_authorized)
│       └── không ──► thẻ ĐỒNG Ý nổi (ctx.userQuestions), CHỜ user trả lời
│           ├── đồng ý rõ ràng ──► cho chạy (allow_consented)
│           └── từ chối/bỏ qua/hết hạn/không có kênh ──► CHẶN (deny_consent, fail-closed)
│
├── LỚP 2 · kiểm hoàn thành           hook: agent/turn-stopping
│   └── hỏi Jev (noul ×3): "xong chưa? có bằng chứng chưa? có cần thi hành không?"
│       ├── xong + có bằng chứng  ──► cho kết thúc lượt
│       └── chưa xong / thiếu bằng chứng ──► đẩy làm tiếp
│
├── LỚP 3 · chọn mức suy nghĩ         hook: agent/request
│   └── chế độ `input` (mặc định): Jev đọc yêu cầu user → low/high; còn lại medium
│       tín hiệu thất bại turn trước là SÀN (chỉ nâng, không hạ); sticky trong turn
│       └── ghi reasoningEffort  ──► provider và model GIỮ NGUYÊN
│
├── LỚP 4+5 · chọn hướng + chọn file  hook: agent/pre-step (chỉ step 1)
│   └── MỘT request Jev, hai loại câu:
│       ├── choice "hướng nào tối ưu?" (Lớp 4)
│       │   ├── one-command-scan   ──► "chạy 1 lệnh duy nhất, đừng chia việc"
│       │   ├── scripted-analysis  ──► "viết 1 script ngắn rồi đọc kết quả"
│       │   ├── parallel-workers   ──► "chia cho subagent chạy song song"
│       │   ├── guided-interview   ──► "hỏi lại user cho rõ trước"
│       │   └── no-op              ──► Jev khai "không đủ bằng chứng" (im lặng)
│       │       (chỉ chèn khi đỉnh phân phối ≥ 0.5 VÀ bỏ xa nhì ≥ 0.15;
│       │        đỉnh thấp, margin mỏng, hay no-op thắng → im lặng;
│       │        model tự quyết, plugin không tự làm)
│       └── noul ×N "file này có cần đọc không?" (Lớp 5 — MẶC ĐỊNH TẮT)
│           ├── plugin liệt kê ứng viên bằng TÊN file (readdir BFS + xếp hạng)
│           └── chèn "đọc file X" khi p ≥ 0.6, tối đa 3 file
│
├── LỚP 6 · phục hồi khi tool lỗi     hook: tools/post-execute
│   └── hỏi Jev (choice): "retry, đổi cách, điều tra, hay báo user?"
│       └── chèn gợi ý; bỏ qua lệnh bị chính Lớp 1 chặn
│
├── LỚP 7 · review chất lượng         hook: agent/turn-stopping
│   └── tự gọi tool MCP `jev_review` khi turn xong + diff ≥ 20 dòng
│
└── LỚP 8 · leo thang tìm nguồn       hook: agent/pre-step + tools/post-execute
    └── chạy `jg` (skill jevgrep) NỀN, chèn trích nguồn verbatim
```

### Vòng đời một lượt

```
user gửi tin nhắn
      │
      ▼
LỚP 4+5 · agent/pre-step (step 1)  chọn hướng + chọn file nạp context
      │                            → chèn gợi ý (không tự làm)
      ▼
LỚP 8 · agent/pre-step             việc là "tìm X ở đâu"? → chạy `jg` NỀN
      ▼
LỚP 3 · agent/request              mỗi lượt: Jev chọn reasoningEffort (low/high, else medium)
      │                            → ghi reasoningEffort, provider và model GIỮ NGUYÊN
      ▼
LLM sinh phản hồi hoặc gọi tool
      │
      ▼
LỚP 1 · tools/pre-execute          chỉ với bash/pwsh: lệnh này có phá dữ liệu không?
      │                            1₀ prefilter chỉ-đọc → cho chạy (không gọi Jev)
      │                            1ᶜ cache trùng khoá  → dùng lại verdict (không gọi Jev)
      │                            còn lại → hỏi Jev; p ≥ 0.7 thì qua LỚP 1b xét provenance
      ▼
LỚP 6 · tools/post-execute         tool vừa lỗi: retry / đổi cách / điều tra / báo user
      │                            → chèn gợi ý cho step kế tiếp
      ▼
LỚP 8 · tools/post-execute         sau N lệnh grep/find/rg LIÊN TIẾP không tiến triển:
      │                            → chạy `jg` MỘT lần, chèn trích nguồn verbatim
      ▼
LỚP 2 · agent/turn-stopping        khi model định dừng: xong chưa? có bằng chứng chưa?
      │                            → chưa xong hoặc thiếu bằng chứng thì đẩy làm tiếp
      ▼
LỚP 7 · agent/turn-stopping        lượt thật sự xong và diff đủ lớn
      │                            → tự gọi jev_review, báo điểm về như một báo cáo
      ▼
lượt kết thúc
```

> LỚP 4+5 và LỚP 8 (nhánh A) chỉ chạy một lần mỗi lượt (step 1). LỚP 3 móc vào
> **mỗi bước**, nhưng chỉ **hỏi Jev một lần mỗi lượt** rồi tái dùng (sticky); còn
> LLM, LỚP 1, LỚP 1b, LỚP 6 và LỚP 8 (nhánh B) **lặp lại** mỗi khi có tool call.
> Sơ đồ trên vẽ một vòng để dễ đọc.

## Cài đặt

Cần DSH `>= 0.1.0-rc.7` và một API key Jev ([typesafe.ai](https://typesafe.ai/)).

```bash
# cài
dsh plugin --profile web add git+https://github.com/dungle03/dsh-jev-gate.git

# cập nhật lên bản mới nhất
dsh plugin --profile web update dsh-jev-gate
```

Đặt key theo một trong hai cách:

```bash
# cách 1: biến môi trường
export TYPESAFE_API_KEY="apikey_..."
# cách 2: credential store của DSH (khuyên dùng — không phụ thuộc shell)
# thêm vào ~/.dsh/.credentials.yaml mục refs:
#   refs:
#     TYPESAFE_API_KEY: "apikey_..."
```

> Không có key? Prefilter chỉ-đọc vẫn hoạt động; với lệnh chưa chứng minh được là
> chỉ-đọc, Lớp 1 mặc định **hỏi đồng ý**, thiếu kênh hỏi hoặc hết hạn thì **chặn**.
> `gateFailureMode: block` chặn ngay; `auto_allow` chỉ là opt-in giữ hành vi cũ.
> Các lớp gợi ý khác tiếp tục fail-open. Đặt key rồi khởi động lại để bật Jev.

### Lớp 8 cần thêm CLI `jg` (tuỳ chọn)

Lớp 8 gọi CLI `jg` (skill `jevgrep`). Thiếu nó thì lớp tự tắt im lặng — không có
lỗi, không chặn gì. Cài `jg` rồi để nó trên `PATH`.

## Nguyên tắc vận hành

- **Lớp 1 fail-closed khi Jev gián đoạn.** `gateFailureMode: ask` (mặc định) hỏi
  bằng thẻ đồng ý; thiếu kênh hỏi, từ chối hoặc hết hạn thì chặn. `block` chặn
  ngay; `auto_allow` là opt-in tương thích hành vi cũ. Prefilter chỉ-đọc vẫn cho
  phép lệnh đã chứng minh không ghi. Sàn catastrophic chặn ở pre-execute và
  `ctx.tools.guard` monotonic. Các lớp tư vấn khác lỗi thì bỏ qua gợi ý.
  Sàn phân tích **toàn bộ chuỗi lệnh shell**, nên chuỗi `rm -rf /` nằm trong
  heredoc/script đang tạo cũng có thể bị chặn dù chưa thực thi; viết mẫu kiểm
  thử qua công cụ sửa file thay vì nhúng nguyên văn lệnh đó trong bash.
- **Timeout ngắn.** Gate phá dữ liệu chạy trong đường tới hạn của tool call:
  tối đa 2s gọi Jev, sau đó áp dụng `gateFailureMode`.
- **Pin model.** `jev-1.13.0` chứ không `jev-latest`, vì alias dịch chuyển khi
  có bản mới và câu trả lời có thể đổi mà không ai báo.
- **Ngưỡng theo hậu quả.** Gate xoá dữ liệu (0.7) khác ngưỡng kiểm hoàn thành
  (0.5) và gợi ý spawn (0.6). Không dùng một số chung.
- **Bounded state.** Chỉ gửi: goal/task (tối đa 1.500 ký tự), 6 tool result gần
  nhất (700 ký tự/mục), câu trả lời cuối (900 ký tự). Không bao giờ gửi cả
  transcript.
- **Không đổi model.** Plugin chỉ đọc `provider`/`model` và (tuỳ chọn) ghi
  `reasoningEffort`. Model của bạn không bao giờ bị đổi.
- **Có log kiểm được.** Mọi quyết định ghi vào
  `~/.local/share/dsh-jev-gate/decisions.jsonl` (quyền 0600).

## Cấu hình

Sửa trong profile (`~/.dsh/profiles/web/cordis.patch.yml`) hoặc qua trang Plugins.
Danh sách dưới đây khớp `DEFAULTS` và `Config` trong `lib/index.mjs`.
Đặt `profile: safe` chỉ bật gate/consent/completion; `balanced` (mặc định tương đương)
thêm effort/recovery/review; `experimental` bật cả 3 lớp tư vấn 4/5/8.
Profile không để các cờ xung đột tắt gate hoặc sàn tất định; các cấu hình
nghiêm hơn do người dùng đặt vẫn được giữ (`block`, tắt tự uỷ quyền/thẻ đồng ý,
hạ `destructiveThreshold`). Dùng `profile: custom` để giữ mọi cấu hình chi tiết.
Cả ba profile giữ gate phá dữ liệu; `gateFailureMode` mặc định là `ask`.
`shadowGateThreshold` chỉ ghi thêm `destructive_gate_shadow` với `would_flag`
so với `enforced_flag` cho các lệnh Jev đã chấm; nó không thay đổi quyết định
thực thi. Trường này không đo được tác động toàn hành trình agent.

```yaml
- id: jev-gate
  name: dsh-jev-gate
  config:
    profile: custom             # safe | balanced | experimental; mặc định custom
    destructiveThreshold: 0.7   # p >= ngưỡng này thì coi là phá dữ liệu
    shadowGateThreshold:          # tuỳ chọn 0..1; chỉ ghi phản thực tế, KHÔNG thay quyết định thật
    completionThreshold: 0.5    # p < ngưỡng này thì coi là chưa xong
    evidenceThreshold: 0.5      # p < ngưỡng này thì coi là thiếu bằng chứng
    executionThreshold: 0.5     # p >= ngưỡng này thì goal cần thi hành
    approachConfidenceThreshold: 0.3  # ngưỡng LÙI theo confidence (chỉ khi response thiếu probabilities)
    approachTopProbability: 0.5       # cổng bằng chứng: đỉnh phân phối phải ≥ mức này mới chèn gợi ý
    approachProbabilityMargin: 0.15   # cổng bằng chứng: đỉnh phải bỏ xa nhì ≥ margin này, nếu không im lặng
    contextFileThreshold: 0.6   # p >= ngưỡng này thì coi là file cần đọc
    contextCandidateLimit: 12   # số ứng viên tối đa đưa cho Jev chấm
    contextMaxFiles: 3          # số file tối đa nêu trong gợi ý
    contextEvidence: true       # §8: kèm đoạn trích THẬT (imports/exports/dòng khớp) — tắt = hành vi cũ chỉ-có-tên (để A/B)
    jevBudgetEnabled: true      # §16: ngân sách dùng chung; gate an toàn vẫn chạy dù hết hạn mức
    jevMaxCallsPerTurn: 4       # mức khởi đầu cần hiệu chỉnh trên phiên thực
    jevMaxCallsPerSession: 100  # chỉ đếm call Jev trực tiếp
    maxDecisionCostPerTurn: 16  # Jev trực tiếp=1, review=2, jg=8
    maxDecisionCostPerSession: 120
    reviewMaxPerSession: 20
    jevGrepMaxPerSession: 10
    maxPluginContextTokensPerTurn: 500  # §22: trần token văn bản plugin chèn mỗi turn (≈ chars/4); safety/consent/real_user KHÔNG BAO GIỜ bị cắt
    failureMaxPerTurn: 2        # số lần gợi ý phục hồi tối đa mỗi turn
    completionMaxPerTurn: 2     # trần số lần kiểm hoàn thành mỗi turn
    reviewMinChangedLines: 20   # diff nhỏ hơn thì không review
    reviewMaxPerTurn: 1         # trần số lần review mỗi turn
    reviewMaxDiffChars: 24000   # trần ký tự diff gửi cho review
    reviewServerName: jev-review
    reviewReportToAgent: true   # giữ hành vi cũ khi không đặt reviewMode
    # reviewMode: agent-feedback # telemetry | agent-feedback; tắt review bằng enableQualityReview
    reviewContextReserveTokens: 120
    reviewTimeoutMs: 15000
    gateTimeoutMs: 2000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 6000
    contextTimeoutMs: 6000
    failureTimeoutMs: 4000
    effortDecision: input      # 'input' = Jev đọc tin nhắn user; 'deterministic' = luật tín hiệu
    effortJevChoices: [low, high] # tập mức Jev được phép chọn (chế độ input)
    effortFallback: medium     # mức áp khi Jev lỗi/không quyết được (chế độ input)
    effortAbstain: false        # true = hỏi 2 câu noul (routine/hard), medium là ABSTAIN hợp lệ
    effortRoutineThreshold: 0.5 # ngưỡng trục routine của chế độ abstain
    effortHardThreshold: 0.5    # ngưỡng trục hard của chế độ abstain
    effortDefault: low          # mức mặc định ở chế độ deterministic
    effortEscalateTo: high      # mức nâng lên khi turn trước có tín hiệu thất bại (deterministic + SÀN chế độ input)
    effortEscalateToolErrors: 2   # ≥2 tool error trong turn trước thì nâng / làm sàn (mọi chế độ)
    effortEscalateTestFailures: 1 # ≥1 test fail trong turn trước thì nâng / làm sàn (mọi chế độ)
    jevGrepSearchTaskThreshold: 3  # số lệnh grep/find/rg LIÊN TIẾP thì leo thang; 0 = tắt nhánh B
    jevGrepSearchTaskHeuristic: false # nhánh A (task "nghe giống tìm-kiếm"); mặc định TẮT, xem lý do bên dưới
    jevGrepMaxPerTurn: 1        # trần số lần leo thang jevgrep mỗi turn
    jevGrepTimeoutMs: 120000     # ngân sách một lần `jg` (truy vấn MỚI cold 66s–2m5s); quá hạn thì fail-open
    jevGrepFailureBreaker: 3    # riêng theo session/root; 0 tắt breaker
    jevGrepBreakerCooldownMs: 60000 # một lần thăm dò sau cooldown
    jevGrepMaxConcurrentPerSession: 1 # chỉ nhận 0 hoặc 1; 0 tắt, truy vấn mới nhất thắng
    jevGrepMaxConcurrentGlobal: 2 # trần toàn plugin
    jevGrepPendingMax: 20
    jevGrepBackground: true     # chạy jg NỀN, không chặn turn (cold ~2 phút/truy vấn mới)
    jevGrepExcerptCap: 4000     # trần ký tự đoạn trích chèn vào context
    logDir:                     # thư mục log; bỏ trống = ~/.local/share/dsh-jev-gate (đường để test cô lập)
    enableDestructiveGate: true
    enableReadOnlyPrefilter: true       # lớp 1₀ — chứng minh chỉ-đọc thì bỏ qua Jev
    enableCatastrophicFloor: true       # sàn tất định — deny cứng, không fail-open
    enableGateVerdictCache: true        # lớp 1ᶜ — cache verdict theo (tool, command, cwd)
    gateVerdictCacheMax: 500            # trần số entry cache (FIFO + LRU-touch)
    gateVerdictCacheMargin: 0.1         # không cache khi |p − threshold| ≤ margin (Jev không tất định)
    enableAuthorizationOverride: true   # lớp 1b provenance — tắt thì chặn mọi lệnh phá dữ liệu
    gateFailureMode: ask                 # Jev lỗi: ask (mặc định), block hoặc auto_allow (opt-in cũ)
    enableDestructiveConsent: true      # lớp 1b — provenance không chứng minh được thì hỏi user bằng thẻ nổi
    consentTimeoutMs: 120000            # hết hạn thẻ đồng ý thì coi như từ chối (CHẶN)
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: false              # bật thử nghiệm khi A/B chứng minh lợi ích ròng
    enableContextTriage: false          # lớp chọn file nạp vào context (mặc định TẮT: cần A/B đo lại với bằng chứng file thật, xem §8)
    enableFailureRecovery: true         # lớp phục hồi khi tool lỗi
    enableQualityReview: true           # lớp tự gọi jev_review khi turn xong
    enableJevgrepEscalation: false      # lớp tìm nguồn thử nghiệm, bật khi đã đo lợi ích; cần `jg`
```

Khoá đã ngừng dùng (`effortReuseConfidence`, `effortMaxReuseSteps`,
`authorizationTimeoutMs`) sẽ được **cảnh báo rõ** khi nạp, không bỏ im lặng.

### Ngân sách Jev và đo hành trình đối chứng

Bộ quản lý chi phí giữ hạn mức đồng bộ trước khi chạy: Jev trực tiếp tốn 1 đơn vị,
review tốn 2 và mỗi lần `jg` tốn 8. Runtime chưa xác nhận trạng thái cache nên
không có mức chi phí riêng cho truy vấn đã được cache. Gate an toàn được miễn
hạn mức này; trần số call Jev trực tiếp cũ vẫn độc lập. Hạn mức đã giữ được tính
là đã tiêu kể cả khi thao tác lỗi sớm, để tránh vòng lặp thử lại. Nhật ký tách
chi phí giữ trước, việc gọi thực tế và kết quả thành công; số đơn vị không phải
số tiền API đã thanh toán. Cùng `operation_id` nối `reserved_cost`,
`actual_invocation` và `operation_finished`. `reserved_units` chỉ tính một lần;
`actual_invocations` đếm từng lần thử HTTP (kể cả retry), gọi tool review hoặc
khởi tạo tiến trình, phân biệt bằng `invocation_kind`. `completed` chỉ có nghĩa
lời gọi trả về thành công, không chứng minh agent chính đã dùng phản hồi.
Trạng thái cache của `jg` vẫn là `unknown`.

Review giữ chỗ cho phản hồi trong context trước RPC và giải phóng trong `finally`.
Chế độ `telemetry` không chèn phản hồi nên không giữ chỗ context. Khi bỏ qua
`reviewMode`, plugin giữ hành vi của `reviewReportToAgent`. Completion và review
kết hợp signal còn hoạt động của host với timeout riêng; signal đã hủy của host
cũ chỉ dùng timeout riêng.

Lớp 8 dùng quy tắc truy vấn mới nhất thắng: mỗi session chỉ giữ truy vấn repository
mới nhất, truy vấn cũ bị hủy. `jevGrepMaxConcurrentPerSession` chỉ nhận 1, hoặc 0
để tắt tìm nguồn trong session; không hỗ trợ giá trị lớn hơn 1. Trần toàn plugin
mặc định là 2 tiến trình, với tối đa 20 kết quả chờ. Breaker tách theo session/root,
cho một lần thăm dò sau cooldown. Hủy truy vấn không tính là lỗi dịch vụ. Giới hạn
được giải phóng sau khi tiến trình đóng; giới hạn tạm thời hoặc breaker mở không
làm mất cơ hội thử lại ở hook sau, nhưng trần lần chạy và chi phí vẫn áp dụng.

Đoạn nguồn của lớp 5/8 được escape và bọc thành dữ liệu repository không tin cậy,
không phải chỉ thị. Quyền chạy lệnh phá dữ liệu đòi hỏi yêu cầu mệnh lệnh đầy đủ,
đúng loại hành động và mọi target chính xác. Đường dẫn phân biệt chữ hoa/thường;
lời rút lại rõ ràng dù không nêu path vẫn làm yêu cầu cũ mất hiệu lực. Câu hỏi,
gợi ý, trích dẫn, yêu cầu vừa giữ vừa xóa, expansion chưa hiểu hoặc thao tác ghi
thêm target đều đi qua thẻ xác nhận.


`jevMaxCallsPerTurn: 4` và `jevMaxCallsPerSession: 100` là giới hạn khởi đầu,
chưa được hiệu chỉnh trên phiên thực. Khi cạn hạn mức, plugin bỏ các call tư vấn
trước, chừa chỗ cho kiểm hoàn thành và phục hồi; gate phá dữ liệu vẫn được chấm
và vẫn yêu cầu đồng ý khi Jev lỗi. **Call của gate an toàn (Lớp 1) KHÔNG tiêu trần không-an-toàn**: gate chạy cho mọi lệnh shell, nếu tính
chung thì một turn nhiều lệnh sẽ đốt hết ngân sách của completion/effort (log vận
hành từng ghi `turnUsed=29` với trần 4). Log `jev_budget` ghi lớp và lý do bỏ qua.
Trần văn bản `maxPluginContextTokensPerTurn: 500` chỉ tính nội dung **plugin chèn**,
không tính tin nhắn thật hay lý do chặn an toàn; đây là ước lượng ký tự/4, không
phải số token từ tokenizer của model.

`tools/benchmark-trajectory.mjs` đọc JSONL các lần chạy đã thu thập độc lập,
ghép theo `(task_id, seed)` để so sánh `vanilla` / `core` / `experimental` về
hoàn thành, test, thời gian, calls, tokens, chi phí, retry, đồng ý và nhãn an toàn:

```bash
node tools/benchmark-trajectory.mjs trajectories.jsonl --baseline vanilla --treatments core,experimental --json
```

Thiếu bất kỳ cặp đối chứng, nhãn an toàn, chỉ số hoàn thành/test, hoặc chưa có
bản ghi thực trên split `held-out` thì kết luận là `unknown` (ngoại lệ: phát
hiện một false-allow mới trong cặp đã đo thì báo `regression`). Công cụ chỉ phân
tích tệp đã cung cấp, không tự chạy DSH hay
xác minh trường `source: real`; cần tổ chức các phiên A/B thực và gán nhãn an
toàn độc lập trước khi bật các lớp thực nghiệm theo mặc định.

`tools/collect-trajectory.mjs` chạy pilot bốn nhánh trong thư mục cô lập qua DSH
headless thật. Chế độ `normal` **bắt buộc cả `TRAJECTORY_MODEL_KEY` và
`TYPESAFE_API_KEY`**: thiếu một trong hai thì collector dừng ngay, nêu rõ credential
nào thiếu và **không sinh record một phần** — vì `safe`/`balanced`/`experimental`
đều phụ thuộc Jev, thiếu key sẽ khiến các lớp fail-open và biến "vanilla vs profile"
thành "vanilla vs profile mất backend". Hành vi khi Jev outage là **mode riêng**
`--jev-outage` (chỉ cần model key), không trộn với benchmark hiệu năng thường:

```bash
node tools/collect-trajectory.mjs pilot.jsonl                # normal, cần cả hai key
node tools/collect-trajectory.mjs outage.jsonl --jev-outage # chỉ đo hành vi khi Jev outage
node tools/collect-trajectory.mjs all.jsonl --tasks navigation-marker-v1,bug-diagnosis-calc-v1 --seeds 1,2
```

`--tasks` nhận danh sách `task_id` từ catalog (mặc định một task); `--seeds` chạy
nhiều replication. Collector từ chối task/seed/flag sai **trước** khi spawn tiến
trình nào, và chỉ ghi row khi chạy thật xong.

Vì row được ghi dần, một lần chạy bị giết giữa chừng để lại file JSONL **thiếu
row** mà nhìn bề ngoài không khác file đầy đủ. Collector ghi kèm manifest
`<output>.manifest.json` với `status: complete`/`incomplete` và số row mong đợi;
`trajectory-matrix` đọc manifest và gắn `manifest_warning` khi file không đầy đủ
(hoặc thiếu manifest), để không phân tích nhầm một lần chạy dở thành bằng chứng.

Mỗi row mang `schema: dsh-jev-gate-trajectory-v2`, một **capability manifest**
(`configured`/`available`/`invoked` suy từ config boot, decisions.jsonl và preflight
thật — **không** suy từ tên arm), và **operation telemetry** lấy từ `cost_governor`
theo `operation_id` (`jev_http_attempts`, `review_tool_invocations`,
`jevgrep_process_spawns`, `decision_reserved_units`, `decision_actual_invocations`,
`decision_operation_failures`, `decision_operation_cancellations`). Jev, review và
jevgrep đều được tách `logical_operations` / `successful_operations` /
`failed_operations` / `skipped_operations` (ví dụ `jev_http_attempts`,
`review_tool_invocations`, `jevgrep_process_spawns`); đã đặt chỗ nhưng cạn ngân
sách là `skipped`, KHÁC lỗi vận hành thật. Số lần gọi
**thực tế** KHÔNG được suy từ số `jev_ok`: một logical call có thể retry thành 3
HTTP request. `jev_calls` được giữ để tương thích nhưng nay chỉ nghĩa là số
operation thành công (`jev_ok`), không phải số lần gọi HTTP. Task lấy từ catalog
`tools/trajectory-tasks.mjs` gồm sáu lớp (`routine`, `repository-navigation`,
`bug-diagnosis`, `tool-failure-recovery`, `destructive-intent-safety`,
`multi-file-coding`), mỗi task có evaluator tất định; task destructive chỉ chạm
thư mục fixture tạm. Công cụ ghi split `validation`, **không** tự nhận held-out.
Seed nhận diện lượt lặp và xoay thứ tự nhánh, không điều khiển ngẫu nhiên của
provider. Chỉ số thiếu giữ `null`; một pilot chưa chứng minh lợi ích hiệu năng.

Phân tích P2 dùng `tools/trajectory-matrix.mjs`, ghép đúng identity đầy đủ
`(task_id, seed, repo_state, model, benchmark_config_hash, dsh_version, plugin_version)`;
row sai schema (`trajectory-matrix-v1` trở xuống) bị **từ chối tường minh**, row
thiếu định danh vào `incomplete`, nhánh trùng bị loại. Promotion **không bao giờ tự
động**: trần là `eligible-for-review`, cần ≥10 nhóm held-out thật ghép cặp trên ≥2
lớp task, không thụt lùi an toàn/chất lượng. Nhóm có môi trường capability **không
hợp lệ** (thiếu hạ tầng, hoặc `available` chưa chứng minh) bị `hold` với lý do
machine-readable và **không tính là thụt lùi hiệu năng**. Cùng tên arm nhưng
`profile_config_hash` khác bị coi là treatment khác, không gộp bằng chứng. Chỉ số
chưa đo vẫn `null` (không tự thành 0), kết luận giữ `unknown`.

```bash
node tools/trajectory-matrix.mjs measured.jsonl
node tools/trajectory-matrix.mjs --self-test
node tests/dsh-compat.mjs --strict
```

**Validation ≠ bằng chứng held-out.** Một lần chạy thật không tự động là bằng
chứng promotion hợp lệ; tên profile không chứng minh mọi capability đã có. Vì vậy
**lợi ích hiệu năng vẫn chưa được chứng minh** cho tới khi có đủ nhóm held-out
ghép cặp; chưa có dữ liệu thì không được tuyên bố plugin nhanh hơn hay "thông minh
hơn".

Kiểm thử host thật bao phủ ToolRuntime, UserQuestionService, ReactLoopAgent,
việc tiếp tục turn, hook review và chọn effort. Phản hồi model/Jev bên ngoài,
câu trả lời UI và diff workspace dùng dữ liệu thay thế được ghi rõ. Việc tạo
được cấu hình CI không có nghĩa là CI từ xa hoặc live Jev đã PASS. Phải đọc kết
quả từng job; thiếu secret khiến live check bị bỏ qua, không phải chạy thành công.

## Kiểm chứng

```bash
bash verify.sh                    # kiểm offline, cấu hình, API thật và thẻ đồng ý; cần DSH + key
node tests/offline.mjs            # hồi quy toàn bộ các lớp, không cần secret
node tests/attack-corpus.mjs      # corpus tấn công độc lập — yêu cầu 0 lọt
node tests/benchmark.mjs          # bộ chấm nhãn độc lập, không gọi mạng/lệnh shell
node tests/metrics.mjs            # hợp đồng chỉ số và tách nhãn/canary
node tests/profiles.mjs           # safe/balanced/experimental và cấu hình chặt hơn
node tests/budget.mjs             # hạn mức Jev theo turn/session, ưu tiên an toàn
node tests/context.mjs            # trần và thứ tự ưu tiên văn bản plugin chèn
node tests/evidence.mjs           # trích file có giới hạn và rerank một batch
node tests/trajectory.mjs         # ghép cặp A/B offline, thiếu dữ liệu là unknown
node tests/docs-contract.mjs      # hai README đủ khóa/giá trị cấu hình, ngôn ngữ và phạm vi hỗ trợ
node tests/live-check.mjs         # 10 check, chỉ cần TYPESAFE_API_KEY + mạng
node tests/consent-integration.mjs # 10 check, cần DSH cục bộ (bỏ qua nếu không có)
```

- `verify.sh` — 8 mục: vị trí, cấu trúc, syntax, resolve dependency, đăng ký
  profile, log boot thật, gọi Jev thật với case đã biết đáp án, và thẻ đồng ý qua
  `UserQuestionService` thật. Exit 1 nếu hỏng.
- `tests/offline.mjs` — hồi quy không cần secret: ba chế độ lỗi gate, bất biến model,
  chỉ gate tool shell, guard của lớp 4, lọc tin nhắn user thật, hợp đồng export,
  prefilter vòng `for`, cache verdict (bất biến an toàn, không cache sát ngưỡng),
  provenance 1b end-to-end qua hook thật, câu hỏi effort TURN-LEVEL (khoá văn bản
  instructions + criteria qua đúng đường plugin), và Lớp 8 (parse output `jg`,
  nhận diện task tìm-kiếm / lệnh dò tìm thô, trần mỗi turn, fail-open). Test Lớp 8
  dùng một script `jg` **giả** trên PATH — không bao giờ gọi `jg` thật, nên chạy
  được trong CI không có mạng lẫn không có `jg`.
- `tests/attack-corpus.mjs` — corpus tấn công độc lập (56 vòng `for` nguy hiểm +
  16 lệnh phá luôn-deny + 11 cặp ngụy trang). Mutation test chứng minh corpus có
  răng: tiêm lỗi giả → 12–16/83 lọt, corpus báo LỖ HỔNG.
- `tests/live-check.mjs` — gọi Jev API thật với case đã biết đáp án.
- `tests/consent-integration.mjs` — chạy câu hỏi đồng ý của Lớp 1b qua
  `UserQuestionService` **thật** (import `dsh-user-questions` + `cordis` từ DSH
  cục bộ): câu hỏi hợp lệ qua được validation thật (không `BAD_INTENT`), `approve`
  sai / thiếu `detail` → `BAD_INTENT`, đồng ý + custom → refused, và đường hết
  hạn `askTimed` thật → `{pending:true}` → CHẶN. Bỏ qua (exit 0) khi máy không có
  DSH, nên CI không đỏ.
- `tools/repair-session-source.mjs` — vá session log cũ bị hỏng do bản < 0.3.1 ghi
  `source` dạng chuỗi trần (xem CHANGELOG 0.3.1). Chạy khi dsh đã tắt:

  ```bash
  node tools/repair-session-source.mjs --check   # chỉ liệt kê file cần vá
  node tools/repair-session-source.mjs           # vá mọi session trong $DSH_HOME
  ```

  Mỗi file được giữ bản gốc cạnh nó với hậu tố `.bak-sourcekind-<time>`, và bytes
  mới phải qua strict validation trước khi publish. File đang được tiến trình
  khác mở sẽ bị bỏ qua.

CI (GitHub Actions) chạy `offline.mjs` trên Node 20 + 22 cho mọi push/PR, và
`live-check.mjs` khi repo có secret `TYPESAFE_API_KEY`. Xem
[`.github/workflows/verify.yml`](.github/workflows/verify.yml).

Lịch sử thay đổi: [CHANGELOG.md](CHANGELOG.md).

## Số đo đã kiểm

Số đo trên **API thật** (`jev-1.13.0`) và **log quyết định thật**
(`~/.local/share/dsh-jev-gate/decisions.jsonl`). Log là file sống — số sẽ trôi;
mỗi hàng ghi rõ mốc.

### Cơ chế hiện tại (v0.14.0)

| Phép đo | Kết quả |
|---|---|
| Test offline (`tests/offline.mjs`) | **450+ check** PASS, 0 lỗi |
| Corpus tấn công (`tests/attack-corpus.mjs`) | **83 lệnh** — **0 lọt** |
| Bất biến an toàn (test offline) | **329 lệnh phá dữ liệu** — 0 lọt; fuzz 384+39 — 0 lọt |
| Prefilter phủ trên log thật (3.369 lệnh `allow`, 2026-10-02) | **13,6%** (459 lệnh) — trước v0.10.0 là 0,03% |
| Lệnh trùng lịch sử (không phải cache hit) | **~6,2%** trong mẫu cũ; log vận hành 2026-10-04 chỉ có **4 dòng `cached:true`** |
| Gate hữu dụng (`gate_useful_ratio`, 12.166 bản ghi) | **0,96%** — 117 deny / 12.166 lần chạy |
| Lớp 1b — call Jev mỗi lần gate chặn | **1** (destructive); trước v0.9.0 là 2 |
| Lớp 1b — provenance không chứng minh được | **0** call Jev bổ sung; hỏi user qua thẻ nổi, chờ đồng ý rõ ràng |
| Lớp 3 — call Jev cho effort | **1/lượt** (chế độ `input`); 0 ở chế độ `deterministic` |
| Model có bị đổi không? | không — bất biến qua mọi test |

### Lịch sử (các bản trước)

| Phép đo | Kết quả |
|---|---|
| Gate phá dữ liệu trên 20 lệnh thực tế | 20/20 đúng (recall 100%, precision 100%) |
| Deny có thật sự chặn thi hành? | có — canary còn nguyên sau `rm -rf` bị deny |
| Kiểm hoàn thành: có bằng chứng vs nói suông | 3/3 nhánh đúng |
| Lớp 1 fail-open (bản cũ, nay mặc định `ask`) | 3/3 pass tại thời điểm lịch sử; không mô tả mặc định hiện nay |
| Chọn hướng tiếp cận | 9/10 đúng (scan ổ đĩa → 1 lệnh; 5 chủ đề → song song; mơ hồ → hỏi lại) |
| Chọn file nạp — biên ngưỡng | file nên đọc **0.65–0.98**, file không liên quan **0.02–0.18** |
| Phục hồi khi tool lỗi, 6 lần/case | 4/4 case ổn định 6/6 mỗi case |
| Độ trễ Lớp 5 (13 câu gộp 1 request) | median 271ms — bằng một câu đơn |
| Độ trễ Lớp 6 (1 câu) | median 267ms |
| **Lớp 3 — dao động của cơ chế cũ (0.7.0)** | đổi `low↔high` **113/120** request; **54,5%** quyết định conf < 0,5 |
| **Lớp 2 — fail thật (0.7.0)** | **48/49** lần là `This operation was aborted` → bỏ `signal` ở 0.8.0 |
| **Lớp 1b — cơ chế cũ (≤0.8.2, câu hỏi `choice`)** | nội dung dán vào tự nhận quyền: **0/66** ra `authorized`; lệnh nguy hiểm không được yêu cầu: **0/48**; dọn dẹp hợp lệ user yêu cầu: **46/48** — **đã thay bằng provenance tất định ở v0.9.0** |
| **Lớp 7 — `jev_review` (0.4.1)** | chạy thật lần đầu: `decision:"reviewed"`, 154 dòng / 3 file |
| **Lớp 8 — độ trễ `jg` thật** | **~0.9s ấm** (có cache), **~2.6s nguội**; E2E qua handler thật 2.4s |
| **Lớp 8 — E2E với `jg` thật** | chèn đúng excerpt verbatim 2 file (`handler.js`, `auth.js`) |
| Độ trễ mỗi gate | median ~250ms (Lớp 1b tất định, không thêm call LLM) |

## Điều plugin này KHÔNG làm

- **Không route model.** Không đổi model, chỉ (tuỳ chọn) đổi effort.
- **Không lập kế hoạch hay sinh nội dung.** Jev chỉ trả xác suất cho một câu hỏi
  đóng; LLM vẫn là thứ hiểu và làm.
- **Không tự làm theo hướng đã chọn.** Lớp 4 chỉ *gợi ý* hướng; API `agent` của
  DSH không phơi cách gọi tool trực tiếp, nên model tự quyết. Không đảm bảo model
  nghe theo — và Jev chọn hướng sai khoảng 1/10 lần trong phép đo.
- **Không tự đọc file cho model.** Lớp 5 chỉ *nêu tên* file đáng đọc; việc đọc
  vẫn do model gọi tool. Nó cũng không đọc nội dung file nào để chấm — chỉ đọc
  TÊN file trong workspace.
- **Lớp 8 có đọc nội dung, nhưng chỉ khi được kích hoạt.** Khi việc là "tìm X ở
  đâu" (hoặc agent đã mò bằng nhiều lệnh `grep` liên tiếp), Lớp 8 chạy `jg` để
  lấy trích nguồn verbatim. Nó **không** sửa file, **không** chạy gì khác, và
  **không** thay thế việc đọc file thật — gợi ý luôn kèm câu "kiểm lại với file
  thật trước khi sửa". Cần CLI `jg`; thiếu thì lớp tự tắt im lặng.
- **Không tự sửa theo điểm review.** Lớp 7 chỉ báo điểm về cho agent; agent tự
  quyết có nên cải thiện thêm không.
- **Không thay thế phán đoán của agent.** Một khuyến nghị không phải uỷ quyền.

## Gỡ

```bash
dsh plugin --profile web remove dsh-jev-gate
rm -rf ~/.local/share/dsh-jev-gate
```

## License

MIT
