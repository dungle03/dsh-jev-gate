# Phase 1: bản đối chiếu có điều kiện

Tài liệu này đối chiếu code hiện tại, chưa phải hợp đồng đã nghiệm thu. [Phase 0](phase-0-results.md) mới có event telemetry: 2.119 event, 0 nhãn độc lập, không có kết quả task và held-out rỗng. Vì vậy chưa có case `useful/harmful/unknown` nối với task ID để kiểm hợp đồng. Phase 2 và 3 chỉ sửa code sau khi bổ sung bằng chứng này và chốt hợp đồng Phase 1.

| Lớp và vị trí | Evidence, quyết định, quyền tác động | Khi evidence yếu | Timeout/budget hiện tại | Đối chứng cần đo |
| --- | --- | --- | --- | --- |
| Destructive gate (`lib/index.mjs:1896-2035`) | Command, cwd và workdir; sàn tất định và lọc readonly trước Jev, sau đó verdict/consent có thể chặn tool | Giữ nhánh floor, consent và outage hiện có; xác nhận từng nhánh bằng case có nhãn | 2 s; safety tách khỏi budget non-safety | False allow/deny, latency so với sàn tất định |
| Completion (`lib/index.mjs:2807-2921`) | Yêu cầu user, goal và runtime evidence; chỉ `continue` nếu trích được hạng mục user yêu cầu còn thiếu | Thiếu hoặc mâu thuẫn thì không steer, ghi telemetry | 6 s; tối đa 2 lần/turn | False continuation, missed work và time-to-final so với off |
| Effort (`lib/index.mjs:3110-3262`) | Task, effort model hỗ trợ và lỗi tool/test đo từ turn trước; chọn mức sticky theo turn | Giữ mức mặc định/deterministic nếu thiếu tín hiệu hoặc model không hỗ trợ | 8 s; chung budget non-safety | Success, tokens và độ trễ so với fixed low/deterministic |
| Approach (`lib/index.mjs:1501-1647`) | Prompt đầu turn; lời gợi ý advisory, chỉ có ích nếu đổi hành động kế tiếp | Mơ hồ, mâu thuẫn hoặc no-op thì im lặng | 6 s; advisory | Hành động tiếp theo và success so với off |
| Context (`lib/index.mjs:1501-1679`) | Task và excerpt ứng viên; chọn file/evidence top-k advisory | Không inject nếu ứng viên yếu hoặc thiếu | 6 s; advisory | File đúng, reads/token và task success so với off |
| Recovery (`lib/index.mjs:2224-2327`) | Tool error, command, goal; classifier tất định trước Jev; hint là advisory | Không hint nếu lỗi thiếu căn cứ; retry lặp phải chuyển alternate | 4 s; mặc định tối đa 2 lỗi/turn | Lặp cùng lỗi, time-to-recovery so với classifier |
| Review (`lib/index.mjs:3302-3465`) | Chỉ sau turn dừng thực, diff đủ lớn và feedback còn có thể thay đổi hành động; telemetry hoặc advisory | Bỏ qua sau continuation, diff rỗng hoặc thiếu công cụ/context | 15 s; 2 budget units | Diff hữu ích sau feedback, chi phí và latency so với telemetry/off |
| Jevgrep (`lib/index.mjs:2698-2804`) | Task tìm vị trí hoặc chuỗi tìm kiếm lặp; tra cứu chạy nền, hint có thể đến step sau | Lỗi/timeout thì bỏ hint, tiếp tục luồng chính | 120 s worker; budget riêng | File đúng top-N và thời gian tìm vị trí so với grep thường |

Trước Phase 2/3 cần bổ sung corpus có input/task ID, bằng chứng runtime và outcome quan sát được, hai người chấm độc lập cùng biên bản bất đồng. Sau đó chốt câu hỏi đóng, ngưỡng verdict, fallback và case đối chứng theo từng task ID trên development; không chọn ngưỡng từ held-out. Profile web hiện tắt completion/review/effort và giữ làm control.
