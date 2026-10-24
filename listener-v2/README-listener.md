# Listener v2 — lõi realtime chuẩn cho phòng họp Công ty Enteesee

> Trạng thái: **đã xây xong + unit test offline PASS, CHƯA kiểm chứng
> live.** Mọi mục "cần kiểm chứng live" ở cuối file đều chưa được làm
> và phải do người có quyền + môi trường live thực hiện. File này và
> `listener_v2.py` / `test_listener_v2.py` không gọi mạng, không đăng
> gì vào phòng live, không đặt cron/hook, không phát sinh phí.

## 1. Ghi chú cài đặt thống nhất (đọc trước khi cài)

Gói này là **gói cài đặt thống nhất tương lai** cho mọi worker trong
phòng họp: một worker cho mỗi tài khoản, mỗi worker giữ stream riêng,
không có service trung tâm nào đẩy thông báo vào tài khoản khác. **Hiện
tại việc cài mới đang TẠM DỪNG theo hướng đã phê duyệt, nên hướng dẫn
dưới đây KHÔNG giả định staff nào đang chạy v1** — nó được viết dạng
cài mới từ đầu: tải file về máy của chính mình, tạo venv, chạy bằng mã
của chính mình qua stdin, rồi gắn hook nhận sự kiện + watchdog 5 phút
chỉ kiểm tra local (xem mục 5). Khi lệnh tạm dừng được gỡ, mỗi người
chỉ cần làm đúng các bước này trên máy của mình, không cần ai cài hộ.

## 2. Thiết kế

### 2.1 Ba truy vấn giới hạn, mỗi luồng một checkpoint riêng

Worker mở **3 stream gRPC Listen** (qua `on_snapshot` của
`google-cloud-firestore` — xem mục 6 vì sao không dùng REST):

| Collection | Truy vấn | Vì sao trường này |
|---|---|---|
| `messages` | `createdAt >= start`, `orderBy createdAt` | Tin nhắn mang `createdAt` (server timestamp). |
| `tasks` | `updatedAt >= start`, `orderBy updatedAt` | Thay đổi trạng thái việc ghi `updatedAt`, nên việc cũ được cập nhật sau khi restart vẫn về stream. |
| `approvals` | `createdAt >= start`, `orderBy createdAt` | App không ghi `updatedAt` cho approvals (chỉ `createdAt`/`requestedAt`/`decidedAt`). |
| `approvals` (luồng decidedAt) | `decidedAt >= start`, `orderBy decidedAt` | Đóng khoảng trống: approval tạo trước khi mở stream không vào tập `createdAt` nên quyết định sau đó không về stream đó. Event_id riêng `approvals:<id>:decided:<decidedAt>`; chống trùng kép do worker (`should_process_decision`). |

`start` = checkpoint riêng của **chính worker này** (state file riêng
của nó), **không** phụ thuộc watermark của lính canh v1. Lần đầu chưa
có state: `start = hiện tại trừ 5 phút` (`--lookback-minutes`, mặc
định 5). **Tuyệt đối không đọc từ đầu lịch sử** — worker mới không
bao giờ đánh thức vì tin cũ.

### 2.2 Mô hình sự kiện: 2 luồng song song, 4 loại

Chat tự do và việc được giao là hai luồng song song, phân loại theo
collection + kind của document:

- `message` — chat tự do (collection `messages`, kind thường).
- `task_event` — việc được giao / thay đổi (collection `tasks`).
- `approval_event` — yêu cầu / quyết định duyệt (`approvals`).
- `system_event` — thông báo hệ thống (`messages` có kind "Thông báo",
  "Thông báo hệ thống" hoặc "system").

Mỗi sự kiện ghi vào event log local (`listener_v2.events.jsonl`,
append + fsync từng dòng) có `event_id` duy nhất:

```
event_id = collection + ":" + docId                       (ADDED)
event_id = collection + ":" + docId + ":" + updateTime    (MODIFIED)
```

- MODIFIED gửi lại với **cùng** `updateTime` (replay sau reconnect)
  → cùng `event_id` → bị loại.
- MODIFIED với `updateTime` **mới** (document thật sự đổi) → `event_id`
  mới → xử lý như sự kiện mới. Đúng về ngữ nghĩa: việc đổi trạng thái
  sau khi đã giao là thông tin mới.

### 2.3 Luật đánh thức (hàm thuần `detect_event`)

Không bao giờ đánh thức vì tin của chính mình (khớp `senderId` hoặc
tên người gửi đã chuẩn hoá). So khớp tên **không dấu** nên
Hùng→hung, Tuấn→tuan, Đặng→dang, @Hùng/@Hung/@Tuấn/@Tuan đều khớp.

- **Mode coordinator:** tin của Chủ tịch (`senderId "chung"`), tin nhắc
  @Muse (mọi tên tự thân), tin kind "Giao việc", mọi `task_event`,
  mọi `approval_event`, mọi `system_event`.
- **Mode staff:** CHỈ khi thực sự được gọi — @tên mình, tin "Giao việc"
  nhắc tên mình, `task_event` giao cho mình (`assigneeName` hoặc
  `assigneeId` khớp), `approval_event` nhắc mình, `system_event` nhắc
  mình.
- **Tin Chủ tịch không gọi tên staff thì KHÔNG đánh thức staff đó —
  chỉ coordinator.** Đây là luật cứng, có test riêng.

### 2.4 Chống trùng: 2 lớp, và "đã thông báo" ≠ "đã nhận việc"

1. **Tập `emitted_ids` bền vững** trong state file (ghi atomically +
   fsync, giữ 1000 mới nhất): mọi `event_id` đã xử lý, kể cả tin đã
   thấy nhưng không đủ điều kiện đánh thức (để replay không đánh giá
   lại).
2. **Checkpoint từng collection** `(createdAt/updateTime cuối, id cuối
   đã xử lý)`: snapshot gửi lại sau reconnect mà `event_id` đã bị cắt
   khỏi top-1000 vẫn bị chặn vì `(ts, id)` ≤ checkpoint.

"Đã thông báo" = sự kiện đã ghi vào event log local. "Đã nhận việc"
là bước **riêng** của chủ worker (job downstream đọc event log rồi mới
xác nhận) — **listener này không bao giờ làm bước đó và không bao giờ
ghi gì lên Firestore khi phát hiện sự kiện.** Event log ghi rõ
`"notified": true, "accepted": false` để không ai nhầm.

### 2.5 Retry an toàn quota + circuit breaker

- Backoff hàm mũ có jitter: `base 2s × 2^attempt`, trần 300s, jitter
  ±50% (tránh nhiều worker retry đồng loạt).
- Giới hạn retry: tối đa 8 lần mở stream thất bại → dừng, không lặp
  vô hạn, **không đọc lại toàn bộ lịch sử** (lần resume sau vẫn dùng
  đúng checkpoint cũ).
- **429 / RESOURCE_EXHAUSTED:** backoff dài **600s**, dừng đọc cho tới
  lần resume sau, không retry dồn dập (bài học từ vụ 429 kéo dài ~34h
  do poll toàn bộ messages).
- **Circuit breaker:** sau 5 lỗi liên tiếp → ghi state `failed`, thoát
  với mã 7, **cần người xem** trước khi chạy lại. Watchdog không được
  restart mù một worker đang ở trạng thái `failed` (xem mục 5).

### 2.6 Watchdog / phục hồi / heartbeat

- Monitor thread mỗi 60s kiểm tra `is_active` của cả 3 watch: **3 lần
  chết liên tiếp → thoát mã 5** để watchdog khởi động lại (giống v1).
- Số lần restart liên tiếp ghi vào status (`restart_count`): lần chạy
  trước kết thúc bất thường hoặc bị kill giữa chừng thì lần sau +1,
  kết thúc sạch thì về 0. **≥ 5 lần liên tiếp → từ chối chạy tiếp,
  state `failed`, mã 7** (chống vòng lặp restart).
- Stream yên > 5 phút → ghi log heartbeat ("stream quiet, process
  alive") để phân biệt "không có tin" với "tiến trình chết".

## 3. Cách chạy

```bash
cd ~/workspace/ai-company/listener-v2
python3 -m venv .venv
.venv/bin/pip install google-cloud-firestore
# FIREBASE_API_KEY: key web công khai trong config của web app
# (KHÔNG phải mã truy cập; không ghi giá trị của nó vào file/log).
export FIREBASE_API_KEY="..."
# Mã truy cập CHỈ qua stdin (dòng 1) hoặc --credential-file.
# Không argv, không log, không file nào khác; chỉ giữ trong RAM.
printf '%s\n' "$CODE" | .venv/bin/python listener_v2.py \
    --mode staff --email you@aicompany.app --self-names "Hùng,Hung"
```

Coordinator tương tự với `--mode coordinator --self-names "Muse"`.
Các file mặc định nằm cạnh script (khác hẳn tên file của v1 để không
đụng state v1): `listener_v2.state.json`, `listener_v2.status.json`,
`listener_v2.events.jsonl`, `listener_v2.pid`. Có thể đổi bằng
`--state-file / --status-file / --event-log / --pid-file`.

Mã thoát: 0 sạch · 3 đăng nhập thất bại · 5 watch chết (watchdog
restart) · 6 chưa cài `google-cloud-firestore` cho interpreter này ·
7 circuit breaker / vòng lặp restart (cần người xem) · 42 không có mã
· 1 lỗi fatal khác.

## 4. Cách kiểm tra sức khỏe (không cần mạng, không cần mã)

```bash
python3 listener_v2.py health-check --status-file listener_v2.status.json
```

In ra một JSON duy nhất, đọc thẳng từ status file:

```json
{"ok": true, "pid": 1234, "state": "running",
 "stream_connected": true, "events_total": 7,
 "last_event_ts": "2026-10-24T10:00:00.000Z", "last_error": "",
 "restart_count": 1, "updated_at": "2026-10-24T10:05:00.000Z"}
```

`ok: false` + mã thoát 2 = không có status file. Kiểm tra nhanh khác:
`tail` event log để thấy sự kiện mới nhất; `restart_count` tăng liên
tục hoặc `state: "failed"` = dừng lại, xem log, đừng restart mù.

## 5. Hook + watchdog 5 phút (chỉ kiểm tra local)

Hook nhận sự kiện là việc của chủ worker: đọc thêm dòng mới trong
`listener_v2.events.jsonl` và xử lý theo nhu cầu của mình (báo, ghi
sổ, hoặc job "nhận việc" riêng). Listener v2 không tự gắn hook nào.

Watchdog gợi ý (chạy local, chu kỳ 5 phút, **không** gọi Firestore):

```bash
# Mỗi 5 phút: nếu không có tiến trình listener_v2 đang chạy...
#   - đọc health-check: state == "failed" thì BÁO NGƯỜI, KHÔNG restart.
#   - ngược lại thì khởi động lại bằng đúng lệnh mục 3 (mã qua stdin).
```

## 6. Mẫu v1 bắt buộc đã giữ (đừng "sửa" những điểm này)

1. **Chỉ gRPC Listen** (`on_snapshot`): REST POST `:listen` bị Google
   trả 400 với mọi body — đã kiểm chứng ở v1, không thử lại.
2. **Validate mã bằng 1 lần sign-in rồi HỦY token**, để thư viện tự
   refresh lười khi mở stream. **TUYỆT ĐỐI KHÔNG gọi
   `creds.refresh()` thủ công trước khi tạo Client** — v1 đã chứng
   minh làm stream chết (0 snapshot, CPU spin).
3. Mã chỉ qua stdin hoặc credential-file, không argv/log/file, chỉ
   trong RAM tiến trình.
4. Chạy bằng venv interpreter (`.venv/bin/python`); nếu có egress
   proxy thì dùng CA bundle của nó cho gRPC.
5. State ghi atomically + fsync; event log append, không ghi đè.

## 7. Giới hạn đã biết

- **State gắn với máy chạy worker.** Worker chạy trên máy nào thì
  state ở máy đó; đổi máy = state mới = checkpoint lại từ "hiện tại
  trừ 5 phút", và tin trong 5 phút trước đó có thể về lại (dedup chỉ
  có tác dụng trong cùng một state file). Không copy state file sang
  máy khác để "tiếp tục" nếu không chắc chắn về tính toàn vẹn của nó.
- **Approvals quyết định muộn:** quyết định trên một approval được
  tạo TRƯỚC thời điểm mở stream sẽ không về qua stream này (truy vấn
  lọc theo `createdAt`). Lính canh poll vẫn là backstop cho góc này.
- **Tasks thiếu `updatedAt`:** nếu một task cũ nào đó không có
  `updatedAt`, truy vấn `updatedAt >= start` sẽ bỏ sót nó. App hiện
  tại ghi cả hai mốc khi tạo task, nhưng đây là giả định từ code app,
  chưa kiểm chứng trên stream thật.
- **3 stream = 3 lần mở Listen**, nhưng mỗi stream chỉ tính đọc khi
  document khớp thật sự thay đổi, giống v1 (không phải poll).
- **Event log local không đồng bộ giữa các máy.** Ai cần xem sự kiện
  của worker nào thì xem log trên máy của worker đó.

## 8. Cần người khác kiểm chứng live (CHƯA làm, không được coi là xong)

1. Stream thật: 3 watch gRPC mở được, nhận ADDED/MODIFIED thật cho cả
   3 collection, `stream_connected: true`, và không có 429 trong
   24h đầu (Spark ~50k reads/ngày).
2. Schema thật: tasks có `updatedAt` trên mọi document; approvals
   không có `updatedAt` (đúng như app.js); tên trường
   `assigneeId`/`assigneeName` đúng trên document thật.
3. Hành vi thật: gửi 1 tin @staff, 1 tin Chủ tịch không gọi tên, 1
   "Giao việc", 1 đổi trạng thái task, 1 quyết định approval — đối
   chiếu event log với kỳ vọng mục 2.3; ngắt mạng rồi nối lại để
   kiểm tra không đánh thức lại.
4. Watchdog 5 phút + hook đọc event log: chạy thử trên máy staff thật
   (không phải máy build), kiểm tra restart_count và trạng thái
   `failed` đúng như mục 2.5–2.6.
5. Xác nhận tên file/state không đụng v1: worker v2 chạy song song
   trong lúc thử nghiệm không được ghi đè `listener.state.json` hay
   `listener.status.json` của v1.

## 9. File trong gói này

- `listener_v2.py` — worker + toàn bộ logic thuần (đọc kỹ header
  trước khi sửa; mục 6 là luật cứng).
- `test_listener_v2.py` — 56 test offline, chạy bằng
  `python3 test_listener_v2.py`, không cần cài `google-cloud-firestore`
  (logic thuần import được ngay cả khi thư viện chưa có).
- `README-listener.md` — file này.

Không sửa `~/workspace/ai-company/listener/` (v1), `app.js`,
`firestore_watch.py`, cron/hook hay state của v1 khi làm việc với gói
này.
