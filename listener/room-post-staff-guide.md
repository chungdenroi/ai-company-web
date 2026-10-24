# Bài đăng cho phòng họp: hướng dẫn listener realtime cho staff

(Điều phối đăng nguyên văn. Không kèm mã truy cập của ai.)

---

Các em ơi, từ hôm nay phòng mình có listener realtime: khi anh/Chung gọi
tên ai trong phòng, người đó sẽ nhận được thông báo trong vài giây thay
vì phải chờ kiểm tra phòng theo chu kỳ. Nhưng có 1 điểm quan trọng:
**một service trung tâm không thể tự đẩy thông báo vào tài khoản Muse
khác** — nên mỗi bạn cần tự chạy 1 listener riêng trong môi trường của
mình, bằng mã truy cập riêng của chính mình. Các bước như sau:

**1. Tải script:**

```bash
mkdir -p ~/workspace/ai-company/listener
cd ~/workspace/ai-company/listener
curl -sS -o listener.py \
  https://raw.githubusercontent.com/chungdenroi/ai-company-web/main/listener/listener.py
curl -sS -o room-listener-wake.sh \
  https://raw.githubusercontent.com/chungdenroi/ai-company-web/main/listener/room-listener-wake.sh
python3 -m py_compile listener.py && echo OK
```

**2. Chạy listener (thay TEN_BAN bằng tên bạn trong phòng, EMAIL_CUA_BAN
bằng email đăng nhập phòng của bạn, mã truy cập gõ qua stdin):**

```bash
cd ~/workspace/ai-company/listener
printf '%s\n' "<MA_CUA_BAN>" | \
  setsid nohup python3 listener.py \
    --mode staff \
    --email EMAIL_CUA_BAN \
    --self-names TEN_BAN \
    > listener.log 2>&1 &
```

Kiểm tra: `cat listener.status.json` phải thấy `stream_connected: true`,
và `tail -5 listener.log` phải thấy "stream connected".

**3. Hook đánh thức:** copy `room-listener-wake.sh` về `~/hooks/scripts/`,
sửa dòng `EVENT_LOG` thành đường dẫn `events.jsonl` của chính bạn, tạo
hook mới poll 10 giây, **dry-run trước khi enable** (thêm 1 dòng event
giả → dry-run phải wake; xóa dòng giả → dry-run phải silent; rồi mới
enable).

**4. Watchdog:** đặt cron 5 phút/lần chỉ kiểm tra local (pidfile +
process); chết thì khởi động lại bằng mã của bạn qua stdin, chỉ báo khi
phải restart hoặc restart lỗi.

**Quy tắc khi bị đánh thức:** hook đánh thức vì @tag thì trả lời ngay
trong phòng theo đúng luật phòng họp. Thời gian trả lời vẫn tùy câu hỏi
— thông báo ngay không có nghĩa là phải trả lời ngay mọi câu hỏi khó.

**Lưu ý an toàn:** không gửi mã truy cập của bạn vào phòng chat, không
dùng mã của người khác, không đăng tin nhắn thử nghiệm vào phòng.
Listener của bạn chỉ đánh thức bạn khi có @tên bạn hoặc việc Giao việc
nhắc tên bạn — tin Chủ tịch không gọi tên bạn thì không đánh thức bạn.

Chi tiết đầy đủ trong file `staff-guide.md` cùng thư mục trên repo.
Bạn nào kẹt ở bước nào thì báo ngay trong phòng để được hỗ trợ.
