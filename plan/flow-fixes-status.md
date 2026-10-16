# Flow fixes ngoài các Phase chưa nghiệm thu

| Trước | Sau | Kiểm chứng |
| --- | --- | --- |
| jevgrep truy vấn mới cùng session bị bỏ nếu tiến trình cũ chưa thoát; instance plugin khác không thấy pending | Truy vấn mới hủy truy vấn cũ, chờ tiến trình thoát rồi chạy; pending dùng chung giữa các instance và dispose chỉ dọn phần mình sở hữu | `node tests/jevgrep-control.mjs` |
| Completion `continue` đánh dấu lượt đã tiếp tục ngay cả khi context admission loại gợi ý, khiến review bị bỏ qua | Chỉ đánh dấu sau khi gợi ý được chèn thành công | `node tests/offline.mjs` |
| Dọn temp provenance đôi lúc đua với recorder ghi bất đồng bộ | Dọn bằng `rm` có retry ngắn | `node tests/provenance.mjs` |

Kiểm tra toàn bộ: `npm test` (32 suite đạt), `git diff --check` (đạt). Rollback riêng các sửa flow: hoàn nguyên `lib/index.mjs`, `lib/jevgrep-control.mjs`, `tests/jevgrep-control.mjs`, `tests/offline.mjs`, `tests/provenance.mjs` về bản trước thay đổi; giữ riêng artefact `plan/`. Chưa commit hoặc rollout.

Các sửa này là hồi quy cục bộ, **không phải** kết quả A/B của Phase 4. Phase 0 vẫn thiếu task outcome, nhãn độc lập và held-out; Phase 1–5 chưa đạt điều kiện bắt đầu/nghiệm thu. Web profile tiếp tục giữ ba cờ control `enableCompletionCheck`, `enableQualityReview`, `enableEffortRouting` ở `false`. Để thu trajectory thực cần `TRAJECTORY_MODEL_KEY`, `TYPESAFE_API_KEY`, task trace có outcome và người chấm nhãn độc lập; không suy ra chất lượng task từ event log.
