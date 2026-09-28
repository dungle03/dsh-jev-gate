# dsh-jev-gate

[English](README.en.md) · **Tiếng Việt**

![Kiến trúc dsh-jev-gate](assets/architecture.png)

Đưa [Jev](https://typesafe.ai/) (TypeSafe System One) vào **bốn khoảnh khắc đắt
giá** của [DeepSeek Harness](https://github.com/deepseek-ai/dsh), theo nguyên tắc:

> **LLM hiểu và làm. Jev chỉ trả lời câu hỏi ĐÓNG ở khoảnh khắc mà một quyết
> định sai gây tốn kém.**

Jev không sinh văn bản, không lập kế hoạch, không viết code. Nó chỉ chấm một câu
hỏi đóng và trả về xác suất. Plugin này dùng Jev làm **bốn chốt chặn**, không
phải làm bộ não thứ hai.

## Năm lớp

| Lớp | Hook | Câu hỏi | Kiểu | Mặc định |
|---|---|---|---|---|
| Gate phá dữ liệu | `tools/pre-execute` | Lệnh này có phá dữ liệu không thể khôi phục? | `noul` | **bật** |
| Quyền của user | `tools/pre-execute` | User có thật sự yêu cầu xoá đúng thứ này không? | `choice` | **bật** |
| Kiểm hoàn thành | `agent/turn-stopping` | Xong chưa? Có bằng chứng chưa? Có cần thực thi không? | `noul` ×3 | **bật** |
| Chọn effort | `agent/request` | Bước tới cần nghĩ nhiều không? Giữ bao lâu? | `choice` ×2 | **bật** |
| Chọn hướng | `agent/pre-step` | Hướng nào tối ưu nhất cho task này? | `choice` | **bật** |

Lớp 3 bật sau khi đo cache thật: đổi reasoning effort **không** xoá prompt cache
của các effort khác. Cache giữ riêng theo `(prefix, effort)`, nên chi phí duy
nhất là lần đầu chạm một effort mới thì cold — đo được tốn đúng bằng cold của
một prefix mới.

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
├── LỚP 4 · chọn hướng tiếp cận       hook: agent/pre-step (chỉ step 1)
│   └── hỏi Jev (choice): "hướng nào tối ưu nhất cho task này?"
│       ├── one-command-scan   ──► "chạy 1 lệnh duy nhất, đừng chia việc"
│       ├── scripted-analysis  ──► "viết 1 script ngắn rồi đọc kết quả"
│       ├── parallel-workers   ──► "chia cho subagent chạy song song"
│       └── guided-interview   ──► "hỏi lại user cho rõ trước"
│           (conf < 0.3 thì im lặng; model tự quyết, plugin không tự làm)
│
└── mọi quyết định ──► ~/.local/share/dsh-jev-gate/decisions.jsonl
```

Mọi lần gọi Jev đều **fail-open**: Jev lỗi, chậm, hay trả rác thì việc đi tiếp
như chưa từng có Jev.

**Một lượt chạy qua bốn lớp** — bốn chốt chặn ở bốn thời điểm khác nhau:

```
User gõ prompt
      │
      ▼
LỚP 4 · agent/pre-step     chỉ step 1: hướng nào tối ưu cho task này?
      │                    → chèn gợi ý (1 lệnh / script / subagent / hỏi lại)
      ▼
LỚP 3 · agent/request      mỗi lần gọi model: bước tới cần nghĩ nhiều không?
      │                    → ghi reasoningEffort, provider và model GIỮ NGUYÊN
      ▼
LLM sinh phản hồi hoặc gọi tool
      │
      ▼
LỚP 1 · tools/pre-execute  chỉ với bash/pwsh: lệnh này có phá dữ liệu không?
      │                    → p ≥ 0.7 thì CHẶN, lệnh không được chạy
      ▼
LỚP 2 · agent/turn-stopping khi model định dừng: xong chưa? có bằng chứng chưa?
      │                     → chưa xong hoặc thiếu bằng chứng thì đẩy làm tiếp
      ▼
lượt kết thúc
```

> LỚP 4 chỉ chạy một lần mỗi lượt (step 1). LỚP 3 chạy ở **mỗi bước**, còn LLM
> và LỚP 1 **lặp lại** mỗi khi có tool call. Sơ đồ trên vẽ một vòng để dễ đọc.

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
    gateTimeoutMs: 2000
    authorizationTimeoutMs: 4000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 4000
    maxLeaseSteps: 10
    enableDestructiveGate: true
    enableAuthorizationOverride: true   # lớp "quyền của user" — tắt thì chặn mọi lệnh phá dữ liệu
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: true
```

## Kiểm chứng

```bash
bash verify.sh              # 6 mục, cần DSH đang chạy + TYPESAFE_API_KEY
node tests/offline.mjs      # 35 check, không cần secret
node tests/live-check.mjs   # 15 check, chỉ cần TYPESAFE_API_KEY + mạng
```

- `verify.sh` — 6 mục: cấu trúc, syntax, resolve dependency, đăng ký profile,
  log boot thật, gọi Jev thật với case đã biết đáp án. Exit 1 nếu có mục hỏng.
- `tests/offline.mjs` — kiểm không cần secret: fail-open, bất biến model, chỉ
  gate tool shell, guard của lớp 4, lọc tin nhắn user thật, hợp đồng export.
- `tests/live-check.mjs` — gọi Jev API thật với case đã biết đáp án.

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
| Model có bị đổi không? | không — bất biến qua mọi test |
| Độ trễ mỗi gate | median ~250ms (lớp 1b thêm ~250ms, chỉ khi lớp 1 đã chặn) |

## Điều plugin này KHÔNG làm

- **Không route model.** Không đổi model, chỉ (tuỳ chọn) đổi effort.
- **Không lập kế hoạch hay sinh nội dung.** Jev chỉ trả xác suất cho một câu hỏi
  đóng; LLM vẫn là thứ hiểu và làm.
- **Không tự làm theo hướng đã chọn.** Lớp 4 chỉ *gợi ý* hướng; API `agent` của
  DSH không phơi cách gọi tool trực tiếp, nên model tự quyết. Không đảm bảo model
  nghe theo — và Jev chọn hướng sai khoảng 1/10 lần trong phép đo.
- **Không thay thế phán đoán của agent.** Một khuyến nghị không phải uỷ quyền.

## Gỡ

```bash
dsh plugin --profile web remove dsh-jev-gate
rm -rf ~/.local/share/dsh-jev-gate
```

## License

MIT
