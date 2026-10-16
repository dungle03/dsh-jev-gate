# Phase 1: hợp đồng cho từng quyết định

**Owner:** Luna B. **Phụ thuộc:** Phase 0 có corpus, baseline và nhãn. **Phạm vi ghi:** `plan/`; chưa sửa hook.

1. Trace tám lớp trong `lib/index.mjs` từ hook đăng ký tới lời gọi Jev, cách đọc evidence, kết quả `record`, `agent.steer`, timeout và budget. Đọc mọi caller của helper định sửa. Đối chiếu với thực tế từ Phase 0, không tin comment nếu runtime khác.
2. Với mỗi lớp, ghi: quyết định sai gây hậu quả nào; code thuần hoặc agent chính đã biết gì; thông tin Jev bổ sung là gì; khi nào verdict làm thay đổi hành động. Loại nhánh chỉ thêm latency mà không đổi hành động.
3. Thiết kế câu hỏi đóng và cấu trúc evidence tối thiểu. Verdict `unknown`/mâu thuẫn/thiếu bằng chứng phải im lặng hoặc ghi telemetry, không ép agent làm thêm. Phân biệt `recommendation` với quyết định có quyền chặn.
4. Cho completion: chỉ định nghĩa điều kiện tiếp tục khi có hạng mục user yêu cầu còn thiếu và có thể trích dẫn evidence. Cho review: xác định thời điểm kết quả còn tác dụng trước khi gửi feedback. Cho effort: so sánh low cố định, tất định theo lỗi đã đo và Jev routing.
5. Với approach, context và recovery: xác định khi nào có ít nhất hai hành động khả thi, lúc nào gợi ý hết hạn, và tín hiệu trái ngược làm vô hiệu lời khuyên cũ.
6. Viết bảng cho từng lớp gồm trigger, câu hỏi, nguồn dữ liệu tin cậy, action, timeout, budget, bypass/fallback, chỉ số đánh giá và test đối chứng; Phase 2/3 chỉ code theo hợp đồng này.

**Bàn giao:** bảng hợp đồng và case đối chứng được nối tới ID Phase 0. **Check:** tự đi từng case `useful/harmful/unknown` và giải thích action của hợp đồng mà không cần suy diễn từ điểm số Jev.
