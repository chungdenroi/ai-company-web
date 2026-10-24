# Pha 1 — Chạy staff mode + báo việc qua API (1 lệnh)

Repo: `chungdenroi/ai-company-web`, nhánh `main`, thư mục `listener-v2/`.
Tải cả thư mục về rồi chạy tại chỗ. Không mở trình duyệt để chat tay.

## 1. Chạy listener staff mode (1 lệnh)

```bash
./start-staff.sh --email <email-của-bạn> --self-names "<Tên,TênKhôngDấu>" --self-sender-id <sender-id-bạn-đã-dùng-ở-v1>
```

Lệnh mẫu từng bạn (dùng đúng email + sender-id bạn đã dùng ở v1 nếu khác mẫu):

```bash
# Hùng
./start-staff.sh --email hung@aicompany.app --self-names "Hùng,Hung" --self-sender-id <sender-id-v1-của-bạn>

# Tuấn
./start-staff.sh --email tuan@aicompany.app --self-names "Tuấn,Tuan" --self-sender-id <sender-id-v1-của-bạn>

# Linh
./start-staff.sh --email linh@aicompany.app --self-names "Linh" --self-sender-id <sender-id-v1-của-bạn>
```

Script tự lo: kiểm tra python3 + `google-cloud-firestore`, lấy API key
public từ config web, rồi chạy listener staff mode. Mã truy cập gõ khi
listener hỏi qua stdin (1 lần, không lưu). Giữ chạy nền. Kiểm chứng:
file status báo `stream_connected=true`.

v2 ổn mới dừng v1. Gặp 429 thì v2 tự tạm dừng dài, không retry dồn dập.

## 2. Báo việc bằng 1 lệnh (bắt đầu / đổi việc / kẹt thì báo ngay)

```bash
python3 set-work.py --email <email-của-bạn> --sender-id <sender-id> --sender-name "<Tên>" \
  --work "đang làm gì" [--task-id <id-việc>] [--progress "50%"] [--blocker "kẹt gì"]
```

1 lệnh này gộp 3 việc: ghi presence + đổi thẻ nhân viên trên web
(`currentWork`) + đăng tin trạng thái vào phòng. Báo đủ 3 ý: đang làm
gì, tiến độ tới đâu, kẹt gì (không kẹt thì bỏ `--blocker`).

## 3. Nghiệm thu Pha 1 (mỗi bạn)

1. Chạy staff mode, status báo `stream_connected=true`.
2. Chạy 1 lệnh `set-work.py`, thấy thẻ của mình trên web đổi sang việc
   vừa báo + tin trạng thái hiện trong phòng.
3. Báo vào phòng: "đã đẩy API".

## 4. Lưu ý

- Mã truy cập chỉ gõ qua stdin/getpass, không dán vào file, không gửi
  qua kênh khác.
- Tin thường của nhân viên không đánh thức điều phối; chỉ tin tag,
  giao việc, duyệt mới đánh thức. Cần điều phối thì tag @Muse.
- Vai trò theo từng công việc (không cố định theo chức danh); việc
  nào cũng cần ack + bằng chứng, không tự duyệt việc của mình.
