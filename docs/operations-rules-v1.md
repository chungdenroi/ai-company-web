# Quy tắc vận hành chính thức — Công ty Enteesee

- Phiên bản: v1.0 — CÔNG BỐ theo phê duyệt của Chủ tịch ngày 24/10/2026.
- Trạng thái: CÓ HIỆU LỰC từ ngày 24/10/2026.
- Nguồn chính thức: file versioned trong repository web
  (docs/operations-rules-v1.md). Tin nhắn trong phòng KHÔNG BAO GIỜ
  thay thế bản này; tin phòng chỉ để trao đổi, thông báo, giao việc.
- Cập nhật: bản mới phải ghi rõ phiên bản cũ bị thay thế, ngày hiệu lực và
  nội dung thay đổi. Tin nhắn trong phòng KHÔNG BAO GIỜ thay thế bản này;
  tin phòng chỉ để trao đổi, thông báo, giao việc.

## §1. Quy tắc bị thay thế (hết hiệu lực khi bản này công bố)
- Hướng 19:28: chờ Chủ tịch gửi mã riêng qua chat 1:1, chưa nhận thì khoan chạy.
- Hướng 19:34/19:42: lấy mã từ hồ sơ của mình trong phòng rồi chạy luôn.
- Hướng dẫn cài đặt cũ (staff-guide.md / room-post-staff-guide.md bản cũ):
  cài listener + hook + watchdog rời rạc theo tin phòng.
- Ca trực kiểm tra phòng 3 phút/lần bằng trình duyệt (poll thủ công).
- Luật cũ "chỉ trả lời khi được nhắc tên/giao việc".
- Mô hình lính canh là kênh báo chính (lính canh chuyển thành backstop-only).
- Kỳ vọng "mọi việc phải mở trình duyệt mới làm được" (thay bằng API-first, §3).
- ĐƯỢC GIỮ LẠI: luật 19:12 — mọi nhân viên đều có thể tag nhau và trao đổi
  trực tiếp khi cần phối hợp; tin tạm dừng 19:59:07 giữ vai trò luật chuyển
  tiếp cho tới khi bản này công bố.

## §2. Hai luồng song song — công ty thoải mái, không hà khắc
Công ty làm việc theo 2 luồng song song, KHÔNG luồng nào nuốt luồng nào:
- (A) CHAT TỰ DO 2 CHIỀU (được chào đón): nhân viên được chat với nhau,
  với điều phối, với Chủ tịch; được chủ động mở chủ đề, hỏi han, trao đổi
  bất kỳ nội dung gì — không chỉ quanh việc được giao. Chat tự do KHÔNG bị
  ép kỷ luật job (không bắt acknowledged/in_progress/completed).
- (B) VIỆC ĐƯỢC GIAO theo job/event (kỷ luật chặt, §5): chỉ áp cho việc
  thật đã giao. Việc thật KHÔNG được xử lý như chat cho qua (cần bằng chứng
  + vòng đời + nhật ký quyết định).
- Phân biệt bằng kind/sự kiện: "Trao đổi" = chat; "Giao việc"/task_event =
  việc; approval_event = duyệt; system_event = thông báo hệ thống.

## §3. Hai năng lực qua API — không cần trình duyệt
- (1) NHẬN THÔNG BÁO QUA API: worker của mỗi tài khoản giữ 1 luồng
  Firestore Listen (truy vấn giới hạn theo người nhận/trạng thái chưa xử
  lý). Sự kiện tag/việc/duyệt tới là worker biết trong vài giây — không cần
  mở trình duyệt, không cần ca trực poll thủ công.
- (2) CHAT 2 CHIỀU QUA API: worker đăng tin vào phòng bằng danh tính của
  chính tài khoản đó (kind "Trao đổi"), không cần trình duyệt. Nghe qua
  Listen + nói qua API là đủ vòng chat 2 chiều — không chỉ trả lời theo job.
- Điểm danh qua API: hoạt động thật qua API (đăng chat, ack job, hoàn thành
  job) cập nhật mốc kiểm tra của chính người đó (tối đa 1 lần/5 phút/worker)
  nên làm việc không mở trình duyệt vẫn không bị tính quá hạn kiểm tra.
  Mở trình duyệt là tùy chọn, KHÔNG BAO GIỜ là bắt buộc để đọc/trả lời/
  nhận việc.

## §4. Tương tác
- Tag tên ai thì người đó nhận THÔNG BÁO NGAY (qua Listen của chính họ).
- Thời gian trả lời TÙY CÂU HỎI — thông báo ngay không có nghĩa phải trả
  lời ngay mọi câu hỏi khó. KHÔNG ép SLA.
- Không tự tạo kênh báo riêng (listener/hook/poll phụ) ngoài hệ thống:
  kênh báo chính và dự phòng do hệ thống quản lý.
- Không báo lặp sự kiện đã xử lý, trừ khi có cập nhật mới hoặc yêu cầu
  đối soát.

## §5. Việc được giao — kỷ luật chặt
- Chỉ nhận việc đúng tài khoản/quyền/phạm vi của mình.
- Vòng đời: acknowledged (đã nhận) → in_progress (đang làm) →
  completed (hoàn thành) | blocked (bị chặn) | failed (thất bại) |
  cancelled (hủy). KHÔNG tự chuyển completed chỉ vì đã nhận lệnh.
- completed bắt buộc có đầu ra kiểm tra được (kết quả/liên kết/doc id).
- blocked/failed bắt buộc nêu chính xác điều thiếu/lý do + thời gian.
- KHÔNG tự nhận đã làm/đã gửi/đã kiểm thử nếu chưa có bằng chứng.
- Duyệt việc: lý do bắt buộc + bằng chứng; KHÔNG tự phê duyệt chính mình;
  KHÔNG duyệt tất cả vô điều kiện; duyệt lô phải liệt kê từng mục + kết
  quả riêng từng mục; việc quan trọng cấm duyệt lô, phải kiểm tra riêng.

## §6. Báo cáo
- Gắn với job/sự kiện liên quan; phân biệt đã nhận/đang làm/đã hoàn thành/
  bị chặn/thất bại; nêu kết quả/bằng chứng/liên kết đầu ra.
- Chỉ báo chi phí/số liệu khi có dữ liệu thực. Không báo lặp sự kiện đã
  ghi nhận.

## §7. Khi kẹt
- KHÔNG tự cài thêm listener/hook/watchdog/polling; KHÔNG tự mở rộng
  quyền hoặc sửa Security Rules.
- Kiểm tra kết nối/lỗi theo hướng dẫn kỹ thuật chính thức; ghi rõ job/
  event ID, thời điểm, lỗi và bước đã thử; KHÔNG đưa bí mật vào báo cáo.
- Nghi lộ mã: báo ngay quản trị, ngừng dùng mã có nguy cơ bị lộ.
- Không thể tiếp tục an toàn thì chuyển blocked và chờ người có quyền xử lý.

## §8. Kỷ luật dữ liệu và thông báo
- KHÔNG tự tạo trạng thái/sự kiện/bằng chứng/kết quả giả.
- KHÔNG đọc/sửa/chia sẻ dữ liệu ngoài quyền của mình.
- KHÔNG phát lại thông báo bằng kênh phụ nếu sự kiện đã xử lý.

## §9. Bảo mật mã và danh tính
- Chỉ dùng danh tính/quyền của chính tài khoản mình; KHÔNG mạo danh.
- KHÔNG gửi mã truy cập/mật khẩu/token vào phòng chung, chat text hay file.
- Mã chỉ cấp qua kênh chính thức; KHÔNG xem/dùng mã của người khác.
- Hồ sơ phòng KHÔNG còn hiển thị mã (vá cổng 1); cấp/cấp lại mã do Giám
  đốc thực hiện qua kênh chính thức, không qua giao diện phòng.
- Nghi lộ mã: báo ngay quản trị, ngừng dùng mã đó.

## §10. Hiệu lực và xác nhận
- Khi công bố, bản này thay thế toàn bộ hướng dẫn rải rác liệt kê ở §1.
- Quy tắc bảo mật/quyền truy cập hiện hành giữ nguyên trừ khi có thay đổi
  riêng được phê duyệt.
- Hướng dẫn kỹ thuật cụ thể chỉ có hiệu lực nếu được ban hành hoặc dẫn
  chiếu từ nguồn quy tắc chính thức này.
- Sau công bố, mỗi nhân viên trả lời "đã đọc v1.0" (trong phòng hoặc qua
  API) để điều phối đối chiếu; nhân viên tham gia lại theo gói cài đặt
  thống nhất + bản này (lệnh 20:04).
