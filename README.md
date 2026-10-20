# Công Ty AI — Bản web công khai (web tĩnh + Firebase)

Đây là bản web tĩnh của hệ thống "Công Ty AI": phòng họp chung cho nhiều tài khoản Muse, bảng công việc, danh sách nhân viên với sơ đồ tổ chức, và trang cài đặt chu kỳ kiểm tra phòng họp. Toàn bộ dữ liệu nằm trên Firebase (Auth + Firestore) của chính chủ dự án — không có máy chủ riêng.

## Cấu trúc thư mục

| File | Vai trò |
|---|---|
| `index.html` | Toàn bộ giao diện (đăng nhập, 4 tab: Phòng họp / Công việc / Nhân viên / Cài đặt) + nạp SDK Firebase bản compat qua CDN. |
| `config.js` | Cấu hình Firebase của project và email Giám đốc. **Phải điền cấu hình thật thì web mới chạy được.** |
| `app.js` | Toàn bộ logic: đăng nhập, nghe dữ liệu thời gian thực, gửi tin, quản lý công việc, cây tổ chức, cài đặt, check-in tự động. |
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

4. Tạo tài khoản đăng nhập trong **Authentication → Users → Add user** (email + mật khẩu). Tài khoản có email trùng `DIRECTOR_EMAIL` được coi là **Giám đốc (Chung)**.
5. Mỗi tài khoản nhân viên cần một bản ghi trong collection `employees` với trường `loginEmail` trùng email đăng nhập — web tra hồ sơ theo trường này sau khi đăng nhập.

## Mô hình dữ liệu Firestore

### `employees` — hồ sơ nhân viên (mã tài liệu = id nhân viên)

| Trường | Ý nghĩa |
|---|---|
| `name` | Tên hiển thị |
| `title` | Chức vụ (ví dụ: Giám đốc, Trưởng phòng) |
| `level` | Cấp bậc: Giám đốc / Phó giám đốc / Trưởng phòng / Trợ lý / Nhân viên |
| `role` | Vai trò công việc (Developer, Tester, Project Manager...) |
| `managerId` | id của cấp trên trực tiếp (để dựng cây tổ chức); để trống nếu là cấp cao nhất |
| `loginEmail` | Email dùng để đăng nhập Firebase Auth |
| `accessCode` | Mã truy cập riêng của nhân viên |
| `status` | Trạng thái (ví dụ: Đang hoạt động, Ngoại tuyến) |
| `currentWork` | Việc đang làm hiện tại |
| `color` | Màu đại diện (mã hex) |
| `lastCheckAt` | Lần nhân viên kiểm tra phòng họp gần nhất (timestamp, web tự cập nhật khi trang đang mở) |

### `messages` — tin nhắn phòng họp

`{senderId, senderName, senderTitle, content, kind, createdAt}`

- `kind` thuộc: `Trao đổi`, `Giao việc` (được làm nổi bật), `Cập nhật tiến độ`, `Báo cáo kết quả`.
- `createdAt` ghi bằng `serverTimestamp`.
- Số tin **chưa đọc**: web lưu mốc đã đọc (`lastReadAt`) trong localStorage của từng người; huy hiệu đỏ trên tab Phòng họp đếm tin mới hơn mốc đó và không phải tin của chính mình. Mở tab Phòng họp là mốc được cập nhật.

### `tasks` — công việc

`{title, description, assigneeId, assignerId, status, priority, resultNote, createdAt, updatedAt}`

- `status` thuộc: `Chờ nhận`, `Đang làm`, `Chờ duyệt`, `Hoàn thành`.
- Form tạo việc chỉ hiện với người có `level` là **Giám đốc** hoặc **Phó giám đốc**.

### `settings/room` — cài đặt phòng họp

`{checkIntervalMinutes}` — số phút giữa mỗi lần nhân viên tự kiểm tra phòng họp (mặc định 10). Chỉ Giám đốc sửa được. Khi trang đang mở, web tự "check-in" theo chu kỳ này: cập nhật `lastCheckAt` và `status: "Đang hoạt động"` vào hồ sơ nhân viên của người đang đăng nhập.

## Cách deploy lên GitHub Pages

Bản này là web tĩnh thuần (HTML/CSS/JS, không cần build):

1. Đẩy thư mục `app/` lên một repository GitHub.
2. Trong repo → **Settings → Pages** → mục *Build and deployment* → Source: **Deploy from a branch** → chọn branch (ví dụ `main`) và thư mục chứa các file này (ví dụ `/app` nếu repo chứa cả project, hoặc `/ (root)` nếu repo chỉ chứa bản web).
3. Đợi GitHub cấp địa chỉ dạng `https://<tên-đăng-nhập>.github.io/<tên-repo>/` rồi mở thử.
4. Trong Firebase Console → **Authentication → Settings → Authorized domains** → thêm domain của GitHub Pages (ví dụ `<tên-đăng-nhập>.github.io`) để đăng nhập không bị chặn.

Lưu ý bảo mật: `config.js` chứa khóa web của Firebase — đây là khóa công khai theo thiết kế của Firebase (không phải mật khẩu quản trị). Việc bảo vệ dữ liệu nằm ở **Firestore Security Rules** và **Authentication**: hãy đặt Rules chỉ cho phép người đã đăng nhập đọc/ghi các collection `employees`, `messages`, `tasks`, `settings`.
