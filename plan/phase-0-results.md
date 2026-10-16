# Phase 0 baseline, snapshot v1 (chưa đủ dữ liệu để nghiệm thu Phase 0)

## Kết luận

Đã tạo snapshot đọc-only từ `~/.local/share/dsh-jev-gate/decisions.jsonl` lúc chạy script. Snapshot này mô tả telemetry quyết định, không phải benchmark hoàn thành task. Không có agent trace chứa input/task ID/kết quả cuối trong thư mục runtime của plugin; vì vậy không thể ghép event thành task hoặc đo tỷ lệ task thành công, false continuation, tool calls theo task, thời gian tới câu trả lời cuối, số test lặp, hay phân tích theo nhóm task. Không có nhãn người độc lập nào được cung cấp. Mọi nhãn để `unknown`; không dùng verdict của gate làm ground truth.

## Artefact và tái lập

- `plan/phase-0-baseline.mjs`: chuyển log sang schema giảm thiểu dữ liệu, hash session bằng SHA-256 rút gọn 16 ký tự, bỏ command/error/message và trường có khả năng chứa nội dung hoặc thông tin riêng.
- `plan/phase-0-v1.jsonl`: 2.119 event đã lọc, tất cả `label: "unknown"` và split `development`.
- `plan/phase-0-v1.jsonl.summary.json`: SHA-256 đầu vào, mốc thời gian, số record, nhóm loại quyết định và khả năng ghép `session/turn`.
- `plan/phase-0-heldout-v1.jsonl`: tập held-out rỗng, đóng băng trước Phase 1. Không chuyển mẫu từ snapshot này sang held-out sau khi xem verdict.
- `plan/phase-0-heldout-v1.manifest.json`: cam kết hash và lý do held-out rỗng.

Lệnh tái lập:

```sh
node plan/phase-0-baseline.mjs "$HOME/.local/share/dsh-jev-gate/decisions.jsonl" /tmp/phase-0-recheck.jsonl --self-test
node tools/trajectory-matrix.mjs --self-test
```

Lệnh không sửa file log vận hành, không gọi Jev hoặc mạng. Đầu ra kiểm lại đặt trong `/tmp` để giữ nguyên snapshot đã đóng băng. Snapshot ghi SHA-256 nguồn để nhận biết log thay đổi. Vì nguồn là log đang hoạt động, lần tái lập sau sẽ có số liệu/hash khác khi log tiếp tục tăng; dùng bản JSONL snapshot đã lưu để đối chiếu đúng số liệu đã báo.

## Số liệu v1

Log vận hành tiếp tục tăng trong lúc chụp snapshot; số liệu bàn giao cuối cùng là SHA-256 nguồn `0e11975f934fbe85acf8d3c2ee2a8e38250339448bb16b7dcb03b3d2f7ee5dc8`; 2.119 JSON records, 0 dòng lỗi; thời gian từ `2026-10-15T09:05:33.989Z` tới `2026-10-15T15:11:45.692Z`; 13 session hash.

| Loại event | n | Nội dung quyết định quan sát được |
| --- | ---: | --- |
| `boot` | 4 | không có |
| `completion_check` | 4 | accept 2, continue 2 |
| `context_budget` | 1 | không có |
| `cost_governor` | 940 | actual_invocation 330, operation_finished 305, reserved_cost 305 |
| `destructive_gate` | 593 | allow 230, allow_consented 8, allow_readonly 353, deny_consent 2 |
| `effort_route` | 220 | applied 14, sticky 206 |
| `failure_recovery` | 50 | fail_open 2, hinted 48 |
| `jev_error` | 12 | không có |
| `jev_ok` | 291 | không có |
| `quality_review` | 4 | reviewed 2, skip_continued 2 |

Có 1.219 record có cả session hash và turn; 900 record thiếu một trong hai. Record `destructive_gate`, `jev_ok` và `jev_error` không có `turn/step` theo schema log này, nên không ghép được đầy đủ với trace; một trường session đơn lẻ không đủ định danh task. 64 effort-route record có `step`; `cost_governor` có 940 thời lượng event; `jev_ok` 291 thời lượng event; `jev_error` 12. Đây là latency thao tác ghi trong event, không phải thời gian hook hoặc thời gian hoàn thành task. Không gộp các số này thành p50/p95 task.

## Ngưỡng và cỡ mẫu định trước

Phase 1 không được chọn/tune trên held-out. Trước thử nghiệm A/B, ghi protocol có timestamp và hash, khóa split theo task ID (các biến thể cùng task luôn ở cùng split), với tối thiểu 30 task độc lập mỗi nhóm task trên tune và 30 task độc lập mỗi nhóm trên held-out; tập phải có positive/negative opportunities để tính false continuation. Báo từng case và khoảng tin cậy khi mẫu nhỏ; không coi n event là n task.

Đề xuất tiêu chí đạt cần được Lead duyệt và đóng dấu trước Phase 4: tăng task success ít nhất 5 điểm phần trăm; false continuation không tăng, và nhóm task ngắn không tăng p50 quá 100 ms hoặc p95 quá 250 ms so với control. Chỉ bật lớp khi đạt mọi tiêu chí. Không thể đánh giá tiêu chí nào từ snapshot hiện tại.

## Nhãn độc lập và phần còn mở

Nhãn chấm `useful`, `neutral`, `harmful`, `unknown` cho quyết định quan trọng và opportunity bị bỏ lỡ cần hai người độc lập, bằng chứng trace cụ thể, rồi ghi bất đồng. Hiện chưa có bộ trace hoặc người chấm thứ hai độc lập trong dữ liệu được cung cấp. Việc này còn unresolved; không tạo nhãn, không diễn giải allow/deny như đúng/sai. Cần bổ sung trace đã lọc có task/session/turn/step, tool calls và thời gian dừng, cùng kết quả hoàn thành có thể quan sát; sau đó hai người mới gán nhãn.

## Giới hạn sở hữu

Phase 0 chỉ thêm artefact trong `plan/`. Không chỉnh hook sản phẩm, file Phase 1+, log nguồn hoặc benchmark tooling chung. Snapshot giữ nội dung người dùng ở ngoài: command, error, message, file list, cấu hình/model, signals, scores, usage, consent không được chép vào JSONL.

## Kiểm tra

- `node plan/phase-0-baseline.mjs ... --self-test`: đạt; JSON parse, schema privacy và nhãn unknown được xác nhận.
- `node tools/trajectory-matrix.mjs --self-test`: đạt trên dữ liệu synthetic; không phải kết quả A/B.

Open: thiếu sample task-level, outcomes, nhãn độc lập thứ hai; chưa thể công bố benchmark success hoặc quyết định bật/tắt lớp.

<!-- Ponytail: event-only baseline has no task outcome; add task metrics only when trace IDs and independently observed outcomes exist. -->
