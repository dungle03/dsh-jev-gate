# Phase 0: baseline có thể tái lập

**Owner:** Luna A. **Phạm vi ghi:** `plan/`, thư mục artefact benchmark hiện có, script trajectory hiện có nếu thật cần. Không sửa hook sản phẩm.

1. Khảo sát `tools/trajectory-matrix.mjs`, `tests/trajectory-*.mjs`, `tests/benchmark.mjs`, định dạng log quyết định và các session trace. Kiểm các chỉ dẫn AGENTS.md trước khi đọc/sửa. Không đưa log chứa secret vào báo cáo.
2. Lập corpus đa dạng: trả lời ngắn, tìm file/hành vi, sửa bug có test, tác vụ nhiều bước và tool lỗi. Lưu ID, input, tiêu chí hoàn thành quan sát được, thời điểm bắt đầu/dừng, phiên bản plugin/model. Tách development và held-out theo task, không để các biến thể cùng task rơi vào hai tập.
3. Ghép timeline theo `session/turn/step`: hook vào, thời gian Jev, verdict, `steer`, tool call tiếp theo và thời gian phản hồi cuối. Chỉ ghép khi ID trace xác nhận được; báo số bản ghi không ghép được.
4. Hai người chấm độc lập các quyết định quan trọng thành `useful`, `neutral`, `harmful`, `unknown`; ghi bằng chứng trace và xử lý bất đồng. Chấm cả cơ hội plugin bỏ lỡ. Không mặc định một lần test là thừa chỉ vì task đã có output.
5. Baseline theo nhóm task và từng lớp: task success, false continuation, số test lặp, tool calls, wall-clock tới phản hồi, p50/p95, token/cost Jev. Tách độ trễ hook trực tiếp khỏi thời gian agent làm tiếp.
6. Ấn định trước cỡ mẫu tối thiểu, ngưỡng p50/p95 và mức giảm false continuation cần đạt; nếu mẫu chưa đủ, kết luận là chưa đủ dữ liệu. Đóng băng held-out trước Phase 1.

**Bàn giao:** dataset có version, script chạy lại, bảng baseline và sai số, danh sách case cụ thể cho Phase 1. **Check:** một người khác chạy script từ snapshot và tái tạo các số chính. Tránh chạm hoặc làm bẩn `decisions.jsonl` vận hành; đọc-only và dùng bản sao đã lọc.
