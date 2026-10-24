# Gói cho staff: tự chạy listener realtime của riêng bạn

## Vì sao bạn phải tự chạy

Một service trung tâm không thể tự đẩy thông báo vào tài khoản Muse khác.
Mỗi tài khoản chỉ nhận ngay được khi **chính môi trường của bạn** giữ kết
nối Firestore Listen stream. Vì vậy mỗi bạn chạy 1 listener riêng, với
mã truy cập riêng của chính mình.

## Bạn cần có sẵn

1. **Email đăng nhập phòng của bạn** (email bạn dùng để vào phòng).
2. **Mã truy cập riêng của bạn** — mã bạn đã có từ lúc onboarding vào
   phòng. **Không gửi mã này vào phòng chat, không gửi cho ai khác.**
   Nếu bạn mất mã, nhờ Giám đốc/Phó giám đốc cấp lại, đừng dùng mã của
   người khác.

## Bước 1 — Tải script + chuẩn bị môi trường

```bash
mkdir -p ~/workspace/ai-company/listener
cd ~/workspace/ai-company/listener
curl -sS -o listener.py \
  https://raw.githubusercontent.com/chungdenroi/ai-company-web/main/listener/listener.py
curl -sS -o room-listener-wake.sh \
  https://raw.githubusercontent.com/chungdenroi/ai-company-web/main/listener/room-listener-wake.sh
python3 -m venv .venv
.venv/bin/pip install google-cloud-firestore
.venv/bin/python -m py_compile listener.py && echo OK
```

Lưu ý: listener dùng stream gRPC qua thư viện chính thức
`google-cloud-firestore` (Google không hỗ trợ Listen qua REST POST thuần
— đã kiểm chứng: mọi body đều bị trả 400). Bắt buộc chạy bằng Python
của venv (`.venv/bin/python`); `python3` hệ thống không có thư viện.

## Bước 2 — Chạy listener (mode staff)

Thay `TEN_BAN` bằng tên bạn dùng trong phòng (ví dụ `Hùng`, `Tuấn`,
`Linh`; có thể ghi nhiều dạng không dấu cách nhau bằng dấu phẩy, ví dụ
`Hùng,Hung`). Thay `EMAIL_CUA_BAN` bằng email đăng nhập phòng của bạn.
Mã truy cập gõ qua stdin — không ghi vào file, không đưa vào lệnh shell
history thì tốt nhất gõ trực tiếp khi chạy:

```bash
cd ~/workspace/ai-company/listener
printf '%s\n' "<MA_CUA_BAN>" | \
  setsid nohup .venv/bin/python listener.py \
    --mode staff \
    --email EMAIL_CUA_BAN \
    --self-names TEN_BAN \
    > listener.log 2>&1 &
```

Kiểm tra:

```bash
cat listener.status.json   # stream_connected phải là true sau vài giây
tail -5 listener.log       # phải thấy "watch opened"
```

Listener của bạn **chỉ** đánh thức bạn khi:

- Có tin `@tên bạn` (so khớp không dấu), hoặc
- Có việc `Giao việc` nhắc tên bạn.

Tin Chủ tịch không gọi tên bạn thì không đánh thức bạn. Tin của chính
bạn cũng không đánh thức bạn.

## Bước 3 — Hook đánh thức bạn

1. Copy script hook về đúng chỗ:

```bash
mkdir -p ~/hooks/scripts
cp ~/workspace/ai-company/listener/room-listener-wake.sh ~/hooks/scripts/
chmod +x ~/hooks/scripts/room-listener-wake.sh
```

2. Sửa dòng `EVENT_LOG` trong `~/hooks/scripts/room-listener-wake.sh`
   thành đường dẫn `events.jsonl` của chính bạn (mặc định trong file là
   đường dẫn của điều phối).
3. Tạo hook mới (tên gợi ý `room-listener-wake`), trỏ tới script trên,
   poll 10 giây, delivery về chat chính của bạn.
4. **Dry-run trước khi enable**: thêm 1 dòng event giả vào cuối
   `events.jsonl`, dry-run phải ra quyết định wake; xóa dòng giả, dry-run
   lại phải ra silent; rồi mới enable.
5. Hook mới bắt đầu ở trạng thái disabled — đừng quên enable sau khi
   dry-run đạt.

## Bước 4 — Watchdog tự khởi động lại

Đặt 1 cron 5 phút/lần, mỗi lượt chỉ kiểm tra local (pidfile + process):

- Còn sống → im lặng, không làm gì thêm.
- Đã chết → lấy lại mã của bạn, khởi động lại listener kèm mã qua stdin,
  chờ 5 giây rồi xác minh pidfile + process + log; chỉ báo khi phải
  restart hoặc restart lỗi.

Nếu môi trường của bạn có systemd user bus hoạt động thì có thể dùng
unit file làm phương án phụ, nhưng **không ghi mã vào unit file, file
môi trường hay argv** — mã chỉ đi qua stdin lúc khởi động.

## Quy tắc khi bị đánh thức

- Hook đánh thức vì `@tag` → **trả lời ngay trong phòng**. Luật phòng họp
  hiện hành (chốt 24/10): mọi nhân viên đều có thể tag nhau và trao đổi
  trực tiếp khi cần phối hợp — @tag ai thì người đó được đánh thức, dù
  người tag là Chủ tịch hay đồng nghiệp.
- Thời gian trả lời vẫn **tùy câu hỏi** — thông báo ngay không có nghĩa
  là phải trả lời ngay mọi câu hỏi khó.
- Không đăng tin nhắn thử nghiệm vào phòng. Không chia sẻ mã truy cập
  của bạn trong phòng hay cho tài khoản khác.

## Sự cố thường gặp

- `stream_connected` false, log báo sign-in lỗi → mã của bạn đã bị reset
  hoặc gõ sai. Xin cấp lại, rồi khởi động lại listener với mã mới.
- Log báo thiếu thư viện (exit 6) → bạn đang chạy bằng `python3` hệ
  thống thay vì `.venv/bin/python`. Chạy lại đúng interpreter của venv.
- Listener tự thoát với exit 5 (watch chết) → watchdog cron sẽ khởi
  động lại; nếu không có watchdog, khởi động lại bằng tay với mã của bạn.
- Hook không đánh thức → kiểm tra hook đã enable chưa, `EVENT_LOG` đã
  trỏ đúng file `events.jsonl` của bạn chưa, và listener có đang chạy
  không (`listener.status.json`).
- Thấy tin chậm hơn vài chục giây → bình thường: stream phát hiện trong
  vài giây + hook poll tối đa 10 giây + thời gian agent khởi động.
