# dsh-jev-gate

[English](README.en.md) · **Tiếng Việt**

![Kiến trúc dsh-jev-gate](assets/architecture.png)

Đưa [Jev](https://typesafe.ai/) (TypeSafe System One) vào **bảy khoảnh khắc đắt
giá** của [DeepSeek Harness](https://github.com/deepseek-ai/dsh), theo nguyên tắc:

> **LLM hiểu và làm. Jev chỉ trả lời câu hỏi ĐÓNG ở khoảnh khắc mà một quyết
> định sai gây tốn kém.**

Jev không sinh văn bản, không lập kế hoạch, không viết code. Nó chỉ chấm một câu
hỏi đóng và trả về xác suất. Plugin này dùng Jev làm **bảy chốt chặn**, không
phải làm bộ não thứ hai.

## Bảy lớp

| Lớp | Hook | Câu hỏi | Kiểu | Mặc định |
|---|---|---|---|---|
| Gate phá dữ liệu | `tools/pre-execute` | Lệnh này có phá dữ liệu không thể khôi phục? | `noul` | **bật** |
| Quyền của user | `tools/pre-execute` (chỉ khi lớp 1 chặn) | User có thật sự yêu cầu xoá đúng thứ này không? | `choice` | **bật** |
| Kiểm hoàn thành | `agent/turn-stopping` | Xong chưa? Có bằng chứng chưa? Có cần thực thi không? | `noul` ×3 | **bật** |
| Chọn effort | `agent/request` | Bước tới cần nghĩ nhiều không? | `choice` | **bật** |
| Chọn hướng + chọn file nạp | `agent/pre-step` (step 1) | Hướng nào tối ưu? File nào cần đọc trước? | `choice` + `noul` ×N | **bật** |
| Phục hồi khi tool lỗi | `tools/post-execute` | Tool vừa lỗi — retry, đổi cách, điều tra, hay báo user? | `choice` | **bật** |
| Review chất lượng | `agent/turn-stopping` | (tự gọi `jev_review` khi turn xong và diff đủ lớn) | tool MCP | **bật** |

Lớp 3 bật sau khi đo cache thật: đổi reasoning effort **không** xoá prompt cache
của các effort khác. Cache giữ riêng theo `(prefix, effort)`, nên chi phí duy
nhất là lần đầu chạm một effort mới thì cold — đo được tốn đúng bằng cold của
một prefix mới.

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

### Vì sao có lớp "Quyền của user"

Gate phá dữ liệu cũ **không phân biệt được rác session với dữ liệu thật**. Log
thật cho thấy `rm -rf /tmp/gtest` (thư mục test do chính session tạo) bị chặn ở
p=0.77, trong khi `rm -rf <path không tồn tại>` chỉ 0.40 — nên dọn rác hợp lệ bị
chặn oan và phải thử lại nhiều lần (một lệnh bị chặn **7 lần** liên tiếp).

Lớp mới chỉ chạy **khi** lớp 1 đã kết luận lệnh là phá dữ liệu, và chỉ để trả
lời một câu: user có tự tay yêu cầu xoá đúng thứ đó không. Chặn chỉ xảy ra khi
hội đủ hai điều — **phá dữ liệu VÀ không được user yêu cầu**:

```
p ≥ 0.7  ──► hỏi tiếp "user có yêu cầu không?"
              ├── authorized        ──► CHO CHẠY
              └── narrower/unrelated/quoted ──► CHẶN
```

Bốn nhánh `choice` thay vì `noul` vì chúng là bốn tình huống khác nhau về bản
chất, không phải bốn mức của một đại lượng — nên không phải chọn ngưỡng, và
nhánh `quoted` chặn được nội dung dán vào tự nhận quyền.

Đo trên API thật (`jev-1.13.0`, 6–10 lần/case):

| Nhóm | Kết quả |
|---|---|
| Nội dung dán vào tự nhận quyền (web/README/log, nhờ dịch/tóm tắt, giả mạo "user đã phê duyệt") | **0/66** ra `authorized` |
| Lệnh nguy hiểm không được yêu cầu (không liên quan, mơ hồ, mở rộng phạm vi) | **0/48** ra `authorized` |
| Dọn dẹp hợp lệ user yêu cầu (đúng path, glob, cache, session scratch) | **46/48** ra `authorized` |

Bằng chứng `user_request` **chỉ** lấy tin nhắn thật của user (`source.kind ===
'user'`). Trước đây `notePrompt` gộp mọi message `role=user` — kể cả output job
nền (`tool-jobs`) và gợi ý do chính plugin chèn — nên nội dung không tin cậy có
thể lọt vào trường "yêu cầu của user".

Lớp này **fail-closed**: hỏi lỗi/timeout thì giữ nguyên hành vi chặn. Khác lớp 1
(fail-open) — vì đây là lớp phòng thủ, lỗi của Jev không được biến thành "cho qua".


## Kiến trúc

Plugin là một lớp mỏng giữa **DSH engine** và **Jev API**. Nó chỉ đăng ký hook,
hỏi Jev một câu đóng, rồi trả quyết định về cho engine. Không đổi model, không
sinh nội dung, không giữ transcript.

```
dsh-jev-gate
│
├── LỚP 1 · gate phá dữ liệu          hook: tools/pre-execute
│   └── hỏi Jev (noul): "lệnh này có phá dữ liệu không thể khôi phục?"
│       ├── p < 0.7  ──► cho chạy
│       └── p ≥ 0.7  ──► hỏi tiếp LỚP 1b
│
├── LỚP 1b · quyền của user            hook: tools/pre-execute (chỉ khi lớp 1 chặn)
│   └── hỏi Jev (choice): "user có yêu cầu xoá đúng thứ này không?"
│       ├── authorized ──► cho chạy
│       └── narrower/unrelated/quoted ──► CHẶN
│
├── LỚP 2 · kiểm hoàn thành           hook: agent/turn-stopping
│   └── hỏi Jev (noul ×3): "xong chưa? có bằng chứng chưa? có cần thi hành không?"
│       ├── xong + có bằng chứng  ──► cho kết thúc lượt
│       └── chưa xong / thiếu bằng chứng ──► đẩy làm tiếp
│
├── LỚP 3 · chọn mức suy nghĩ         hook: agent/request
│   └── hỏi Jev (choice ×2): "bước tới cần nghĩ nhiều không? giữ bao lâu?"
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
LỚP 3 · agent/request      mỗi lần gọi model: bước tới cần nghĩ nhiều không?
      │                    → ghi reasoningEffort, provider và model GIỮ NGUYÊN
      ▼
LLM sinh phản hồi hoặc gọi tool
      │
      ▼
LỚP 1 · tools/pre-execute  chỉ với bash/pwsh: lệnh này có phá dữ liệu không?
      │                    → p ≥ 0.7 thì CHẶN (qua LỚP 1b xét quyền user)
      ▼
LỚP 6 · tools/post-execute tool vừa lỗi: retry / đổi cách / điều tra / báo user
      │                    → chèn gợi ý cho step kế tiếp
      ▼
LỚP 2 · agent/turn-stopping khi model định dừng: xong chưa? có bằng chứng chưa?
      │                     → chưa xong hoặc thiếu bằng chứng thì đẩy làm tiếp
      ▼
LỚP 7 · agent/turn-stopping lượt thật sự xong và diff đủ lớn
      │                     → tự gọi jev_review, báo điểm về như một báo cáo
      ▼
lượt kết thúc
```

> LỚP 4+5 chỉ chạy một lần mỗi lượt (step 1). LỚP 3 chạy ở **mỗi bước**, còn
> LLM, LỚP 1, LỚP 1b và LỚP 6 **lặp lại** mỗi khi có tool call. Sơ đồ trên vẽ
> một vòng để dễ đọc.

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
    authorizationTimeoutMs: 4000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 6000
    contextTimeoutMs: 6000
    failureTimeoutMs: 4000
    effortReuseConfidence: 0.6  # conf >= ngưỡng này thì giữ nguyên effort cho step kế
    reviewMinChangedLines: 20   # diff nhỏ hơn thì không review
    reviewMaxPerTurn: 1         # trần số lần review mỗi turn
    reviewMaxDiffChars: 24000   # trần ký tự diff gửi cho review
    reviewServerName: jev-review
    reviewReportToAgent: true   # báo điểm lại cho agent qua steer
    enableDestructiveGate: true
    enableAuthorizationOverride: true   # lớp "quyền của user" — tắt thì chặn mọi lệnh phá dữ liệu
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: true
    enableContextTriage: true           # lớp chọn file nạp vào context
    enableFailureRecovery: true         # lớp phục hồi khi tool lỗi
    enableQualityReview: true           # lớp tự gọi jev_review khi turn xong
```

## Kiểm chứng

```bash
bash verify.sh              # 6 mục, cần DSH đang chạy + TYPESAFE_API_KEY
node tests/offline.mjs      # 89 check, không cần secret
node tests/live-check.mjs   # 21 check, chỉ cần TYPESAFE_API_KEY + mạng
```

- `verify.sh` — 6 mục: cấu trúc, syntax, resolve dependency, đăng ký profile,
  log boot thật, gọi Jev thật với case đã biết đáp án. Exit 1 nếu có mục hỏng.
- `tests/offline.mjs` — kiểm không cần secret: fail-open, bất biến model, chỉ
  gate tool shell, guard của lớp 4, lọc tin nhắn user thật, hợp đồng export.
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

## Số đo đã kiểm (2026-09-27 → 28, `jev-1.13.0`)

| Phép đo | Kết quả |
|---|---|
| Gate phá dữ liệu trên 20 lệnh thực tế | 20/20 đúng (recall 100%, precision 100%) |
| Deny có thật sự chặn thi hành? | có — canary còn nguyên sau `rm -rf` bị deny |
| Lớp quyền user — nội dung dán vào tự nhận quyền | 0/66 ra `authorized` |
| Lớp quyền user — lệnh nguy hiểm không được yêu cầu | 0/48 ra `authorized` |
| Lớp quyền user — dọn dẹp hợp lệ user yêu cầu | 46/48 ra `authorized` |
| Handler thật + Jev thật, 12 case end-to-end | 12/12 đúng |
| Lớp quyền user fail-closed khi lỗi | có — lỗi đọc session vẫn giữ chặn |
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
| Lớp 3 — chi phí Jev theo lớp | **65%** (3.238.650 / 4.958.494 token) |
| Lớp 3 — lease cũ thực tế | `lease=1` ở **1.777/1.830 lần (97%)** → cơ chế coi như chết |
| Lớp 3 — confidence ↔ độ ổn định | conf 0.6 → step sau giữ nguyên 88%; conf 0.9 → 95% |
| Lớp 3 — tái dùng bỏ được bao nhiêu | **32%** số lần gọi, đoán sai 8% (bỏ sót TĂNG 4,3%) |
| Bỏ câu `lease` | tiết kiệm **148 input + 43 output** token mỗi lần gọi |
| Lớp 7 — `jev_review` được gọi bao nhiêu trong 110 session thật | **1 lần** (do tác giả test), 0 lần trong việc thật |
| Lớp 7 — handler thật + MCP thật | gọi review 1 lần, steer điểm về agent |
| Lớp 7 — độ trễ `jev_review` | ~100ms |
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
