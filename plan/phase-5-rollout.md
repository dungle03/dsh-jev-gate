# Phase 5: rollout và rollback

**Owners:** Luna C rollout, Luna D kiểm độc lập. **Phụ thuộc:** Phase 4 chứng minh lợi ích ròng trên held-out. **Phạm vi ghi:** profile/config và tài liệu release sau khi Lead duyệt; không commit/push.

1. Kiểm CI và test tập trung trên plugin v0.14.0 cùng DSH 0.2.0-rc.2; kiểm các hook đang bật trong config hiệu lực của host, không chỉ YAML trên đĩa.
2. Bật riêng từng lớp đạt chuẩn qua profile nhỏ, quan sát thời gian đến phản hồi, số `completion_check: continue`, review gây `steer`, timeout, chi phí Jev/turn và tỷ lệ task đạt mục tiêu.
3. Luna D đối chiếu bảng A/B với trace nguồn và xác nhận test sẽ đỏ nếu phục hồi lỗi cũ. Kiểm không có plugin/skill khác ép chạy test lặp khi tưởng do jev-gate.
4. Nếu vượt trần latency hoặc false continuation đã định trước, quay về control ba flag `false` trong profile web và restart DSH. Giữ snapshot trước/sau cùng command kiểm chứng.
5. Sau khi số liệu vận hành ổn định, cập nhật README, changelog và giải thích mặc định mới. Chỉ thay defaults phát hành khi evidence được tái lập ngoài profile cá nhân.

**Bàn giao:** cấu hình vận hành, chứng cứ kiểm độc lập, lệnh rollback và báo cáo sau rollout. **Check:** phiên DSH mới đọc config hiệu lực đúng, agent trả lời task ngắn không bị kéo vào vòng test/review bổ sung.
