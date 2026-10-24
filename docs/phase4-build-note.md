# Phase 4 — Giao diện PRO + Phòng 3D (build 2026-10-24)

Theo guide `HUONG-DAN-MUSE-HE-THONG-DIEU-PHOI-2.html` mục 6 + 7 + 8 và bảng
nghiệm thu dòng Pha 4, cộng đúng 2 lệnh riêng của Chủ tịch: (a) phòng 3D làm
ngay trong Pha 4 thay vì Pha 5; (b) avatar chỉ hiển thị, không sửa, không đụng
Rules. Không thêm tính năng nào ngoài guide + 2 lệnh đó.

## Đã đổi (local `~/workspace/ai-company/app/`, live repo `chungdenroi/ai-company-web`, nhánh `main`)

| File | Commit | SHA-256 local = live | So byte |
|---|---|---|---|
| `index.html` | `d778323e43557eaec6f5fae045a4d877a51314ca` | `7ad7905e743acef9fe766d69a764b21e132583770603ca0108b54faf0b8c6898` | KHỚP |
| `app.js` | `f8504b052e2384751c099559286b768204f596fd` | `02446d9d766a120d108935baf86c111b7118ad59d2eae4bcd2ff6003a89ca380` | KHỚP |
| `manifest.webmanifest` | `b4ba2fa185b58bdb32947eb37635a60e49fd480d` | `4c6e8aef8d24bdf6ec472e26a962b474e1a68d1680095941a63920dd7febb073` | KHỚP |
| `icon-192.png` | `e5814cf5809a6598f2080094dbcc09060fd919e1` | `c3babc3f8d734cbf79033017947ae5d9141437240fca687b8e06efb7469fcc34` | KHỚP |
| `icon-512.png` | `b42c8b48e05b93b9415377610ae37faf38111485` | `ae85e278b93fcf94775d87024a5a1484bc385478c3c435ab85ac071beadeb02e` | KHỚP |
| `apple-touch-icon.png` | `f0dc502a5dba7d7e64a37e0be14b7724bb508061` | `f98724600a3b13775718a981738c8b2953eee319bcb7d0dbd6c09b39e1959940` | KHỚP |

`config.js` KHÔNG đổi. Không đụng `listener-v2`, Firestore Rules, `STATE.md`,
`MEMORY.md`, cron, luồng đăng nhập/auth. Không thêm secret. Không copy dữ liệu
mẫu từ file PRO (kiểm tra: không có `t_104` trong code).

## Checklist 11 mục (đủ, không bỏ mục nào)

1. **Tổng quan 4 thẻ nhân viên**: chỉ nhân viên AI (level khác "Giám đốc") —
   chấm trạng thái, `currentWork` ưu tiên `presence.currentWork`, thanh tiến độ
   (chỉ khi `presence.progress` có số %), dòng đỏ khi `presence.blocker` có nội
   dung. Thêm thẻ nổi bật "Cần duyệt / Việc quá hạn" và chip số việc theo trạng
   thái. (Chủ tịch vẫn hiện ở dải hiện diện, Sơ đồ tổ chức, tab Nhân sự.)
2. **Phòng chat**: kênh chung + DM từng người + luồng theo việc + gợi ý @tên
   (giữ hộp gợi ý cũ) + lọc kind + nút "Đánh dấu đã xử lý" + ô "Cần trả lời" /
   "Khẩn" ở ô soạn tin. Xem lưu ý (a) dưới đây.
3. **Việc**: Kanban 5 cột theo vòng đời + kéo-thả đổi trạng thái (ghi lịch sử
   "Kéo thả Kanban") + cây việc cha-con (toggle Kanban/Cây việc) + chip đỏ quá
   ngưỡng ack (giữ nguyên) + lọc người / vai trò job / ưu tiên. Xem lưu ý
   (b), (c).
4. **Duyệt**: giữ nguyên cơ chế cũ (lý do bắt buộc + bằng chứng + chặn tự
   duyệt + duyệt từng mục), chỉ chuyển hộp từ tab Tổng quan sang tab "Duyệt"
   riêng; người không có quyền duyệt thấy dòng hướng dẫn thay vì hộp duyệt.
5. **Nhân sự**: giữ hồ sơ cũ, thêm lưới thống kê (việc đang mở / hoàn thành /
   độ trễ ack trung bình / vai trò job) và hàng "Độ trễ ack trung bình" trong
   hồ sơ chi tiết.
6. **Nhật ký quyết định**: chỉ thêm (không sửa/xoá), thêm tab "Nhật ký" với
   tìm kiếm + nút tải + xuất file JSON.
7. **Tìm kiếm toàn cục**: ô tìm ở topbar, phím `/` để focus, `Escape` để đóng,
   kết quả việc / tin nhắn / nhân sự / quyết định (đã tải); giao việc nhanh
   1 dòng ở tab Việc (chỉ quản lý thấy).
8. **Sức khoẻ hệ thống**: từ `presence.lastSeen` (quá 3 phút = ngoại tuyến
   theo guide mục 1), mỗi nhân viên một dòng + ghi chú lỗi stream trong phiên
   (kể cả 429 `resource-exhausted`) + quota ghi "chưa có dữ liệu" (xem (d)).
9. **Cài đặt**: giữ ngưỡng ack + khoảng kiểm tra, thêm chọn Sáng/Tối (lưu máy
   này, áp dụng trước khi vẽ trang), phiên bản quy tắc, tick bật thông báo
   nhắc tên (chỉ khi tab đang ẩn).
10. **Mobile + PWA**: tái dùng thanh tab dưới sẵn có — 5 mục Tổng quan, Phòng
    chat, Việc, Nhân sự, Thêm (Duyệt / 3D / Nhật ký / Cài đặt / Sơ đồ / Hộp
    thư); thẻ nhân viên 2 cột; Kanban mobile = chip lọc ngang theo cột (mặc
    định cột "Chờ nhận"); chat vuốt phải để trả lời `@tên`; modal bottom
    sheet + ô nhập dính đáy đã có từ trước được giữ nguyên; `manifest` +
    `apple-mobile-web-app-capable` + icon 192/512/180.
11. **Phòng 3D (guide mục 8, làm ngay trong Pha 4)**: three.js **0.160.0 UMD
    từ cdnjs**, nạp lười chỉ khi Chủ tịch mở tab; cảnh isometric nhìn từ trên
    xéo gồm 1 phòng Chủ tịch (vách ngăn + bàn), 1 bàn điều phối, 3 bàn nhân
    viên, bảng việc treo tường (tối đa 24 ô màu theo trạng thái việc đang mở),
    khu nghỉ (bàn tròn + cây). Trạng thái: working = ngồi bàn, màn hình sáng +
    vòng tiến độ trên đầu; idle = đứng khu nghỉ; blocked = biểu tượng đỏ trên
    đầu (nhấp nhô); offline / chưa có presence = bàn trống mờ, nhân vật ẩn.
    Bấm nhân vật hiện khung (đang làm gì, việc, tiến độ, nút "Nhắn" / "Giao
    việc"). Tin nhắn mới hiện bong bóng ~6s trên đầu người gửi (chỉ khi đang
    mở tab 3D). Hiệu năng: giới hạn 30fps, tắt đổ bóng, nút "Chế độ danh
    sách" cho máy yếu, tôn trọng `prefers-reduced-motion` (không chạy vòng
    lặp, chỉ vẽ lại khi dữ liệu đổi). Chỉ Chủ tịch xem (ẩn menu + chặn tab
    với người khác bằng `isDirector`). **Không thêm lượt đọc nào**: dùng
    `presence` đã subscribe sẵn + `employees`/`tasks`/`messages` hiện có.

## THAY ĐỔI VÒNG ĐỜI — CẦN CHỦ TỊCH BIẾT (báo rõ, không giấu)

`TASK_STATUSES` cũ 4 cột đã thành 5 cột:
`Chờ nhận → Đã nhận → Đang làm → Chờ duyệt → Hoàn thành`.
`acknowledgeTask` (nút "Xác nhận nhận việc") giờ chuyển việc sang **"Đã nhận"**
thay vì nhảy thẳng sang "Đang làm"; assignee chuyển tiếp "Đã nhận → Đang làm"
khi bắt đầu làm. Lý do: không tách cột này thì Kanban 5 cột của guide không
thể hiện được từ dữ liệu thật (trước đây ack gộp "đã nhận" và "đang làm" thành
một trạng thái). Đã kiểm tra tác động: đếm chuông (việc "Chờ nhận" của tôi),
quá hạn ack (chỉ "Chờ nhận"), hộp duyệt (chỉ "Chờ duyệt"), đếm việc mở (khác
"Hoàn thành") đều không đổi; `handleStatusSideEffects` bỏ qua "Đã nhận"
(không tạo approval/log thừa). Lịch sử cũ vẫn đọc đúng (sự kiện ack cũ ghi
`Chờ nhận → Đang làm` vẫn hiển thị nguyên vẹn).

## Lưu ý trung thực (không phải lỗi, là giới hạn dữ liệu thật)

- (a) **DM / luồng theo việc là bộ lọc phía client trên luồng chung**, vì
  schema tin nhắn hiện tại không có trường kênh/người nhận: DM = tin mà người
  gửi nhắc tên đối phương (hoặc ngược lại); luồng = tin có `linkedTaskTitle`
  trùng việc. Muốn kênh/DM thật cần envelope tin nhắn mới của guide (việc
  schema Pha 1, ngoài phạm vi Pha 4). Ô "Cần trả lời"/"Khẩn" ghi đúng 2 trường
  của guide (`needsReply`, `priority: "khẩn"`) và chỉ ghi khi người gửi tick.
- (b) **Lọc "dự án"**: task hiện không có trường dự án; guide định nghĩa
  `roleInJob`, không định nghĩa project id. Lọc thứ ba dùng trường `role`
  thật ("Vai trò của job này") và được ghi nhãn đúng là "Vai trò job", không
  ghi nhãn "Dự án".
- (c) **Cây cha-con**: đã dựng xong (gốc + con lồng nhau từ `parentTaskId`,
  tối đa 5 tầng chống vòng lặp), nhưng hiện chưa có writer nào ghi
  `parentTaskId` nên cây đang hiển thị trạng thái trống trung thực, kèm hướng
  dẫn ghi `parentTaskId` theo guide mục 5.
- (d) **Quota**: web client không đọc được quota Firestore nên các chỗ quota
  hiển thị "chưa có dữ liệu" kèm ghi chú "số liệu quota ghi trong decisions
  theo Pha 0". Lỗi stream trong phiên (vd 429) thì hiển thị thật từ callback
  lỗi của listener presence.
- (e) **"Chưa có dữ liệu" ở các chỗ khác**: nhân viên chưa có presence doc
  (thẻ, sức khoẻ, 3D legend); tiến độ khi `presence.progress` không chứa số
  %; độ trễ ack khi chưa có sự kiện ack nào; phiên bản quy tắc khi
  `settings/room.rulesVersion` chưa có.
- (f) **Trạng thái đã xử lý** lưu ở `localStorage` của từng máy, không ghi lên
  server (không tự chế ngữ nghĩa server mới).
- (g) **Phòng 3D có tối đa 4 bàn nhân viên** (1 điều phối + 3 nhân viên) đúng
  guide; công ty hiện đúng 4 nhân viên AI nên vừa đủ. Nếu thêm người thứ 5,
  người đó vẫn hiện ở legend + chế độ danh sách với ghi chú "chưa có bàn
  trong phòng 3D".
- (h) Trường `status` do `set_work` ghi luôn là "Đang làm" nên phòng 3D/sức
  khoẻ suy trạng thái từ `currentWork`/`blocker`/`lastSeen`, không dùng
  `status`.

## Giữ nguyên (không hồi quy)

Hồ sơ nhân viên, tạo việc có "Vai trò của job này" + tick "Việc quan trọng",
decision log cũ, hộp duyệt cũ, vòng đời việc ghi history, ngưỡng ack sửa
được, chip đỏ quá ngưỡng, gợi ý @tên, ghim thông báo, chuông, hộp thư, sơ đồ
tổ chức, modal chi tiết việc, bottom sheet mobile, ô nhập dính đáy.

## Kiểm chứng tĩnh đã làm (không dùng trình duyệt live)

- `node --check app.js`: PASS.
- Quét id HTML mới: 206 id, 0 trùng; mọi id Phase 4 có đúng 1 lần; 11 nút
  `data-tab` (8 menu spec + Sơ đồ + Hộp thư + Thêm); 3 pane mới đều
  `class="tabpane hidden"`.
- Mọi hàm Phase 4 được tham chiếu đều có định nghĩa; mọi id Phase 4 được JS
  gọi đều có trong HTML (các id "thiếu" khi quét thô đều là id tạo động bằng
  innerHTML trong JS cũ: modal việc, hồ sơ duyệt, sửa guidance).
- Nút: `button{min-height:44px}` toàn cục + `.btn.small`/`.modal-close` về
  44px (ghi đè quy tắc 40px cũ, đứng sau nên thắng cascade); `.link-btn`,
  `.sub-item`, `.kchip`, `.filter-btn`, `.more-item` đều ≥44px.
- Chữ nhập: `input,select,textarea{font:inherit}` (body 16px) + `.task-card
  textarea` về 1rem + ô tìm kiếm 16px — không còn ô nhập nào dưới 16px (tránh
  iOS tự phóng to). Chữ nhỏ còn lại (.76rem chip, .93rem hint) là nhãn/thông
  tin phụ của thiết kế cũ, không phải ô nhập.
- Không còn `width` cố định ≥360px (chỉ còn breakpoint media query);
  `overflow-x:hidden` ở body; `viewport-fit=cover` + safe-area ở tab bar,
  composer, modal, more-menu.
- Manifest JSON hợp lệ; icon đúng kích thước (192/512/180) và đúng đường
  dẫn trong `<link>`.
- Đẩy tuần tự 6 file, không song song; so byte live/local: 6/6 KHỚP ngay
  lần đầu (không cần retry).

## CHƯA kiểm chứng (phần của agent chính, không tuyên bố đã làm)

- Ảnh chụp màn hình 360px / 390px kiểm tra không tràn ngang (subagent này
  không có trình duyệt live).
- Chạy thật trên trình duyệt / điện thoại: đăng nhập, mở tab 3D, kéo-thả
  Kanban, vuốt trả lời chat, cài PWA từ màn hình chính.
