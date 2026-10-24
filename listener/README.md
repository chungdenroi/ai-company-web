# Listener realtime — phòng họp Enteesee

Giữ **1 kết nối Firestore Listen stream mở** tới collection `messages`
(project `ai-company-a51da`, gói Spark miễn phí). Chỉ tính lượt đọc khi có
document thay đổi — **không poll nhanh**. Lính canh 15 phút/lần vẫn chạy
song song làm backstop.

## Transport — đọc kỹ trước khi sửa

Google chỉ hỗ trợ `documents.listen` qua **gRPC hoặc WebChannel, không
phải REST** (xác nhận từ tài liệu chính thức + thực nghiệm 24/10/2026:
mọi POST REST tới `:listen`, kể cả body `{}`, đều bị trả HTTP 400
`Invalid value (Object)`). Vì vậy listener dùng client chính thức
`google-cloud-firestore` (`on_snapshot` = stream gRPC
`google.firestore.v1.Firestore.Listen` thật). Đừng "sửa" nó về REST POST
— REST POST đã được chứng minh là không chạy.

Listener chạy bằng Python của **venv riêng** trong thư mục này (system
python không có thư viện, pip hệ thống bị chặn bởi PEP 668):

```bash
cd ~/workspace/ai-company/listener
python3 -m venv .venv
.venv/bin/pip install google-cloud-firestore
```

Script tự đặt `SSL_CERT_FILE` về CA của egress proxy nếu chưa có (proxy
ký lại TLS bằng CA riêng; không có CA này thì gRPC không nối được).
Lỗi handshake IPv6 của proxy ở log lúc khởi động là fallback ồn ào
(IPv6 thất bại → IPv4 nối được), không phải lỗi vận hành.

## File

| File | Vai trò |
|---|---|
| `listener.py` | Script duy nhất. Chạy được 2 mode: `coordinator`, `staff`. |
| `test_listener.py` | Unit test logic phát hiện + parser stream (không mạng). |
| `room-listener-wake.sh` | Hook script, đặt tại `~/hooks/scripts/` (bản này là bản copy để lưu trữ; bản chạy thật nằm ở đó). |
| `enteesee-room-listener.service` | Unit systemd — CHỈ để tham khảo/dùng tay. Xem mục "Vì sao không dùng systemd làm supervisor". |
| `staff-guide.md` | Hướng dẫn từng bước cho Muse của từng staff tự chạy listener riêng. |
| `room-post-staff-guide.md` | Nội dung bài đăng hướng dẫn để điều phối đăng vào phòng. |
| `events.jsonl` | Event log (runtime, không commit). |
| `listener.state.json` | Resume token + id đã phát + đếm event (runtime, không commit). |
| `listener.status.json` | Trạng thái sống/chết cho watchdog đọc (runtime, không commit). |

## Chạy (điều phối)

```bash
cd ~/workspace/ai-company/listener
printf '%s\n' "<ACCESS_CODE>" | \
  setsid nohup .venv/bin/python listener.py \
    --mode coordinator \
    --email muse@aicompany.app \
    --self-names Muse \
    --self-sender-id Muse \
    --watermark-file ~/workspace/ai-company/hidden_files/firestore-watermark.json \
    > listener.log 2>&1 &
```

Mã truy cập **chỉ đi qua stdin**, không ghi file, không đưa vào argv/log.
Listener tự sign-in, tự refresh token mỗi ~50 phút, thư viện tự resume
stream khi reconnect. Một monitor thread kiểm tra `watch.is_active()`
mỗi 60 giây: 3 lần chết liên tiếp (3 phút) thì tiến trình tự thoát để
watchdog khởi động lại.

Kiểm tra sống:

```bash
cat listener.status.json   # stream_connected, events_total, last_error
tail -5 listener.log
```

## Logic phát hiện (mode coordinator)

Wake khi **bất kỳ** điều kiện nào đúng (và tin không phải của chính mình):

1. `senderId == "chung"` (mọi kind) — tin từ Chủ tịch.
2. Content có `@Muse` (so khớp không dấu, không phân biệt hoa/thường).
3. `kind == "Giao việc"` từ người khác.

Mode staff khác ở chỗ: **chỉ** wake khi `@tên mình` hoặc `Giao việc`
nhắc tên mình. Tin Chủ tịch không gọi tên staff đó thì không wake.

Tin của chính mình bị bỏ qua khi `senderId` trùng `--self-sender-id`
HOẶC tên người gửi chuẩn hóa trùng tên mình.

Dedup: bỏ qua document có `(createdAt, id)` ≤ watermark của lính canh,
hoặc id đã nằm trong `emitted_ids` (giữ tối đa 1000 id gần nhất).

## Hook

- Tên hook: `room-listener-wake`, script `~/hooks/scripts/room-listener-wake.sh`,
  poll 10s, delivery về **main chat** (điều phối).
- Hook đọc `events.jsonl` theo offset lưu trong hook state. Dòng cuối parse
  JSON lỗi (listener đang ghi dở) thì dừng ở đó, không tiêu thụ.
- Worker khi được đánh thức: đọc full event từ log theo id, báo về main
  chat **nguyên văn tin + bản nháp trả lời/giao việc** để điều phối đăng.
  Worker **không tự đăng vào phòng, không ghi file báo cáo**.

## Giám sát — watchdog cron

- Cron id: `room-listener-watchdog`, interval 5 phút.
- Mỗi lượt **chỉ kiểm tra local** (pidfile + `kill -0`): khỏe thì im lặng,
  chết thì lấy mã mới qua artifact getstate rồi khởi động lại kèm mã qua
  stdin, chờ 5s, xác minh pidfile + process + log, chỉ báo khi phải
  restart hoặc restart lỗi. Lượt khỏe không đọc Firestore, không gọi
  getstate.

## Vì sao không dùng systemd làm supervisor

Môi trường guest này: `systemctl --user` lỗi, không có user bus, không
có `XDG_RUNTIME_DIR`, `systemd-run --pipe` không kết nối được bus.
Systemd hệ thống thì chạy được, nhưng unit không thể nhận access code
nếu không ghi file/argv — cả hai đều bị cấm. Vì vậy:

- **Watchdog cron là supervisor thật.**
- Unit file chỉ là tài liệu + dùng tay cho operator (khi operator tự
  cấp mã tương tác).

## Hồi phục sau khi VM bị thay thế

Home là persistent: script, state, status, unit đều còn. Cron watchdog
do runtime quản lý, sống qua replacement. Sau replacement, trong tối đa
1 interval watchdog (5 phút), watchdog thấy process chết → khởi động lại
listener bằng mã mới lấy qua getstate. Resume token đã lưu giúp stream
nối tiếp mà không tải lại lịch sử. Nếu state cũng mất, listener listen
mới từ thời điểm hiện tại trừ 5 phút kèm dedup — lính canh 15 phút vẫn
bắt lại tin nếu có miss.

## Quota

- Stream mở: 0 read khi không có thay đổi. Mỗi document thay đổi: 1 read.
- Reconnect: dùng resume token nên không đọc lại từ đầu; khi resume lỗi
  thì listen mới từ now−5 phút (vài read tối đa).
- Sign-in Identity Toolkit không tính vào quota Firestore.
- **Không bao giờ** thêm poll nhanh (5s/10s) — đó là nguyên nhân saga
  429 kéo dài ~34h trước đây.

## Xung đột đã biết: listener + lính canh có thể báo trùng

Lính canh lọc theo watermark + sender khác Muse, không biết listener đã
xử lý tin nào. Một tin của Chủ tịch có thể được báo 2 lần (listener
trong vài giây, lính canh trong 15 phút). **Chưa được sửa trong phase
này** — không tự ý ghi watermark để né trùng (ghi watermark còn làm
lính canh bỏ qua tin staff trước đó). Hướng xử lý cho phase sau: sau khi
listener chứng minh ổn, thu hẹp lính canh về vai trò backstop-only
(quyết định này cần điều phối/user chốt).

## Thoát / mã thoát

- SIGTERM/SIGINT: hủy watch, lưu state, xóa pidfile, exit 0.
- Exit 3: sign-in lỗi (watchdog restart với mã mới sẽ tự lành nếu mã bị
  reset). Exit 5: watch chết (monitor thấy `is_active` False 3 lần).
  Exit 42: không có credential. Exit 6: thiếu thư viện
  google-cloud-firestore cho interpreter đang chạy. Exit 1: lỗi fatal khác.

## Test

```bash
python3 test_listener.py   # 32 checks, không mạng, không credential
```
