# Phase 3: chọn hướng và phục hồi đúng lúc

**Owner:** Luna D. **Phụ thuộc:** Phase 1; chạy song song Phase 2. **Phạm vi ghi:** phần approach, context triage, failure recovery của `lib/index.mjs` và test liên quan; phối hợp Luna C trước khi sửa file chung.

1. Với nhóm task khởi đầu, tạo đối chứng `direct`, `find-source`, `clarify`, `delegate`. Đánh giá hành động agent thực hiện, không chỉ nhãn mà Jev trả. Chỉ chèn gợi ý nếu nó đổi hành động đúng và khả năng sai thấp trên tập dev.
2. Với chọn file, chấm file thực sự cần thiết được đọc trước sửa và số file vô ích. Đo case có sibling/migration liên quan nằm ngoài top 3; đừng cắt `contextCandidateLimit` nếu mất file cần.
3. Nhóm tool failures bằng exit code và output thực: missing command/path, timeout, assertion fail, network, không phân loại được. Reuse bảng tất định có sẵn, hỏi Jev chỉ khi cần chọn giữa ít nhất hai cách xử lý có hậu quả khác nhau.
4. Khóa lời khuyên theo session/task/root/turn và bỏ khi có evidence trái ngược hoặc task đổi. Tránh chèn lại cùng hint, tránh gọi Jev sau khi agent đã chọn và thực hiện hướng đi.
5. Viết test cho hint hết hạn, fallback lỗi Jev và hành động đối nghịch. Đo latency thêm vào đường tới hạn và A/B theo hành trình agent trên tập dev.

**Bàn giao:** bảng lỗi/hành động, diff tối thiểu, test, kết quả A/B per-layer. **Check:** không bật mặc định lớp 4/5/8 trước khi Phase 4 chứng minh lợi ích; lời khuyên cũ không vượt qua session/task mới.
