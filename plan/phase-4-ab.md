# Phase 4: đánh giá A/B cả hành trình

**Owners:** Luna A đo và Luna B kiểm hợp đồng. **Phụ thuộc:** Phase 2 và Phase 3 có diff, test và dữ liệu dev. **Phạm vi ghi:** artefact benchmark/plan; không chỉnh hook để đuổi theo điểm held-out.

1. Giữ nguyên task, model, version host, trạng thái workspace và điều kiện khởi đầu giữa các run. Control là profile web đang tắt completion, review và effort routing.
2. Chạy control, mỗi lớp sửa đổi riêng lẻ, sau đó tổ hợp chỉ các lớp đã có ích riêng. Thứ tự run hoán đổi hoặc ghép cặp để giảm nhiễu; pin seed nếu backend có hỗ trợ.
3. Đo task success, false continuation, lần test thừa, lựa chọn file/hướng đúng, số tool call, p50/p95 thời gian đến phản hồi, token và chi phí Jev. Gắn trace cho mọi regression.
4. Chỉ sau khi chốt lựa chọn trên dev mới mở held-out. Giữ đúng tiêu chí phát hành/cỡ mẫu đã viết trong Phase 0; nếu dữ liệu thiếu, giữ control và báo cần thêm mẫu.
5. Kiểm tác động tổ hợp: hai lớp riêng lẻ có ích vẫn có thể tương tác tạo vòng lặp. So riêng task ngắn với task dài, kể cả tool timeout.

**Bàn giao:** script tái lập, bảng so sánh đủ cỡ mẫu/sai số, trace các ca khác biệt, đề nghị bật/tắt từng lớp. **Check:** người khác có thể chạy lại và kiểm rằng held-out chưa bị dùng để tuning.
