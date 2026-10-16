# Cập nhật bản sửa và bật lại ba lớp Jev

Cập nhật ngày 2026-10-16 theo yêu cầu vận hành của người dùng. Chưa commit hoặc push.

## Cấu hình đã bật

Profile `/home/lee/.dsh/profiles/web/cordis.patch.yml` hiện có:

```yaml
- id: jev-gate
  name: dsh-jev-gate
  config:
    enableCompletionCheck: true
    enableQualityReview: true
    enableEffortRouting: true
```

Đã chạy `dsh --profile web --dump-config` trong shell có credential. Cấu hình hợp nhất xác nhận cả ba giá trị là boolean `true`. Đây là thay đổi vận hành theo yêu cầu mới, không phải kết luận Phase 4 A/B đã đạt.

## Bản sửa hiện có đã kiểm lại

- `lib/index.mjs`: chỉ đánh dấu completion đã tiếp tục sau khi context được nhận. Nếu gợi ý tiếp tục bị bỏ do ngân sách context, quality review vẫn chạy.
- `lib/index.mjs` và `lib/jevgrep-control.mjs`: truy vấn mới cùng session hủy truy vấn cũ, chờ worker thực sự thoát rồi trả kết quả về đúng promise ban đầu. Pending dùng chung qua các instance, có xử lý abort, dispose và trần concurrency.
- `tests/offline.mjs` và `tests/jevgrep-control.mjs`: hồi quy cho các nhánh trên.
- `tests/provenance.mjs`: retry khi dọn thư mục tạm để tránh đua với recorder.
- Completion lấy nguyên nội dung yêu cầu thật mới nhất, kể cả message có nhiều text block. Goal cũ chỉ làm ngữ cảnh để hiểu lời nhắc tiếp tục, không biến một câu hỏi đánh giá thành yêu cầu triển khai.
- Bằng chứng có turn rõ ràng được lọc theo turn hiện tại. Event từ host cũ không có turn vẫn được giữ để tương thích.
- Với giải thích hoặc đánh giá, lời nhắc chỉ yêu cầu bổ sung phần trả lời còn thiếu. Với thay đổi cần thực thi, lời nhắc yêu cầu kiểm tra liên quan và tránh chạy lại kiểm tra đã có kết quả.
- Sau một lời nhắc được nhận, nếu yêu cầu và bằng chứng tool chưa đổi, completion ghi `skip_no_progress` rồi bỏ qua cả API lẫn lời nhắc lặp. Output tool mới cho phép kiểm lại, vẫn trong trần 2 lần mỗi turn. Viết lại câu trả lời mà không có output tool mới không mở thêm lần kiểm.
- Jev Review có bản vá input cục bộ tại `/home/lee/.dsh/plugins/jev-review/dist/server.js`. Metric không áp dụng được bỏ score/confidence thừa sau khi kiểm kiểu và khoảng giá trị. Output vẫn loại payload không chuẩn; metric áp dụng vẫn bắt buộc có điểm hợp lệ. Lần đầu bỏ `previousEvaluation`; lần sau dùng phản hồi thật trước đó.

Không thay ngưỡng đánh giá chỉ để bật cờ. Giữ giới hạn mặc định đã có test: completion tối đa 2 lần mỗi turn, quality review tối đa 1 lần mỗi turn, effort chỉ chọn mức model hỗ trợ và fallback khi dịch vụ lỗi. Quality review còn phụ thuộc diff đủ lớn, workspace service và tool MCP thực sự có mặt; bật cờ không có nghĩa mọi câu trả lời đều gọi review.

## Kết quả kiểm tra lần này

| Kiểm tra | Kết quả |
| --- | --- |
| `npm test` | Toàn bộ 33 suite offline đạt |
| `git diff --check` | Đạt |
| Profile web hợp nhất | Ba lớp đều `true` |
| `node tests/dsh-compat.mjs --strict` | Đạt trên DSH 0.2.0-rc.2. Agent loop thật chạy 2 generation với 1 completion API call khi continuation chỉ thay câu trả lời. Consent và quality review hook cũng đạt. Phản hồi Jev/model/UI là fixture, không phải A/B thực. |
| Jev Review contract | `node tests/input-contract.mjs` và `node --check dist/server.js` đạt trong plugin jev-review. MCP in-memory thật kiểm baseline, prior tương thích, delta thật, output strict và payload sai bị chặn trước dịch vụ. |
| Jev Review gọi trực tiếp trong phiên | Đã trả kết quả hợp lệ, không còn lỗi -32602 với prior tương thích. Review completion có correctness 7,8/10, reliability 7,3/10, performance 8/10. Đây là đánh giá code bằng mô hình, không phải số đo năng suất hoặc tốc độ runtime. |

Audit credential trước đó đã thêm key còn thiếu vào shell khởi động. Collector qua kiểm tra credential và đã chạy smoke 4 arm × 2 task. Các row smoke mang `plugin_dirty_state:true`, nên analyzer loại khỏi bằng chứng promotion. Đây chỉ là kiểm tra đường chạy, không chứng minh tăng chất lượng.

## Áp dụng cho tiến trình đang chạy

Cấu hình trên đĩa và cấu hình hợp nhất đã đúng. Đã khởi động lại DSH (boot cuối
`2026-10-16T10:20:44Z`); log gate sau lần boot đó xác nhận mã mới đã nạp (`turn`
137/137, `command` dài nhất 2.023 — trần audit 2.000 hoạt động). Riêng `step` mới
thêm ở `97e1495` nằm SAU lần boot đó nên cần khởi động lại lần nữa mới thấy.

Trong terminal đang chạy DSH, dừng `dsh web`, rồi chạy:

```sh
source ~/.bashrc
dsh web
```

Không cần build Web vì thay đổi này thuộc config và plugin backend JavaScript, không sửa giao diện. Sau khi restart, kiểm tra log quyết định mới cho `completion_check`, `effort_route`, `quality_review`; bản ghi skip/fail-open cần được đọc theo lý do, không coi mọi skip là lỗi.

## Phần chưa hoàn tất của kế hoạch đánh giá

Snapshot Phase 0 giữ nguyên 2.119 event, không có nhãn outcome độc lập, held-out rỗng. Credentials không còn là blocker khi chạy từ shell đã nạp biến. Vẫn cần tập task và nhãn độc lập, protocol khóa trước, provenance tái lập và paired held-out trước khi kết luận lợi ích ròng.

Bản vá Jev Review nằm trong bundle cài đặt, vì bản cài này không có nguồn TypeScript. Cập nhật hoặc build lại plugin có thể ghi đè nó. Chạy lại regression `node tests/input-contract.mjs` sau cập nhật; hợp đồng và hướng dẫn ở `/home/lee/.dsh/plugins/jev-review/INPUT-CONTRACT.md`.

Không coi toàn bộ plan đã hoàn thành hoặc mọi lỗi tiềm ẩn đã được loại bỏ. Bản sửa flow đã qua bộ test hiện có; hiệu quả trên task thực còn cần đo.

## Rollback

Đặt lại ba cờ trong profile web thành `false`, sau đó khởi động lại DSH. Các sửa code/test vẫn giữ nguyên để không đưa lỗi flow cũ trở lại. Không tự commit, stash hoặc hoàn nguyên working tree của người dùng.
