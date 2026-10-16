# Phase 2: chấm dứt vòng làm thêm việc thừa

**Owner:** Luna C. **Phụ thuộc:** hợp đồng Phase 1. **Phạm vi ghi:** phần completion/quality-review của `lib/index.mjs`, test liên quan; phối hợp Luna D vì cùng file.

1. Dùng ca baseline tái hiện lời đáp đã đạt yêu cầu nhưng `agent/turn-stopping` cho verdict `continue`, agent lại chạy test. Thêm ca thật sự thiếu hạng mục và ca thiếu output thực thi cần thiết.
2. Thay điều kiện `complete < threshold` trừu tượng bằng kiểm tra hạng mục còn thiếu có dẫn chứng. Chỉ `steer` khi hạng mục còn thiếu rõ ràng, chưa bị kiểm lại, và hành động tiếp theo có khả năng giải quyết. Các verdict mơ hồ chỉ log.
3. Bảo đảm trần lặp áp dụng xuyên `turn-stopping`, kể cả `continue`/review cùng một dispatch. Tránh mở vòng lặp qua turn mới do chính plugin tạo. Ghi rõ nguyên nhân tiếp tục để audit.
4. Đo nhánh `quality_review`: thời gian đồng bộ, diff có đủ thông tin, liệu feedback tạo sửa đổi có ích hay chỉ tăng bước. So `telemetry` và `agent-feedback`; nếu không có lợi ích ròng, giữ telemetry/off.
5. Thêm một test hồi quy cho mỗi hành vi đã sửa; kiểm thử nhánh timeout và thiếu Jev; chạy test tập trung và A/B cục bộ trên ca đã có. Không sửa mặc định/profile trong phase này.

**Bàn giao:** diff nhỏ, test tái lập, số false continuation và latency trước/sau, log mẫu và rollback. **Check:** một task ngắn hoàn tất phải trả lời ngay; một task thiếu hạng mục vẫn nhận chỉ dẫn chính xác; review không vô tình tạo vòng tiếp tục.
