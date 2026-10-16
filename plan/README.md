# Kế hoạch cải thiện quyết định của dsh-jev-gate

Mục tiêu: cải thiện tỷ lệ hoàn thành task và lựa chọn đúng xuyên suốt workflow mà không kéo dài thời gian phản hồi bằng vòng kiểm tra, chạy test, hoặc review thừa. Không chỉnh sản phẩm từ điểm Jev riêng lẻ; quyết định theo hành vi agent và kết quả cuối.

## Trạng thái đầu vào

- Plugin v0.14.0, DSH 0.2.0-rc.2. Luồng chính ở `lib/index.mjs`, log ở `~/.local/share/dsh-jev-gate/decisions.jsonl`.
- Profile web đang override `enableCompletionCheck: false`, `enableQualityReview: false`, `enableEffortRouting: false` trong `~/.dsh/profiles/web/cordis.patch.yml`. Đây là control. Không bật lại khi chưa qua Phase 4.
- Snapshot log đã quan sát: 4 completion checks gồm 2 `continue`, 2 `accept`; 4 quality-review gồm 2 `skip_continued`, 2 `reviewed`; 216 effort decisions gồm 14 `applied`, 202 `sticky`. Đây là tín hiệu cần điều tra, không chứng minh task nào sai.
- Bản plugin có sẵn test và tooling trajectory. Ưu tiên tái dùng; tránh framework hoặc lớp hook mới nếu chưa có số đo.

## Thứ tự và giao việc

| Phase | Chủ trách nhiệm | Điều kiện bắt đầu | Tài liệu |
| --- | --- | --- | --- |
| 0. Baseline | Luna A | Ngay | [phase-0-baseline.md](phase-0-baseline.md) |
| 1. Hợp đồng quyết định | Luna B | Sau baseline có nhãn | [phase-1-decision-contract.md](phase-1-decision-contract.md) |
| 2. Dừng và review | Luna C | Sau Phase 1 | [phase-2-stop-review.md](phase-2-stop-review.md) |
| 3. Hướng đi và phục hồi | Luna D | Sau Phase 1, song song Phase 2 | [phase-3-workflow-routing.md](phase-3-workflow-routing.md) |
| 4. A/B | Luna A + B | Sau Phase 2 và 3 | [phase-4-ab.md](phase-4-ab.md) |
| 5. Rollout | Luna C + D | Sau Phase 4 đạt chuẩn | [phase-5-rollout.md](phase-5-rollout.md) |

Kết quả hiện tại: [phase-0-results.md](phase-0-results.md) chứa snapshot telemetry đã lọc, nhưng chưa có trace kết quả task và nhãn độc lập, nên Phase 0 chưa đạt điều kiện bàn giao. Phase 1 đến 5 giữ nguyên điều kiện phụ thuộc; profile web vẫn là control.

Mỗi subagent trước khi làm: đọc skill catalog, nạp skill/MCP phù hợp, đọc `AGENTS.md` theo cây thư mục, đọc file liên quan và mọi caller trước khi sửa. Dùng `nine-router/cx/gpt-6-luna[1m]` (thêm tiền tố `modlens-nine-router/` khi cần đưa ảnh vào model text-only) khi child route được host cho phép. Không thay bằng model khác khi phép đo đòi giữ cùng model. Không tạo commit/push. Agent sở hữu phần code riêng, báo cáo Lead trước khi đụng file chung `lib/index.mjs`; Lead rà diff và chạy test liên quan.

## Tiêu chuẩn thống nhất

- Mỗi quyết định lưu đủ `session`, `turn`, thời điểm, lớp, verdict, action và thời gian; không ghi secret hay nguyên văn nội dung nhạy cảm.
- Tách tập chọn thiết kế với tập held-out. Với ít mẫu, báo độ bất định và từng trường hợp thay vì phần trăm làm tròn.
- Chỉ bật lớp nếu cải thiện tỷ lệ task đạt yêu cầu mà không tăng false continuation; nhóm task ngắn không được chậm đáng kể ở p50/p95. Ngưỡng định lượng và cỡ mẫu phải định trước trong Phase 0.
- Test chỉ cần chứng minh thay đổi vừa làm và hồi quy chính. Chạy suite rộng trước rollout, không chạy đi chạy lại toàn suite ở mỗi chỉnh sửa.
- Mọi kết quả phải có lệnh tái lập, file artefact, bảng trước/sau và đường rollback.
