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

## Bốn lớp

| Lớp | Hook | Câu hỏi | Kiểu | Mặc định |
|---|---|---|---|---|
| Gate phá dữ liệu | `tools/pre-execute` | Lệnh này có phá dữ liệu không thể khôi phục? | `noul` | **bật** |
| Kiểm hoàn thành | `agent/turn-stopping` | Xong chưa? Có bằng chứng chưa? Có cần thực thi không? | `noul` ×3 | **bật** |
| Chọn effort | `agent/request` | Bước tới cần nghĩ nhiều không? Giữ bao lâu? | `choice` ×2 | **bật** |
| Gợi ý spawn | `agent/pre-step` | Task này có nhiều phần ĐỘC LẬP không? | `noul` | **bật** |

Lớp 3 bật sau khi đo cache thật: đổi reasoning effort **không** xoá prompt cache
của các effort khác. Cache giữ riêng theo `(prefix, effort)`, nên chi phí duy
nhất là lần đầu chạm một effort mới thì cold — đo được tốn đúng bằng cold của
một prefix mới.

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
│       └── p ≥ 0.7  ──► CHẶN (lệnh không được thực thi)
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
├── LỚP 4 · gợi ý spawn subagent      hook: agent/pre-step (chỉ step 1)
│   └── hỏi Jev (noul): "task này có nhiều phần ĐỘC LẬP không?"
│       ├── p < 0.6  ──► im lặng
│       └── p ≥ 0.6  ──► chèn 1 gợi ý nhẹ (model tự quyết, plugin không spawn được)
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
LỚP 4 · agent/pre-step     chỉ step 1: task có nhiều phần độc lập không?
      │                    → p ≥ 0.6 thì chèn gợi ý dùng subagent
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
    destructiveThreshold: 0.7   # p >= ngưỡng này thì chặn lệnh phá dữ liệu
    completionThreshold: 0.5    # p < ngưỡng này thì coi là chưa xong
    evidenceThreshold: 0.5      # p < ngưỡng này thì coi là thiếu bằng chứng
    executionThreshold: 0.5     # p >= ngưỡng này thì goal cần thi hành
    spawnThreshold: 0.6         # p >= ngưỡng này thì gợi ý dùng subagent
    gateTimeoutMs: 2000
    stopTimeoutMs: 6000
    effortTimeoutMs: 8000
    spawnTimeoutMs: 4000
    maxLeaseSteps: 10
    enableDestructiveGate: true
    enableCompletionCheck: true
    enableEffortRouting: true
    enableSpawnHint: true
```

## Kiểm chứng

```bash
bash verify.sh              # 6 mục, cần DSH đang chạy + TYPESAFE_API_KEY
node tests/offline.mjs      # 17 check, không cần secret
node tests/live-check.mjs   # 5 check, chỉ cần TYPESAFE_API_KEY + mạng
```

- `verify.sh` — 6 mục: cấu trúc, syntax, resolve dependency, đăng ký profile,
  log boot thật, gọi Jev thật với case đã biết đáp án. Exit 1 nếu có mục hỏng.
- `tests/offline.mjs` — kiểm không cần secret: fail-open, bất biến model, chỉ
  gate tool shell, guard của lớp 4, hợp đồng export.
- `tests/live-check.mjs` — gọi Jev API thật với case đã biết đáp án.

CI (GitHub Actions) chạy `offline.mjs` trên Node 20 + 22 cho mọi push/PR, và
`live-check.mjs` khi repo có secret `TYPESAFE_API_KEY`. Xem
[`.github/workflows/verify.yml`](.github/workflows/verify.yml).

Lịch sử thay đổi: [CHANGELOG.md](CHANGELOG.md).

## Số đo đã kiểm (2026-09-27, `jev-1.13.0`)

| Phép đo | Kết quả |
|---|---|
| Gate phá dữ liệu trên 20 lệnh thực tế | 20/20 đúng (recall 100%, precision 100%) |
| Deny có thật sự chặn thi hành? | có — canary còn nguyên sau `rm -rf` bị deny |
| Kiểm hoàn thành: có bằng chứng vs nói suông | 3/3 nhánh đúng |
| Fail-open (mất key / store hỏng / llm vắng) | 3/3 pass |
| Effort sang số theo độ khó | `low→low→high→low→high` qua 5 bước |
| Gợi ý spawn: task độc lập vs tuần tự | 9/9 đúng (độc lập 0.74–0.94; tuần tự 0.02–0.17) |
| Model có bị đổi không? | không — bất biến qua mọi test |
| Độ trễ mỗi gate | median ~250ms |

## Điều plugin này KHÔNG làm

- **Không route model.** Không đổi model, chỉ (tuỳ chọn) đổi effort.
- **Không lập kế hoạch hay sinh nội dung.** Jev chỉ trả xác suất cho một câu hỏi
  đóng; LLM vẫn là thứ hiểu và làm.
- **Không tự spawn subagent.** Lớp 4 chỉ *gợi ý*; API `agent` của DSH không phơi
  cách gọi tool trực tiếp, nên model tự quyết. Không đảm bảo 100% spawn.
- **Không thay thế phán đoán của agent.** Một khuyến nghị không phải uỷ quyền.

## Gỡ

```bash
dsh plugin --profile web remove dsh-jev-gate
rm -rf ~/.local/share/dsh-jev-gate
```

## License

MIT
