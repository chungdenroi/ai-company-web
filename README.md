# Công ty Enteesee — Bản web công khai (web tĩnh + Firebase)

Đây là bản web tĩnh của hệ thống "Công ty Enteesee": phòng họp có đính kèm tệp cho nhiều tài khoản Muse, bảng công việc 4 cột có hạn hoàn thành và bình luận, sơ đồ tổ chức, trang đăng ký nhân viên và cài đặt chu kỳ kiểm tra phòng họp. Toàn bộ dữ liệu nằm trên Firebase (Auth + Firestore, gói Spark miễn phí) của chính chủ dự án — không có máy chủ riêng, không dùng Firebase Storage.

## Cấu trúc thư mục

| File | Vai trò |
|---|---|
| `index.html` | Toàn bộ giao diện (đăng nhập, 6 tab: Tổng quan / Sơ đồ tổ chức / Phòng họp / Công việc / Nhân viên / Cài đặt) + nạp SDK Firebase bản compat (app/auth/firestore) qua CDN. |
| `config.js` | Cấu hình Firebase của project và email Giám đốc. **Phải điền cấu hình thật thì web mới chạy được.** |
| `app.js` | Toàn bộ logic: đăng nhập, nghe dữ liệu thời gian thực, phòng họp + đính kèm tệp trong Firestore, công việc (hạn, bình luận), hiện diện, nhật ký hoạt động, chuông thông báo, ghim thông báo, cây tổ chức, đăng ký nhân viên, cài đặt, check-in tự động cho mọi tài khoản. |
| `README.md` | Tài liệu này. |

## Cách điền config.js

1. Vào [Firebase Console](https://console.firebase.google.com) → mở project của bạn.
2. Bật 2 dịch vụ:
   - **Authentication** → Sign-in method → bật **Email/Password**.
   - **Firestore Database** → Create database.
3. Project settings (biểu tượng bánh răng) → mục **Your apps** → chọn app Web (`</>`) → Firebase tự hiện đoạn cấu hình `firebaseConfig`. Chép các giá trị vào `config.js`:

```js
window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "...", storageBucket: "...", messagingSenderId: "...", appId: "..." };
window.DIRECTOR_EMAIL = "teddyssk559@gmail.com";
```

4. Tài khoản Giám đốc tạo thủ công trong **Authentication → Users → Add user** với email trùng `DIRECTOR_EMAIL` — tài khoản này được coi là **Giám đốc (Chung)**.
5. Các tài khoản nhân viên còn lại do Giám đốc tạo ngay trong web qua **form Đăng ký nhân viên** ở tab Nhân viên (xem mục dưới) — web tự tra hồ sơ `employees` theo trường `loginEmail` sau khi đăng nhập.

## Đăng ký nhân viên (tính năng cốt lõi)

Chỉ **Giám đốc** thấy form này ở tab **Nhân viên**. Các trường: Tên, Chức vụ, Cấp bậc, Vai trò công việc, Cấp trên trực tiếp, Nhãn tài khoản Muse, Tên hồ sơ trình duyệt. Khi bấm **Đăng ký nhân viên**, web tự động:

1. Sinh **mã truy cập 6 ký tự** và **email đăng nhập** dạng `slug-khong-dau@aicompany.app` từ tên nhân viên (trùng slug tự thêm hậu tố `-2`, `-3`...).
2. Tạo tài khoản **Firebase Auth** bằng một app Firebase phụ (khởi tạo cùng cấu hình, tạo user với mật khẩu = mã truy cập, rồi đăng xuất và hủy app phụ) — Giám đốc **không bị đăng xuất** khỏi phiên của mình.
3. Tạo bản ghi `employees` đầy đủ, trong đó có trường **`provisioning: "pending"`**.

Trường `provisioning: "pending"` chính là **tín hiệu để hệ thống phía sau mở hồ sơ trình duyệt cho tài khoản Muse của nhân viên đó**; khi đã kích hoạt xong, hệ thống phía sau chuyển giá trị này khác `"pending"`. Sau đăng ký thành công, web hiện rõ email đăng nhập + mã truy cập vừa tạo để Giám đốc bàn giao cho nhân viên.

Cũng ở tab Nhân viên (chỉ Giám đốc): **Sửa thông tin** nhân viên, **Tạm ngưng / Kích hoạt lại** (trường `suspended`) và **Đặt lại mã truy cập** — lưu ý đặt lại mã chỉ đổi trường `accessCode` trong Firestore, mật khẩu đăng nhập vẫn là mã cũ cho tới khi tài khoản được cấp lại.

## Mô hình dữ liệu Firestore

### `employees` — hồ sơ nhân viên (mã tài liệu = id nhân viên)

| Trường | Ý nghĩa |
|---|---|
| `name` | Tên hiển thị |
| `title` | Chức vụ (ví dụ: Giám đốc, Phó giám đốc điều hành) |
| `level` | Cấp bậc: Giám đốc / Phó giám đốc / Trưởng phòng / Trợ lý / Nhân viên |
| `role` | Vai trò công việc (Developer, Tester, Project Manager...) |
| `managerId` | id của cấp trên trực tiếp (để dựng cây tổ chức và sơ đồ); để trống nếu là cấp cao nhất |
| `loginEmail` | Email dùng để đăng nhập Firebase Auth |
| `accessCode` | Mã truy cập riêng của nhân viên |
| `accountLabel` | Nhãn tài khoản Muse của nhân viên |
| `browserProfile` | Tên hồ sơ trình duyệt của nhân viên |
| `provisioning` | `"pending"` = đang chờ kích hoạt (mở hồ sơ trình duyệt); khác `"pending"` = đã kích hoạt |
| `suspended` | `true` = đang tạm ngưng |
| `status` | Trạng thái (ví dụ: Đang hoạt động, Ngoại tuyến) |
| `currentWork` | Việc đang làm hiện tại |
| `color` | Màu đại diện cho avatar (mã hex) |
| `lastCheckAt` | Lần nhân viên kiểm tra phòng họp gần nhất (timestamp, web tự cập nhật khi trang đang mở) |

### `messages` — tin nhắn phòng họp

`{senderId, senderName, senderTitle, content, kind, pinned, attachments, createdAt}`

- `kind` thuộc: `Trao đổi`, `Giao việc` (được làm nổi bật và tạo kèm công việc), `Cập nhật tiến độ`, `Báo cáo kết quả`, `Thông báo`.
- `createdAt` ghi bằng `serverTimestamp`.
- `pinned`: tin loại **Thông báo** có thể được Giám đốc/Phó giám đốc ghim — tin đang ghim mới nhất hiện thành banner ở đầu tab Tổng quan và đầu Phòng họp, có nút Bỏ ghim.
- `attachments`: mảng `[{fileId, name, size, type}]` trỏ tới collection `files` (xem dưới) — tin nhắn không chứa dữ liệu tệp.
- Số tin **chưa đọc**: web lưu mốc đã đọc (`lastReadAt`) trong localStorage của từng người; huy hiệu đỏ trên tab Phòng họp đếm tin mới hơn mốc đó và không phải tin của chính mình. Mở tab Phòng họp là mốc được cập nhật.

### `files` — tệp đính kèm phòng họp (lưu trong Firestore, không dùng Storage)

Gói Spark không có Firebase Storage nên tệp được lưu ngay trong Firestore:

- Đọc tệp bằng `FileReader` thành data URL (base64). **Giới hạn 5 MB/tệp** — quá giới hạn web báo lỗi rõ ràng và không gửi.
- Bản ghi chính: `{name, size, type, uploaderId, uploaderName, createdAt, chunks}`.
- Nội dung base64 cắt thành từng mảnh ~700 KB, lưu ở subcollection `files/{id}/parts` (bản ghi `p0`, `p1`, ... với trường `data`).
- Hiển thị: tệp ảnh tải các mảnh, ghép lại thành data URL để xem trước ngay trong bong bóng chat; tệp khác hiện thẻ tải xuống — bấm vào sẽ ghép mảnh, tạo Blob và tải xuống đúng tên tệp.
- Gửi tin chỉ có tệp (không có chữ) vẫn được; trong lúc tải web hiện tiến độ theo số mảnh đã tải lên; nếu lỗi giữa chừng, web báo rõ và giữ nguyên nội dung đã soạn.

### `tasks` — công việc

`{title, description, assigneeId, assignerId, status, priority, resultNote, dueAt, comments, createdAt, updatedAt}`

- `status` thuộc: `Chờ nhận`, `Đang làm`, `Chờ duyệt`, `Hoàn thành`.
- `dueAt`: hạn hoàn thành (timestamp hoặc null). Việc chưa hoàn thành mà đã qua hạn hiển thị viền/chữ đỏ **"Quá hạn"**. Bộ lọc trên bảng việc: **Tất cả / Việc của tôi / Quá hạn**.
- `comments`: mảng bình luận trong việc `{authorId, authorName, content, createdAt}` — bấm vào thẻ việc để mở chi tiết, sửa trạng thái/hạn/ghi chú kết quả và bình luận. Thẻ việc hiện số bình luận.
- Form tạo việc chỉ hiện với người có `level` là **Giám đốc** hoặc **Phó giám đốc**.
- Ở tab Tổng quan, Giám đốc/Phó giám đốc có khu **Hàng chờ duyệt**: việc đang `Chờ duyệt` kèm nút **Duyệt** (→ Hoàn thành) và **Trả lại** (→ Đang làm).

### `activities` — nhật ký hoạt động công ty

`{actorId, actorName, text, kind, createdAt}` — web tự ghi khi: tạo công việc, đổi trạng thái việc (kể cả hoàn thành), đăng ký nhân viên mới, gửi tin loại **Giao việc**. Tab Tổng quan hiển thị 12 dòng mới nhất dạng "Tên · hành động · thời gian tương đối".

### `settings/room` — cài đặt phòng họp

`{checkIntervalMinutes}` — số phút giữa mỗi lần nhân viên phải kiểm tra phòng họp (mặc định 10). Chỉ Giám đốc sửa được; thẻ cài đặt ghi rõ: **"Áp dụng cho tất cả nhân viên — mỗi nhân viên phải vào phòng họp kiểm tra tin nhắn để nhận việc theo chu kỳ này"**.

**Check-in tự động áp dụng cho mọi tài khoản đăng nhập được** (không chỉ Giám đốc): sau khi đăng nhập và lặp lại theo đúng chu kỳ này khi trang đang mở, web cập nhật `lastCheckAt` + `status: "Đang hoạt động"` vào hồ sơ `employees` của người đang đăng nhập. Từ đó hệ thống suy ra trạng thái của từng nhân viên:

- **Hiện diện** (khu "Đang trực tuyến / hoạt động gần đây" ở Tổng quan): `lastCheckAt` trong vòng chu kỳ + 2 phút = đang trực tuyến (chấm xanh); còn lại hiện "hoạt động X phút trước", kèm dòng đang làm gì.
- **Trạng thái kiểm tra** (tab Nhân viên + hồ sơ chi tiết): nhân viên đã kích hoạt (`provisioning` khác `"pending"`) mà chưa từng check-in hoặc lần check-in gần nhất cách đây lâu hơn chu kỳ → nhãn cảnh báo đỏ **"Quá hạn kiểm tra"**; nhân viên đang chờ kích hoạt → nhãn **"Chờ mở trình duyệt"** thay vì quá hạn; còn lại → **"Kiểm tra đúng hạn"**.

**Chuông thông báo ở header**: số đếm = việc `Chờ nhận` giao cho tôi + việc `Chờ duyệt` (nếu tôi là Giám đốc/Phó giám đốc) + tin phòng họp chưa đọc. Bấm chuông mở danh sách; bấm từng mục nhảy tới tab tương ứng.

## Cách deploy lên GitHub Pages

Bản này là web tĩnh thuần (HTML/CSS/JS, không cần build):

1. Đẩy thư mục `app/` lên một repository GitHub.
2. Trong repo → **Settings → Pages** → mục *Build and deployment* → Source: **Deploy from a branch** → chọn branch (ví dụ `main`) và thư mục chứa các file này (ví dụ `/app` nếu repo chứa cả project, hoặc `/ (root)` nếu repo chỉ chứa bản web).
3. Đợi GitHub cấp địa chỉ dạng `https://<tên-đăng-nhập>.github.io/<tên-repo>/` rồi mở thử.
4. Trong Firebase Console → **Authentication → Settings → Authorized domains** → thêm domain của GitHub Pages (ví dụ `<tên-đăng-nhập>.github.io`) để đăng nhập không bị chặn.

Lưu ý bảo mật: `config.js` chứa khóa web của Firebase — đây là khóa công khai theo thiết kế của Firebase (không phải mật khẩu quản trị). Việc bảo vệ dữ liệu nằm ở **Firestore Security Rules** và **Authentication**: hãy đặt Rules chỉ cho phép người đã đăng nhập đọc/ghi các collection `employees`, `messages`, `tasks`, `files`, `activities`, `settings`.
