# Worker / API v2 — phần "nói + làm việc" của worker phòng họp Enteesee

> Trạng thái: **XÂY XONG, CHỈ TEST OFFLINE — CHƯA KIỂM CHỨNG LIVE.**
> Mọi hàm trong thư mục này chỉ xây payload / kiểm tra logic / tính
> toán. Không hàm nào gọi mạng tới Google/Firestore, không hàm nào
> đăng nhập, đăng tin, ghi doc thật. Chạy thật sau này là việc của
> tầng gửi riêng (xem "Cách chạy thật sau này") và phải có người kiểm
> chứng live trước khi coi là xong.

## 1. Hai năng lực API — ghi rõ, không để hiểu ngầm

### (1) NHẬN THÔNG BÁO qua API
Worker giữ luồng Listen (do nhóm listener xây `listener_v2.py`, worker
này **không import code của họ**, chỉ nhận event dict theo interface
dưới đây). Sự kiện tag / việc / duyệt tới là worker biết ngay, không
cần mở trình duyệt.

Interface event dict nhận từ listener:

```json
{"event_id": "...", "collection": "messages|tasks|approvals",
 "kind": "Trao đổi|Giao việc|Cập nhật tiến độ|...",
 "sender_id": "...", "sender_name": "...",
 "content": "...", "ts": "ISO-8601", "doc_id": "..."}
```

### (2) CHAT 2 CHIỀU qua API
Worker đăng tin vào phòng bằng **danh tính của chính acc đó**
(`senderId` / `senderName` của chính mình), không cần trình duyệt.
Nghe qua Listen + nói qua API là đủ một vòng chat 2 chiều — worker
không chỉ trả lời theo job, mà còn chủ động chat.

Mẫu POST REST đã kiểm chứng (đọc `../hidden_files/firestore_watch.py`,
không sửa nó): sign-in IdentityToolkit bằng email + mã của chính mình,
rồi POST `documents/messages` với `senderId`/`senderName` = chính mình,
`kind`, `content`, `createdAt`. `chat.py` xây đúng payload dạng đó;
tầng gửi thật phải tự làm sign-in + POST (xem mục 6).

## 2. Hai luồng song song — không luồng nào nuốt luồng nào

Triết lý Chủ tịch chốt 20:02 — công ty **THOẢI MÁI, không hà khắc**:

| Luồng | Tính chất | Đi qua đâu |
|---|---|---|
| **(A) CHAT TỰ DO 2 CHIỀU** | Nhân viên chat với nhau, với điều phối, với Chủ tịch; được chủ động mở chủ đề, không chỉ quanh việc được giao. Chào đón, không bắt buộc. | `chat.py`: `build_chat_payload` + `route_incoming -> "chat"`. **KHÔNG** qua máy trạng thái job. |
| **(B) GIAO VIỆC theo job/event** | Việc thật thì kỷ luật chặt: ack → làm → hoàn thành có bằng chứng, kẹt thì báo blocked/failed có lý do. | `worker.py`: máy trạng thái + idempotency + duyệt. |

Quy tắc tương tác đã có vẫn giữ nguyên:
- **Tag tên là báo ngay.**
- Thời gian trả lời **tùy câu hỏi, KHÔNG ép SLA** — không có deadline
  cứng nào được hard-code vào worker này.
- Chat tự do không bị ép phải acknowledged/completed; ngược lại, một
  tin Giao việc không được xử lý như chat cho qua.

## 3. Ranh giới — ai làm gì

- **Listener đánh thức, worker hành động.** `route_incoming()` chỉ
  định tuyến nội dung đã nhận: `"chat" | "job" | "approval" |
  "system" | "ignore"`. Type của listener quyết trước kind/collection:
  `system_event` → `"system"` (chỉ feed hệ thống, không bao giờ vào
  đường đăng chat); thiếu type thì fallback theo kind/collection cũ.
  Nó không quyết định có đánh thức worker hay không.
- **Tin chat chung phòng không gọi tên worker** vẫn trả về `"chat"`
  (đọc được, nằm trong luồng chat) nhưng **không tự đánh thức**.
  Muốn biết tin có gọi tên mình không, dùng `mentions_self()` riêng —
  hàm đó chỉ để tầng đánh thức tham khảo, không dùng để lọc chat.
- **Tin của chính mình → `"ignore"`**: không tự trả lời tin mình đăng,
  không tự tạo job từ tin mình đăng.
- **Chat không qua máy trạng thái job.** Không ai được bắt một tin
  `"chat"` phải đi `acknowledge → complete`.
- **Backstop chỉ báo cáo.** `backstop.py` không có chế độ ghi/phát
  lại; ai muốn hành động thì đọc report rồi quyết riêng.
- **Validation duyệt không phải enforcement server.** `validate_approval()`
  chỉ chặn trước khi gửi; Firestore Rules mới là nơi chặn cuối cùng.

## 4. File trong thư mục này (chỉ 5 file này là của worker)

| File | Vai trò |
|---|---|
| `chat.py` | `build_chat_payload(own_sender_id, own_sender_name, content)` → payload POST `messages`, kind `"Trao đổi"`, danh tính chính mình, không bao giờ mạo danh (hàm không có tham số sender của người khác). `route_incoming(event, self_names)` → chat/job/approval/ignore. `post_chat(transport, payload)` chỉ gọi transport do caller đưa (test dùng fake). |
| `worker.py` | Máy trạng thái job, idempotency, retry/backoff, `build_task_history_entry`, `build_decision_log_entry`, `validate_approval`, heartbeat. |
| `backstop.py` | `reconcile(...)` → JSON report, dry-run duy nhất. |
| `sender.py` | Tầng gửi thật: sign-in, POST messages/decisions, PATCH heartbeat, append history bằng FieldTransform; phân loại lỗi (429 pause dài, 403 blocked). Stdlib urllib. |
| `test_worker.py` | 40 unit test offline (fake transport, không mạng) — gồm route type-first/system, delivery_id, decision dedup. |
| `test_sender.py` | 8 unit test offline cho sender (fake http, không mạng). |
| `README-worker.md` | File này. |

Lưu ý: `listener_v2.py` cùng thư mục là của **nhóm listener** — worker
này không sửa, không import nó.

## 5. Thiết kế chi tiết

### 5.1 Chat payload (`chat.py`)
- Field Firestore REST: `senderId`, `senderName`, `kind="Trao đổi"`,
  `content`, `createdAt` (timestamp UTC).
- Từ chối tin rỗng, từ chối sender rỗng (không đăng tin không danh tính).
- Payload không chứa mật khẩu/token — hàm không nhận secret nào.
  `payload_to_log_line()` chỉ log sender + kind + độ dài content, không
  log nguyên content, không log secret.
- Fake transport trong test: `post_chat(fake, payload)` trả
  `{"status": 200, "doc": "fake-doc-id"}` và chỉ ghi lại payload.

### 5.2 Máy trạng thái job (`worker.py`) — chỉ cho việc thật
```
pending -> acknowledged -> in_progress -> completed | blocked | failed
acknowledged -> blocked | cancelled
in_progress  -> blocked | failed | cancelled
blocked      -> in_progress (resume) | failed | cancelled
completed / failed / cancelled: trạng thái cuối, không chuyển tiếp.
```
- Không được nhảy cóc: `pending` không `start`/`complete` thẳng được,
  phải `acknowledge` trước.
- **Completed bắt buộc có evidence** (văn bản kết quả / link / doc id
  kiểm tra được). Từ chối: `None`, rỗng, hoặc chỉ nói suông
  (`"done"`, `"ok"`, `"xong"`). Thiếu evidence → `ValueError`, job ở
  nguyên trạng thái cũ — không thành công giả.
- **Blocked/failed bắt buộc có reason + thời gian** (`updated_at` /
  history `at`). Trạng thái lỗi ghi bền trong state dict
  (`JobStore.dump_state()` / `load_state()`), không đánh dấu thành công.
- `build_task_history_entry(job_id, transition, evidence/reason)` và
  `build_decision_log_entry(...)` chỉ xây payload `decisions`/`history`,
  không gửi thật.

### 5.3 Idempotency + retry
- Key mặc định = `(job_id, action)`: `JobStore.apply_action()` gọi lại
  cùng key trả về `(state hiện tại, applied=False)`, không thêm lịch sử.
- **Giới hạn của key mặc định (đọc kỹ):** nó chặn retry trùng của cùng
  một lần gửi, nhưng cũng chặn một hành động thật mới cùng action sau
  đó (vd block → resume → block lại). Vì vậy: retry cùng lần gửi thì
  gọi không `delivery_id`; hành động thật mới thì truyền `delivery_id`
  riêng (vd id của event gây ra nó) hoặc dùng `transition()` trực tiếp.
- Retry giới hạn + backoff có jitter: `should_retry(attempt,
  max_retries=3)`; `retry_delay_seconds(attempt, base=5s, cap=300s,
  jitter=0.5)` — hàm chỉ tính số giây, không tự sleep, để test offline.

### 5.4 Presence heartbeat (`worker.py`)
- `build_heartbeat_payload(own_employee_doc_id, now_iso,
  last_heartbeat_iso)` → payload cập nhật `lastCheckAt` của **chính
  doc nhân viên đó**, hoặc `None` nếu chưa đủ 5 phút từ lần trước
  (tối đa 1 lần / 5 phút / worker, chống ghi dồn).
- **Caller chỉ được gọi ngay sau hoạt động thật**: đã đăng chat, đã ack
  job, đã hoàn thành job. Tuyệt đối không heartbeat theo mỗi event
  stream đi qua. Hàm này là pure throttle — nó không biết worker có
  hoạt động thật hay không, nên kỷ luật này nằm ở caller.
- Về Rules: Rules phải cho phép ghi doc của chính mình thì heartbeat
  mới ghi được. Nếu Rules từ chối, hoạt động thật (tin đã đăng, job đã
  ack) **vẫn là bằng chứng hoạt động** — heartbeat chỉ là tín hiệu
  phụ, không phải bằng chứng duy nhất, và lỗi heartbeat phải được ghi
  lại chứ không được giả vờ thành công. Test plan chạy thật phải kiểm
  tra cả 2 trường hợp (xem mục 7).

### 5.5 Backstop report-only (`backstop.py`)
- `reconcile(window_start, window_end, events, processed_ids,
  now_iso=None, ack_grace_minutes=None)` →:
  ```json
  {"window": {"start", "end"}, "missed": [...ids...],
   "already_processed": [...ids...], "total_in_window": n,
   "duplicates_skipped": n, "dry_run": true}
  ```
- `missed` = trong cửa sổ `[start, end]`, chưa có trong `processed_ids`,
  và chưa quá hạn xác nhận (quá hạn chỉ tính khi caller truyền cả
  `now_iso` + `ack_grace_minutes`; không truyền thì mọi event chưa xử
  lý trong cửa sổ đều là missed).
- Đã xử lý **không bao giờ** thành missed, kể cả khi event lặp lại
  trong đầu vào; ngoài cửa sổ không tính; trùng lặp đầu vào chỉ tăng
  `duplicates_skipped`, không làm sai report.
- Mặc định dry-run và cũng là chế độ duy nhất: **không có tham số
  replay**, không hàm gửi/ghi nào trong file này.

### 5.6 Kỷ luật duyệt (`worker.validate_approval`)
Một quyết định bị từ chối (trả `{"ok": False, "errors": [...]}` rõ ràng)
nếu thiếu bất kỳ mục nào:
1. Không có `reason` bắt buộc.
2. Không có `evidence` kiểm tra được (theo chuẩn evidence ở 5.2).
3. Tự phê duyệt chính mình (`approver_id` trùng `requester_id` /
   `author_id` / `owner_id`, hoặc trùng tên khi không có id).
4. Duyệt tất cả vô điều kiện: `approve_all` / `scope="all"` mà không
   liệt kê items, hoặc duyệt lô mà có mục thiếu id / thiếu kết quả riêng.
5. `verdict` không thuộc `approve / reject / request_changes`.
- Duyệt lô hợp lệ: `items=[{"id": ..., "result": "approve"}, ...]` —
  mỗi mục một kết quả riêng.

## 6. Cách chạy thật sau này (chưa làm, chỉ để người triển khai theo)

1. Tạo venv, cài không thêm dependency ngoài stdlib (code hiện tại
   chỉ dùng stdlib — giữ nguyên, đừng thêm requests nếu không cần).
2. Tầng gửi thật (`sender.py`, đã có — xem `test_sender.py`) làm theo mẫu
   `firestore_watch.py`: đọc mã qua **stdin** (không argv, không log,
   không ghi file), sign-in IdentityToolkit bằng email + mã của chính
   acc worker đó, rồi POST payload từ `build_chat_payload` /
   `build_task_history_entry` / `build_decision_log_entry`, PATCH
   heartbeat vào `employees/{own_employee_doc_id}`.
3. Worker thật phải: nhận event từ listener → `route_incoming` →
   chat thì `build_chat_payload`, job thì đi máy trạng thái
   (`JobStore`), duyệt thì `validate_approval` trước khi gửi, heartbeat
   chỉ sau hoạt động thật.
4. Chạy test offline trước mỗi lần đổi code:
   ```
   cd ~/workspace/ai-company/listener-v2 && python3 test_worker.py
   ```

## 7. Giới hạn còn lại + việc cần người khác kiểm chứng live

**Chưa kiểm chứng live (nói rõ, không nhận vơ):**
1. POST messages thật bằng payload này có được Firestore chấp nhận
   không (đúng Rules / đúng field / đúng định dạng timestamp).
2. PATCH `lastCheckAt` vào doc của chính mình có được Rules cho phép
   không — và trường hợp Rules từ chối thì lỗi trả về ra sao (test
   plan phải kiểm tra cả 2 trường hợp, xem 5.4).
3. Event dict thật từ `listener_v2.py` có đúng 100% interface ở mục 1
   không (tên key, kind, collection) — hai nhóm cần đối chiếu một lần
   trước khi nối.
4. Sign-in + POST thật có dính 429 / quota Spark không (đường REST đã
   từng 429 chập chờn ngày 24/10) — worker thật cần backoff như 5.3 và
   không được retry vô hạn.
5. Hành vi "tag → báo ngay" đầu cuối (từ lúc người khác tag tới lúc
   worker nhận qua Listen) chưa đo được offline.

**Giới hạn thiết kế (cố ý, không phải thiếu sót quên ghi):**
- Không có enforcement phía server trong code này — Rules + server
  mới chặn cuối cùng; `validate_approval` chỉ là kiểm tra trước gửi.
- Không có replay/backfill trong backstop — cố ý, để tránh phát lại
  tin cũ gây nhiễu phòng.
- Không tự động heartbeat theo stream — cố ý, để tránh ghi dồn và
  tránh "presence giả" khi worker thực ra không làm gì.
- Không lưu mật khẩu/token/secret trong bất kỳ file nào ở đây; test
  chỉ dùng chuỗi giả để assert "không xuất hiện".

## 8. Ranh giới cứng đã tuân thủ khi xây bản này
Không gọi mạng tới Google/Firestore; không mã/mật khẩu/token trong
file/log; không đăng phòng live; không sửa file live
(`firestore_watch.py` chỉ đọc, `listener_v2.py` không đụng);
không đặt cron/hook; không mua/nâng cấp gì.
