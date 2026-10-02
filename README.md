# dsh-jev-gate

[English](README.en.md) · **Tiếng Việt**

![Kiến trúc dsh-jev-gate](assets/architecture.png)

*Sơ đồ tương tác (pan/zoom, đổi theme sáng/tối, tìm kiếm): mở
[`assets/architecture.html`](assets/architecture.html) trong trình duyệt.*

Đưa [Jev](https://typesafe.ai/) (TypeSafe System One) vào **tám khoảnh khắc đắt
giá** của [DeepSeek Harness](https://github.com/deepseek-ai/dsh), theo nguyên tắc:

> **LLM hiểu và làm. Jev chỉ trả lời câu hỏi ĐÓNG ở khoảnh khắc mà một quyết
> định sai gây tốn kém.**

Jev không sinh văn bản, không lập kế hoạch, không viết code. Nó chỉ chấm một câu
hỏi đóng và trả về xác suất. Plugin này dùng Jev làm **tám chốt chặn**, không
phải làm bộ não thứ hai.

## Tám lớp

| Lớp | Hook | Câu hỏi | Kiểu | Mặc định |
|---|---|---|---|---|
| **1** · Gate phá dữ liệu | `tools/pre-execute` | Lệnh này có phá dữ liệu không thể khôi phục? | `noul` | **bật** |
| **1₀** · Prefilter chỉ-đọc | `tools/pre-execute` (trước lớp 1) | (phân tích cục bộ — không gọi Jev) | — | **bật** |
| **1ᶜ** · Cache verdict | `tools/pre-execute` (trước khi gọi Jev) | (khoá `tool+command+cwd` — không gọi Jev) | — | **bật** |
| **1b** · Quyền của user | `tools/pre-execute` (chỉ khi lớp 1 chặn) | (provenance tất định — không gọi Jev) | — | **bật** |
| **2** · Kiểm hoàn thành | `agent/turn-stopping` | Xong chưa? Có bằng chứng chưa? Có cần thực thi không? | `noul` ×3 | **bật** |
| **3** · Chọn effort | `agent/request` | (luật tất định — không gọi Jev) | — | **bật** (sticky theo turn) |
| **4+5** · Chọn hướng + chọn file nạp | `agent/pre-step` (step 1) | Hướng nào tối ưu? File nào cần đọc trước? | `choice` + `noul` ×N | **bật** |
| **6** · Phục hồi khi tool lỗi | `tools/post-execute` | Tool vừa lỗi — retry, đổi cách, điều tra, hay báo user? | `choice` | **bật** |
| **7** · Review chất lượng | `agent/turn-stopping` | (tự gọi `jev_review` khi turn xong và diff đủ lớn) | tool MCP | **bật** |
| **8** · Leo thang tìm nguồn | `agent/pre-step` + `tools/post-execute` | (chạy `jg` khi việc là "tìm X nằm ở đâu") | CLI `jg` | **bật** |

Ba lớp **không gọi Jev**: **1₀** (prefilter chỉ-đọc), **1ᶜ** (cache verdict), **1b**
(provenance quyền user) và **3** (chọn effort). Đây là các quyết định suy ra được
từ cú pháp lệnh / exit code / nguồn gốc — nguyên tắc: cái gì code suy ra được thì
đừng gọi model.

Lớp 3 KHÔNG gọi Jev. Mặc định `low`; nâng `high` chỉ khi turn trước có bằng chứng
thất bại ĐO ĐƯỢC (≥2 tool error hoặc ≥1 test fail). Sticky trong turn.

**Vì sao bỏ classifier per-request (2026-10-01).** Đo trên 120 request liên tiếp:
cơ chế cũ đổi mức `low↔high` **113/120 lần**, 54,5% quyết định có confidence
< 0,5, và chiếm **55%** token Jev với mỗi call ~281ms nằm TRÊN đường tới hạn. Đó
là lớp tốn kém nhất để đổi một quyết định gần như ngẫu nhiên. Research: tín hiệu
đo được thắng tín hiệu đoán độ khó (arXiv 2505.00127), và router per-step chỉ
thắng khi là model nhỏ đã TRAIN (<5ms, arXiv 2603.07915) — không phải API
classifier 1.180 token.

Ghi chú cache (vẫn đúng, nhưng không còn là lý do chính): trên router này đổi
effort **không** xoá prompt cache — đo được 96% cache hit sau khi đổi.

### Vì sao có lớp "Chọn file nạp vào context"

Đây là mục tiêu chi phí rõ nhất. Phần lớn token đầu vào bị đốt vào việc model tự
đi tìm file liên quan bằng một chuỗi tool call (`glob` → `grep` → `read` → `read`
lại), trong khi phần lớn token đó chỉ để trả lời câu hỏi "file nào đáng đọc".

Plugin liệt kê ứng viên bằng **tên file** (một lần `readdir` theo chiều rộng, có
xếp hạng theo token khớp trong task), rồi hỏi Jev một câu `noul` cho **mỗi** ứng
viên. Mọi câu đi trong **cùng một request**, nên 13 câu gộp tốn 271ms — bằng một
câu đơn. Host so ngưỡng `contextFileThreshold` (0.6), xếp theo xác suất rồi cắt
còn `contextMaxFiles` (3).

Vì sao N câu `noul` chứ không một `choice` nhiều nhánh: danh sách file sinh động
theo từng repo, mà `choice.criteria` phải cố định trong code — không dựng được
criteria từ danh sách runtime.

Số đo trên API thật (`jev-1.13.0`), sau khi sửa prompt ở 0.3.2:

| Case | File nên chọn | p | File không liên quan |
|---|---|---|---|
| Bug phiên đăng nhập | `src/auth/session.ts` | **0.88–0.90** | `README.md` 0.06, `assets/logo.svg` 0.02 |
| Đổi màu logo | `assets/logo.svg` | **0.94** | mọi file khác 0.02–0.03 |
| Thêm migration | `src/db/migrations/0012.sql` | **0.87** | `src/auth/session.ts` 0.10 |
| Viết tài liệu onboarding | `docs/onboarding.md` | **0.65** | `package.json` 0.07 |

Trước 0.3.2, hai case "tạo artifact mới" chỉ đạt **0.39** và **0.34** — dưới ngưỡng
0.6. Prompt thiếu nhánh "file anh em cùng loại định nghĩa format cho artifact mới".
Xem CHANGELOG 0.3.2 để có bảng trước/sau và ba bộ kiểm định.

### Vì sao có lớp "Leo thang tìm nguồn" (Lớp 8)

Lớp 5 liệt kê ứng viên bằng **TÊN file**. Đo trên một session thật (`777a1746`,
2026-09-30), nó hint `weknora-dsh-setup-guide.md` ở **4 turn liên tiếp** và agent
**không đọc file đó một lần nào** (0/4). Cùng session: **152** lệnh `grep`/`find`/
`rg` thô, **0** lần dùng skill `jevgrep` dù nó có trong catalog. Tên file không
đủ để model tin, và model thà tự mò.

Lớp 8 bù đúng chỗ đó bằng CLI `jg` (skill `jevgrep`): nó hỏi Jev "hành vi này nằm
ở đâu?" và trả về **danh sách file + khoảng dòng + trích nguồn verbatim** trong
một lần chạy. Đây là nội dung, không phải tên — nên nó trả lời được câu hỏi mà
model thật sự có.

Leo thang ở hai thời điểm, cùng một hành động:

- **A. `agent/pre-step` (step 1)** — khi task của user đọc ra là "tìm X ở đâu"
  (`chỗ nào xử lý`, `tìm file nào`, `where is X handled`, `which file implements`,
  `trace this bug`). Chạy trước khi agent kịp tiêu phí lệnh nào.
- **B. `tools/post-execute`** — khi đã có `jevGrepSearchTaskThreshold` lệnh dò
  tìm thô **liên tiếp** trong cùng turn. Bắt ca task không tự khai là tìm-kiếm
  nhưng thực tế agent đang mò.

Ngưỡng 3 không phải số đoán. Đo run dò-tìm liên tiếp dài nhất mỗi turn trên
session thật: turn tìm-kiếm (1, 3, 4, 5, 7, 8) đều **≥3**; turn trả lời ngắn
(2, 9, 10) chỉ **1**. Lệnh không phải dò tìm thì reset chuỗi — vòng xoáy là các
lệnh *liên tiếp*.

Vì sao không thay hẳn Lớp 5: `jg` đo thật **~0.9s ấm / ~2.6s nguội**, cộng vào
step 1 của *mọi* turn kể cả turn không phải việc tìm kiếm. Leo thang có điều kiện
giữ turn thường rẻ. Trần `jevGrepMaxPerTurn` (1) chặn gọi lặp.

Như mọi lớp khác: **fail-open tuyệt đối**. `jg` không có trên PATH, thoát khác 0,
timeout, hay trả rỗng → im lặng bỏ qua, việc đi tiếp. Chỉ **chèn gợi ý** kèm
escape clause, không tự sửa file, không tự chạy gì khác.

### Vì sao có lớp "Phục hồi khi tool lỗi"

Một tool lỗi thường khiến model thử lại y hệt vài lần rồi mới đổi cách — mỗi lần
thử là một generation đầy đủ. Một câu hỏi 250ms trả lời thay. Bốn nhánh là bốn
tình huống khác nhau về bản chất nên không phải chọn ngưỡng: `retry` (lỗi tạm
thời), `alternate` (cách sai, đổi cách), `diagnose` (chưa hiểu vì sao), và
`stop-and-report` (không tự vượt được).

Lớp này **bỏ qua** lệnh bị chính Lớp 1 chặn: đó không phải tool lỗi mà là gate
chặn, và Lớp 1 đã có thông báo riêng. Nhận biết qua `error.info.code ===
'JEV_DESTRUCTIVE'`. Có trần `failureMaxPerTurn` để một lệnh lỗi lặp lại không
sinh vô hạn gợi ý.

Số đo (`jev-1.13.0`, 6 lần/case, ổn định 6/6 mỗi case):

| Lỗi | Nhánh Jev chọn | Kỳ vọng |
|---|---|---|
| `request timed out after 30000ms` | `retry` | retry ✓ |
| `cat: ... No such file or directory` | `alternate` 0.81 | alternate ✓ |
| test fail, chưa rõ lý do | `diagnose` 0.95 | diagnose ✓ |
| `AWS_ACCESS_KEY_ID not set` | `stop-and-report` 0.93 | stop-and-report ✓ |
| `ECONNREFUSED 127.0.0.1:5432` | `diagnose` | diagnose ✓ (DB không chạy thì retry vô nghĩa) |

### Vì sao có lớp "Review chất lượng"

Đo trên 110 session thật: tool `mcp__jev-review__jev_review` **được đăng ký và có
trong prompt** (section `mcp:jev-review` do `dsh-mcp-client` chèn), nhưng được
gọi **1 lần duy nhất** — và đó là lần tác giả plugin tự test. Trong công việc
thật: **0 lần**.

Nghĩa là "có tool" không bằng "tool được dùng". Mọi kênh Jev trừ `dsh-jev-gate`
đều **thụ động**: MCP tool, skill, và CLI đều chờ agent quyết định gọi. Chỉ hook
engine là chạy tự động. Nên lớp này cắm `jev_review` vào hook `turn-stopping`.

Bốn chốt chống lạm dụng, vì hook này chặn turn:

| Chốt | Điều kiện | Vì sao |
|---|---|---|
| 1 | Chỉ khi turn thật sự kết thúc | Review code dở dang là vô nghĩa |
| 2 | Chỉ turn chính (`delegationDepth === 0`) | Subagent không sở hữu workspace change; review ở đó nhân số lần gọi theo số worker |
| 3 | Diff ≥ `reviewMinChangedLines` (20 dòng) | Review diff rỗng hay sửa typo là đốt tiền không đổi lại gì |
| 4 | Trần `reviewMaxPerTurn` (1) | Không có nó thì mỗi lần turn-stopping là một lần gọi |

Điểm số trả về qua `agent.steer` dưới dạng **báo cáo**, không phải mệnh lệnh:
điểm là bằng chứng, không phải mục tiêu để tối ưu.

Đo độ trễ: `jev_review` mất ~100ms khi API khoẻ, ~0,7–2,5s khi API chậm. Nếu tool
vắng, service vắng, hay review lỗi → **fail-open**, turn vẫn kết thúc bình thường.

### Vì sao không cần skill `jev-review` nữa

Trước đây tồn tại song song hai thứ dạy agent dùng `jev_review`: một **skill**
`jev-review`, và **hướng dẫn của chính MCP server** (1.242 ký tự, do
`dsh-mcp-client` chèn vào system prompt qua `systemPrompt.section`).

Đo trên 115 session thật: hướng dẫn MCP có mặt trong **26 session**. Nghĩa là nó
tới model **độc lập với skill**. So sánh nội dung cho thấy phần lớn skill trùng
với hướng dẫn MCP — vòng lặp chấm→sửa→chấm lại, baseline, `previousEvaluation`,
không lặp lời gọi, không game điểm.

Và skill **chưa từng dẫn tới một lời gọi review nào trong công việc thật**. Kiểm
4 lần `jev_review` từng được gọi:

| Session | Skill gọi trước? | Ai gọi |
|---|---|---|
| `f5a2e8a7` | có | tác giả test (`Add a clamp helper`) |
| `6865243e` | **không** | test tích hợp MCP (`Smoke-test the DSH MCP integration`) |

Cả 4 lần đều là test, không phải công việc thật. Nên skill đã được **xoá** — chỉ
giữ một nguồn hướng dẫn duy nhất là MCP server, cộng Lớp 7 tự gọi khi turn xong.

Tool `jev_review` vẫn nguyên: đăng ký qua `mcp-jev-review`, agent vẫn gọi được,
hướng dẫn vẫn vào prompt.

### Vì sao có lớp "Prefilter chỉ-đọc"

Lớp 1 gọi Jev cho **mọi** lệnh `bash`. Đo trên log thật (2026-09-27 → 09-30):
5.600 call, trong đó **80,7%** có `p ≤ 0.02` — tức phần lớn là round-trip API để
nghe lại điều suy ra được bằng phân tích cú pháp cục bộ rẻ hơn hàng nghìn lần.
Ở p50 289ms và 718 token/call, đó là khoản chi lớn nhất của gate.

`lib/readonly.mjs` trả `true` chỉ khi **chứng minh được** lệnh không thể ghi.

**v0.10.0 — thêm vòng `for..do..done`.** Phân tích ở tầng token: một vòng
`for VAR in <list literal>; do <body>; done` được coi là chỉ-đọc khi thân — sau
khi thay `$VAR` bằng placeholder **không phải lệnh** (`__LOOPVAR__`) — chứng minh
được là chỉ-đọc. Mọi nghi ngờ (`$()`/backtick/heredoc/redirect ghi/`$VAR` ở vị trí
lệnh/for lồng) → `false`.

Đo trên log thật (3.260 lệnh `allow` của gate): prefilter phủ **0,03%** trước
v0.10.0 → **14,0%** sau (457 lệnh nhận, 455 trong đó chứa token `for`).

Ba lần đo liên tiếp cho thấy quét regex sai theo cả hai hướng — bản đầu dùng
`\bdsh\b` để chặn lệnh `dsh` nhưng khớp luôn đường dẫn `~/.dsh/` và giết oan
2.100 lệnh (phủ sót tụt còn 2,3%); bản hai tính `>` trong nháy
(`sed 's/x/=<set>/'`) là redirect ghi. Bản cuối là **tokenizer có ghi nhớ nháy**,
xét tên lệnh theo **vị trí** thay vì khớp chuỗi.

Đây KHÔNG phải nới lỏng bảo vệ. Mọi nghi ngờ — heredoc, backtick, redirect ghi,
`$()` (kể cả trong nháy kép), `find -delete`, `sed -i`, `git reset`, trình thông
dịch, lệnh lạ — đều rơi xuống đường Jev như cũ. `tests/offline.mjs` chạy **329
lệnh phá dữ liệu** và yêu cầu **0 lệnh được phép lọt**, cộng **384 + 39 biến thể
fuzz**. `tests/attack-corpus.mjs` chạy thêm **83 lệnh tấn công** độc lập (56 vòng
for nguy hiểm + 16 luôn-deny + 11 cặp ngụy trang) — yêu cầu **0 lọt**.

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

### Vì sao có lớp "Quyền của user"

Gate phá dữ liệu cũ **không phân biệt được rác session với dữ liệu thật**. Log
thật cho thấy `rm -rf /tmp/gtest` (thư mục test do chính session tạo) bị chặn ở
p=0.77, trong khi `rm -rf <path không tồn tại>` chỉ 0.40 — nên dọn rác hợp lệ bị
chặn oan và phải thử lại nhiều lần (một lệnh bị chặn **7 lần** liên tiếp).

Lớp này chỉ chạy **khi** lớp 1 đã kết luận lệnh là phá dữ liệu, và chỉ để trả
lời một câu: user có tự tay yêu cầu xoá đúng thứ đó không. Chặn chỉ xảy ra khi
hội đủ hai điều — **phá dữ liệu VÀ không được user yêu cầu**:

```
p ≥ 0.7  ──► kiểm provenance: target có trong yêu cầu THẬT của user?
              ├── có    ──► CHO CHẠY  (allow_authorized)
              └── không / không chứng minh được ──► CHẶN (deny)
```

**v0.9.0 — bỏ call LLM thứ hai.** Bản cũ hỏi Jev một câu `choice` ("user có yêu
cầu không?") — một round-trip nữa nằm TRÊN đường tới hạn của mọi lệnh bị chặn.
Nay suy quyền từ **provenance tất định**: trích target của lệnh (đường dẫn/tên
file của `rm`/`mv`/`truncate`/…) rồi so khớp chuỗi con với tin nhắn **thật** của
user. Đo trên hook thật: trước = **2** request Jev mỗi lần gate chặn
(`destructive` + `authorized`), sau = **1** (`destructive`), và khi không chứng
minh được thì **0** request bổ sung.

Bằng chứng `user_request` **chỉ** lấy tin nhắn thật của user (`source.kind ===
'user'`). Trước đây `notePrompt` gộp mọi message `role=user` — kể cả output job
nền (`tool-jobs`) và gợi ý do chính plugin chèn — nên nội dung không tin cậy có
thể lọt vào trường "yêu cầu của user". Provenance tất định dùng đúng nguồn này.

Lớp này **fail-closed**: không chứng minh được thì CHẶN. Khác lớp 1 (fail-open) —
vì đây là lớp phòng thủ, "không biết" phải nghiêng về phía an toàn.

### Vì sao có lớp "Cache verdict" (1ᶜ)

Gate gọi Jev cho mỗi lệnh `bash`. Đo trên log thật: **~6,4%** lệnh `allow` là
**chuỗi trùng y hệt** (cùng tool + command + cwd) — round-trip thuần lãng phí,
vì verdict cho một lệnh byte-identical là cùng một phân phối.

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

## Kiến trúc

Plugin là một lớp mỏng giữa **DSH engine** và **Jev API**. Nó chỉ đăng ký hook,
hỏi Jev một câu đóng, rồi trả quyết định về cho engine. Không đổi model, không
sinh nội dung, không giữ transcript.

```
dsh-jev-gate
│
├── LỚP 1 · gate phá dữ liệu          hook: tools/pre-execute
│   ├── LỚP 1₀ · prefilter chỉ-đọc (phân tích cục bộ, KHÔNG gọi Jev)
│   │   └── chứng minh được chỉ-đọc ──► cho chạy ngay (14,0% lệnh thật)
│   ├── LỚP 1ᶜ · cache verdict (khoá tool+command+cwd, KHÔNG gọi Jev)
│   │   └── trùng khoá + p cách ngưỡng xa ──► dùng lại verdict cũ (6,4%)
│   └── còn lại ──► hỏi Jev (noul): "lệnh này có phá dữ liệu không thể khôi phục?"
│       ├── p < 0.7  ──► cho chạy
│       └── p ≥ 0.7  ──► xét tiếp LỚP 1b
│
├── LỚP 1b · quyền của user            hook: tools/pre-execute (chỉ khi lớp 1 chặn)
│   └── provenance TẤT ĐỊNH (KHÔNG gọi Jev): target có trong yêu cầu THẬT của user?
│       ├── có ──► cho chạy (allow_authorized)
│       └── không / không chứng minh được ──► CHẶN (fail-closed)
│
├── LỚP 2 · kiểm hoàn thành           hook: agent/turn-stopping
│   └── hỏi Jev (noul ×3): "xong chưa? có bằng chứng chưa? có cần thi hành không?"
│       ├── xong + có bằng chứng  ──► cho kết thúc lượt
│       └── chưa xong / thiếu bằng chứng ──► đẩy làm tiếp
│
├── LỚP 3 · chọn mức suy nghĩ         hook: agent/request
│   └── LUẬT TẤT ĐỊNH (KHÔNG gọi Jev): mặc định low; nâng high khi turn
│       trước có ≥2 tool error hoặc ≥1 test fail; sticky trong cùng turn
│       └── ghi reasoningEffort  ──► provider và model GIỮ NGUYÊN
│
├── LỚP 4+5 · chọn hướng + chọn file  hook: agent/pre-step (chỉ step 1)
│   └── MỘT request Jev, hai loại câu:
│       ├── choice "hướng nào tối ưu?" (Lớp 4)
│       │   ├── one-command-scan   ──► "chạy 1 lệnh duy nhất, đừng chia việc"
│       │   ├── scripted-analysis  ──► "viết 1 script ngắn rồi đọc kết quả"
│       │   ├── parallel-workers   ──► "chia cho subagent chạy song song"
│       │   └── guided-interview   ──► "hỏi lại user cho rõ trước"
│       │       (conf < 0.3 thì im lặng; model tự quyết, plugin không tự làm)
│       └── noul ×N "file này có cần đọc không?" (Lớp 5)
│           ├── plugin liệt kê ứng viên bằng TÊN file (readdir BFS + xếp hạng)
│           ├── p ≥ 0.6 → giữ, xếp giảm dần, cắt còn contextMaxFiles (3)
│           └── chèn "đọc các file này trước" — gợi ý, không phải giới hạn
│
├── LỚP 6 · phục hồi khi tool lỗi        hook: tools/post-execute
│   └── chỉ khi tool thật sự lỗi (bỏ qua deny của Lớp 1):
│       ├── retry           ──► "lỗi tạm thời, chạy lại y hệt một lần"
│       ├── alternate       ──► "cách sai, đổi tool/flag/path khác"
│       ├── diagnose        ──► "chưa hiểu vì sao, điều tra trước"
│       └── stop-and-report ──► "không tự vượt được, báo user"
│           (trả qua additionalContexts → engine splice vào step kế tiếp)
│
├── LỚP 7 · review chất lượng           hook: agent/turn-stopping
│   └── tự gọi `jev_review` (MCP) khi turn kết thúc:
│       ├── bốn chốt: turn thật sự xong / turn chính / diff ≥ 20 dòng / trần 1
│       ├── ghép unified diff từ service workspaceChanges
│       └── điểm số → agent.steer (báo cáo, không phải mệnh lệnh)
│
├── LỚP 8 · leo thang tìm nguồn         hook: agent/pre-step + tools/post-execute
│   └── chạy `jg` (skill jevgrep) MỘT lần khi việc là "tìm X ở đâu":
│       ├── A. step 1: task đọc ra là tìm-kiếm (chỗ nào / where is / which file)
│       ├── B. sau N lệnh grep/find/rg LIÊN TIẾP không tiến triển
│       ├── `jg` trả file + khoảng dòng + trích nguồn verbatim → chèn gợi ý
│       └── không có `jg` / lỗi / timeout / rỗng → im lặng, fail-open
│
└── mọi quyết định ──► ~/.local/share/dsh-jev-gate/decisions.jsonl
```

Mọi lần gọi Jev đều **fail-open**: Jev lỗi, chậm, hay trả rác thì việc đi tiếp
như chưa từng có Jev.

**Một lượt chạy qua các lớp** — các chốt chặn ở những thời điểm khác nhau:

```
User gõ prompt
      │
      ▼
LỚP 4+5 · agent/pre-step   chỉ step 1, MỘT request Jev:
      │                    hướng nào tối ưu + file nào cần đọc trước
      ▼
LỚP 8 · agent/pre-step     chỉ step 1, chỉ khi task là "tìm X ở đâu":
      │                    → chạy `jg`, chèn trích nguồn verbatim (không sửa gì)
      ▼
LỚP 3 · agent/request      mỗi lần gọi model: chọn reasoningEffort (luật tất định)
      │                    → ghi reasoningEffort, provider và model GIỮ NGUYÊN
      ▼
LLM sinh phản hồi hoặc gọi tool
      │
      ▼
LỚP 1 · tools/pre-execute  chỉ với bash/pwsh: lệnh này có phá dữ liệu không?
      │                    1₀ prefilter chỉ-đọc → cho chạy (không gọi Jev)
      │                    1ᶜ cache trùng khoá  → dùng lại verdict (không gọi Jev)
      │                    còn lại → hỏi Jev; p ≥ 0.7 thì qua LỚP 1b xét provenance
      ▼
LỚP 6 · tools/post-execute tool vừa lỗi: retry / đổi cách / điều tra / báo user
      │                    → chèn gợi ý cho step kế tiếp
      ▼
LỚP 8 · tools/post-execute sau N lệnh grep/find/rg LIÊN TIẾP không tiến triển:
      │                    → chạy `jg` MỘT lần, chèn trích nguồn verbatim
      ▼
LỚP 2 · agent/turn-stopping khi model định dừng: xong chưa? có bằng chứng chưa?
      │                     → chưa xong hoặc thiếu bằng chứng thì đẩy làm tiếp
      ▼
LỚP 7 · agent/turn-stopping lượt thật sự xong và diff đủ lớn
      │                     → tự gọi jev_review, báo điểm về như một báo cáo
      ▼
lượt kết thúc
```

> LỚP 4+5 và LỚP 8 (nhánh A) chỉ chạy một lần mỗi lượt (step 1). LỚP 3 chạy ở
> **mỗi bước**, còn LLM, LỚP 1, LỚP 1b, LỚP 6 và LỚP 8 (nhánh B) **lặp lại**
> mỗi khi có tool call. Sơ đồ trên vẽ một vòng để dễ đọc.

## Cài đặt

Cần DSH `>= 0.1.0-rc.7` và một API key Jev ([typesafe.ai](https://typesafe.ai/)).

```bash
# cài
dsh plugin --profile web add git+https://github.com/dungle03/dsh-jev-gate.git

# cập nhật lên bản mới nhất
dsh plugin --profile web add git+https://github.com/dungle03/dsh-jev-gate.git
```

Rồi đặt key Jev (một trong hai cách):

```bash
# cách 1: biến môi trường
export TYPESAFE_API_KEY="apikey_..."

# cách 2: credential store của DSH (khuyên dùng — không phụ thuộc shell)
# thêm vào ~/.dsh/.credentials.yaml mục refs:
#   refs:
#     TYPESAFE_API_KEY: "apikey_..."
```

### Lớp 8 cần thêm CLI `jg` (tuỳ chọn)

Lớp 8 gọi `jg` (skill [jevgrep](https://github.com/dzhng/jevgrep)) để lấy trích
nguồn verbatim. Nó là **tuỳ chọn**: thiếu `jg` thì lớp này tự tắt im lặng, bảy
lớp còn lại chạy bình thường.

```bash
npm install --global @dzhng/jevgrep   # cần Node 22+
jg doctor                             # phải in "Jev connection verified"
```

`jg` dùng credential riêng, **không** đọc `TYPESAFE_API_KEY` ở trên. Nếu
`jg doctor` báo thiếu credential, chạy `jg auth` một lần trong terminal của bạn
(nó mở prompt ẩn để nhập key; đừng dán key vào chat).

Khởi động lại DSH. Kiểm chứng:

```bash
bash ~/.dsh/profiles/web/node_modules/dsh-jev-gate/verify.sh
```

> Không có key? Plugin **fail-open** — mọi gate im lặng cho qua, không chặn oan.
> Đặt key rồi khởi động lại để bật.

## Nguyên tắc vận hành

- **Fail-open tuyệt đối.** Jev lỗi, chậm, hay trả rác → hành động đi tiếp như
  chưa từng có Jev. Jev không được biến sự cố của nó thành sự cố của workflow.
- **Timeout ngắn.** Gate phá dữ liệu chạy trong đường tới hạn của mọi tool call:
  2s. Chậm hơn thì fail-open.
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

Sửa trong profile (`~/.dsh/profiles/web/cordis.patch.yml`) hoặc qua trang Plugins:

```yaml
- id: jev-gate
  name: dsh-jev-gate
  config:
    destructiveThreshold: 0.7   # p >= ngưỡng này thì coi là phá dữ liệu
    completionThreshold: 0.5    # p < ngưỡng này thì coi là chưa xong
    evidenceThreshold: 0.5      # p < ngưỡng này thì coi là thiếu bằng chứng
    executionThreshold: 0.5     # p >= ngưỡng này thì goal cần thi hành
    approachConfidenceThreshold: 0.3
    contextFileThreshold: 0.6   # p >= ngưỡng này thì coi là file cần đọc
    contextCandidateLimit: 12   # số ứng viên tối đa đưa cho Jev chấm
    contextMaxFiles: 3          # số file tối đa nêu trong gợi ý
    failureMaxPerTurn: 2        # số lần gợi ý phục hồi tối đa mỗi turn
    gateTimeoutMs: 2000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 6000
    contextTimeoutMs: 6000
    failureTimeoutMs: 4000
    effortDefault: low          # mức effort khi turn trước sạch
    effortEscalateTo: high      # mức nâng lên khi turn trước có tín hiệu thất bại
    effortEscalateToolErrors: 2   # ≥2 tool error trong turn trước thì nâng
    effortEscalateTestFailures: 1 # ≥1 test fail trong turn trước thì nâng
    completionMaxPerTurn: 2     # trần số lần kiểm hoàn thành mỗi turn
    reviewMinChangedLines: 20   # diff nhỏ hơn thì không review
    reviewMaxPerTurn: 1         # trần số lần review mỗi turn
    reviewMaxDiffChars: 24000   # trần ký tự diff gửi cho review
    reviewServerName: jev-review
    reviewReportToAgent: true   # báo điểm lại cho agent qua steer
    jevGrepSearchTaskThreshold: 3  # số lệnh grep/find/rg LIÊN TIẾP thì leo thang; 0 = tắt nhánh B
    jevGrepMaxPerTurn: 1        # trần số lần leo thang jevgrep mỗi turn
    jevGrepTimeoutMs: 120000     # ngân sách một lần `jg` (truy vấn MỚI cold 66s–2m5s); quá hạn thì fail-open
    jevGrepFailureBreaker: 3    # jg hỏng liên tiếp N lần thì tắt Lớp 8 cho hết phiên
    jevGrepBackground: true     # chạy jg NỀN, không chặn turn (cold ~2 phút/truy vấn mới)
    jevGrepExcerptCap: 4000     # trần ký tự đoạn trích chèn vào context
    enableDestructiveGate: true
    enableReadOnlyPrefilter: true       # lớp 1₀ — chứng minh chỉ-đọc thì bỏ qua Jev
    enableCatastrophicFloor: true       # sàn tất định (rm -rf /, mkfs…) — deny cứng, không fail-open
    enableGateVerdictCache: true        # lớp 1ᶜ — cache verdict theo (tool, command, cwd)
    gateVerdictCacheMax: 500            # trần số entry cache (FIFO + LRU-touch)
    gateVerdictCacheMargin: 0.1         # không cache khi |p − threshold| ≤ margin (Jev không tất định)
    enableAuthorizationOverride: true   # lớp 1b provenance — tắt thì chặn mọi lệnh phá dữ liệu
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: true
    enableContextTriage: true           # lớp chọn file nạp vào context
    enableFailureRecovery: true         # lớp phục hồi khi tool lỗi
    enableQualityReview: true           # lớp tự gọi jev_review khi turn xong
    enableJevgrepEscalation: true       # lớp leo thang tìm nguồn bằng `jg` (cần skill jevgrep)
```

Lớp 8 cần CLI `jg` trên PATH (xem [Cài đặt](#lớp-8-cần-thêm-cli-jg-tuỳ-chọn)).
Thiếu nó thì lớp này tự tắt im lặng — không có lỗi, không chặn gì.

## Kiểm chứng

```bash
bash verify.sh              # 7 mục, cần DSH đang chạy + TYPESAFE_API_KEY
node tests/offline.mjs      # 305 check, không cần secret
node tests/attack-corpus.mjs # corpus tấn công độc lập — yêu cầu 0 lọt
node tests/live-check.mjs   # 24 check, chỉ cần TYPESAFE_API_KEY + mạng
```

- `verify.sh` — 7 mục: vị trí, cấu trúc, syntax, resolve dependency, đăng ký profile,
  log boot thật, gọi Jev thật với case đã biết đáp án. Exit 1 nếu có mục hỏng.
- `tests/offline.mjs` — kiểm không cần secret: fail-open, bất biến model, chỉ
  gate tool shell, guard của lớp 4, lọc tin nhắn user thật, hợp đồng export, và
  Lớp 8 (parse output `jg`, nhận diện task tìm-kiếm / lệnh dò tìm thô, trần mỗi
  turn, fail-open), prefilter vòng `for`, cache verdict (bất biến an toàn, không
  cache sát ngưỡng), provenance 1b end-to-end qua hook thật. Test Lớp 8 dùng một
  script `jg` **giả** trên PATH — không bao giờ gọi `jg` thật, nên chạy được
  trong CI không có mạng lẫn không có `jg`.
- `tests/attack-corpus.mjs` — corpus tấn công độc lập (56 vòng `for` nguy hiểm +
  16 lệnh phá luôn-deny + 11 cặp ngụy trang). Mutation test chứng minh corpus có
  răng: tiêm lỗi giả → 12–16/83 lọt, corpus báo LỖ HỔNG.
- `tests/live-check.mjs` — gọi Jev API thật với case đã biết đáp án.
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

## Số đo đã kiểm (2026-09-27 → 30, `jev-1.13.0`)

| Phép đo | Kết quả |
|---|---|
| Gate phá dữ liệu trên 20 lệnh thực tế | 20/20 đúng (recall 100%, precision 100%) |
| Deny có thật sự chặn thi hành? | có — canary còn nguyên sau `rm -rf` bị deny |
| Lớp 1b · quyền của user — nội dung dán vào tự nhận quyền | 0/66 ra `authorized` |
| Lớp 1b · quyền của user — lệnh nguy hiểm không được yêu cầu | 0/48 ra `authorized` |
| Lớp 1b · quyền của user — dọn dẹp hợp lệ user yêu cầu | 46/48 ra `authorized` |
| Lớp 1b · quyền của user fail-closed khi lỗi | có — lỗi đọc session vẫn giữ chặn |
| Kiểm hoàn thành: có bằng chứng vs nói suông | 3/3 nhánh đúng |
| Fail-open lớp 1 (mất key / store hỏng / llm vắng) | 3/3 pass |
| Effort sang số theo độ khó | `low→low→high→low→high` qua 5 bước |
| Chọn hướng tiếp cận | 9/10 đúng (scan ổ đĩa → 1 lệnh; 5 chủ đề → song song; mơ hồ → hỏi lại) |
| Chọn file nạp — biên ngưỡng | file nên đọc **0.65–0.98**, file không liên quan **0.02–0.18** |
| Chọn file nạp — kỳ vọng chặt 6 case | 5/6 (case "test flaky" Jev chỉ chọn file test — hợp lý) |
| Phục hồi khi tool lỗi, 6 lần/case | 4/4 case ổn định 6/6 mỗi case |
| Lớp 5+6 end-to-end (handler thật + Jev thật) | 12/12 đúng, Lớp 1 không hồi quy (p=0.95) |
| Độ trễ Lớp 5 (13 câu gộp 1 request) | median 271ms — bằng một câu đơn |
| Độ trễ Lớp 6 (1 câu) | median 267ms |
| Lớp 3 — chi phí cũ (classifier per-request) | **55%** token Jev, ~281ms/call TRÊN đường tới hạn |
| **Lớp 3 — dao động của cơ chế cũ (0.7.0)** | đổi `low↔high` **113/120** request; **54,5%** quyết định conf < 0,5 |
| **Lớp 3 — thiết kế mới (0.8.0)** | **0 call Jev**; mặc định low, nâng high khi ≥2 tool error / ≥1 test fail |
| **Prefilter phủ (0.8.0, 11.349 lệnh thật)** | **42,1%** (0.7.0: 39,2%) — thêm `curl` GET (allowlist) / `node --check` / `dsh` đọc |
| **Lớp 2 — fail thật (0.7.0)** | **48/49** lần là `This operation was aborted` → bỏ `signal` ở 0.8.0 |
| Bỏ câu `lease` | tiết kiệm **148 input + 43 output** token mỗi lần gọi |
| Lớp 7 — `jev_review` được gọi bao nhiêu trong 110 session thật | **1 lần** (do tác giả test, handler thật + MCP thật, steer điểm về agent), 0 lần trong việc thật |
| Lớp 7 — độ trễ `jev_review` | ~100ms |
| **Lớp 7 trên 16.905 dòng log thật (0.4.0)** | fire **66 lần**, `reviewed` **0 lần** — bug `seq`, sửa ở 0.4.1 |
| **Lớp 7 sau 0.4.1 (tái hiện provider thật)** | trước `diff.length=0` → sau `diff.length=52` |
| **Lớp 7 chạy thật lần đầu (0.4.1)** | `decision:"reviewed"` — 154 dòng / 3 file |
| **Lớp 2 trên log thật (0.4.0)** | turn=9 fire **16 lần**, không lần nào `accept` — thêm trần ở 0.4.1 |
| **Lớp 1b — yêu cầu xoá ở tin 10/25 (0.4.2)** | `unrelated` → **`authorized`** (trước: chặn oan) |
| **Lớp 1b — yêu cầu xoá ở tin 18/25 (0.4.2)** | `unrelated` → **`authorized`** |
| **Lớp 1b — nới cửa sổ 10 tin có đủ không? (0.4.2)** | **không** — vẫn chặn ở tin 10/25, phải tìm theo nội dung |
| **`DELETE_HINT` tiếng Việt có dấu (0.4.2)** | `\b` trượt `xoá`/`dẹp` → lookaround Unicode khớp hết |
| **Lớp 5 hint file — agent có đọc không? (session `777a1746`)** | **0/4 lần** — hint 4 turn liên tiếp, agent không mở file lần nào |
| **Lớp 8 — vì sao cần (session `777a1746`)** | 152 lệnh `grep`/`find`/`rg` thô, **0** lần dùng skill `jevgrep` dù có trong catalog |
| **Lớp 8 — ngưỡng 3 dựa trên gì** | run dò-tìm liên tiếp dài nhất: turn tìm-kiếm 1/3/4/5/7/8 đều **≥3**; turn ngắn 2/9/10 chỉ **1** |
| **Lớp 8 — độ trễ `jg` thật** | **~0.9s ấm** (có cache), **~2.6s nguội**; E2E qua handler thật 2.4s |
| **Lớp 8 — E2E với `jg` thật** | chèn đúng excerpt verbatim 2 file (`handler.js`, `auth.js`) |
| **Lớp 8 — test offline** | 60 check mới, dùng `jg` giả trên PATH (không gọi thật, chạy được trong CI) |
| Model có bị đổi không? | không — bất biến qua mọi test |
| Độ trễ mỗi gate | median ~250ms (lớp 1b thêm ~250ms, chỉ khi lớp 1 đã chặn) |

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
