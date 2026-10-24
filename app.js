/* Công ty Enteesee — logic ứng dụng (Firebase Auth + Firestore, bản compat)
   Đính kèm tệp: lưu trong Firestore collection `files` dạng mảnh base64 (không dùng Storage). */
(function () {
  "use strict";

  var DIRECTOR_EMAIL = window.DIRECTOR_EMAIL || "";
  var cfg = window.FIREBASE_CONFIG || {};
  var CONFIGURED = !!cfg.apiKey && cfg.apiKey !== "CHUA_CO";

  var TASK_STATUSES = ["Chờ nhận", "Đã nhận", "Đang làm", "Chờ duyệt", "Hoàn thành"];
  var MSG_KINDS = ["Trao đổi", "Giao việc", "Thông báo", "Cập nhật tiến độ", "Báo cáo kết quả"];
  var LEVELS = ["Giám đốc", "Phó giám đốc", "Trưởng phòng", "Trợ lý", "Nhân viên"];
  var PALETTE = ["#4f46e5", "#7c3aed", "#0ea5e9", "#059669", "#d97706", "#db2777", "#0891b2", "#65a30d", "#9333ea", "#ea580c"];
  var MAX_FILE_SIZE = 5 * 1024 * 1024;   // 5MB mỗi tệp
  var CHUNK_CHARS = 700 * 1024;          // ~700KB base64 mỗi mảnh

  var state = {
    user: null,
    me: null,              // {id, name, title, level, role, realDoc}
    employees: [],
    messages: [],
    tasks: [],
    activities: [],
    decisions: [],        // nhật ký quyết định đã tải (phase 1: chỉ tải khi bấm nút, không nghe trực tiếp để tiết kiệm lượt đọc Firestore)
    decisionsLoaded: false,
    decisionsLoading: false,
    checkIntervalMinutes: 10,
    ackTimeoutHours: 24,      // phase 2: ngưỡng quá hạn xác nhận nhận việc (giờ), lấy từ settings/room
    approvalsHistory: [],     // phase 2: hồ sơ duyệt đã quyết đã tải (collection approvals)
    approvalsHistoryLoaded: false,
    approvalsHistoryLoading: false,
    checkinTimer: null,
    lastCheckinAt: 0,      // mốc check-in thành công gần nhất của chính mình (lạc quan, tại máy này)
    lastCheckinTry: 0,     // mốc lần thử check-in gần nhất (chống ghi dồn khi focus/visible)
    presenceBound: false,  // đã gắn sự kiện focus/visibilitychange cho check-in chưa
    boardIdx: 0,           // cột đang xem trên bảng việc (mobile, vuốt ngang)
    clockTimer: null,
    currentTab: "overview",
    collapsedOrg: {},
    collapsedTv: {},
    taskFilter: "all",
    pendingFiles: [],      // File objects đang chọn trong ô soạn tin
    sending: false,
    fileCache: {},         // fileId -> Promise<{b64, type, name}>
    profileId: null,
    taskModalId: null,
    mentionUI: null,       // {start, items, active} của hộp gợi ý @tag trong ô soạn tin
    highlightMsgId: null,  // id tin đang được làm nổi bật sau khi bấm từ chuông thông báo
    highlightTimer: null,
    security: null,        // dữ liệu doc settings/security (chỉ nạp cho tài khoản Giám đốc)
    presence: {},        // Phase 4: presence/<employeeId> do set_work ghi
    handledMap: {},      // Phase 4: id tin đã xử lý (chỉ lưu ở máy này)
    messagesLoadedOnce: false,
    notifiedIds: {},
    chatChannel: "all",
    chatThread: "",
    chatKind: "",
    chatNeedsOnly: false,
    chatUrgentOnly: false,
    chatUnhandledOnly: false,
    kanbanCol: "all",
    taskView: "board",
    taskAssigneeFilter: "",
    taskPrioFilter: "",
    taskRoleFilter: "",
    lastStreamError: null,
    rulesVersion: "",
    unsub: []
  };

  var auth = null, db = null;
  var serverTimestamp = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function fmtTime(ts) {
    var ms = tsMillis(ts);
    if (!ms) return "";
    var d = new Date(ms);
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear() +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtDate(ts) {
    var ms = tsMillis(ts);
    if (!ms) return "";
    var d = new Date(ms);
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
  }
  function fmtClock(ts) {
    var ms = tsMillis(ts);
    if (!ms && typeof ts === "number") ms = ts;
    if (!ms) return "";
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtRel(ts) {
    var ms = tsMillis(ts);
    if (!ms) return "";
    var diff = Date.now() - ms;
    if (diff < 60 * 1000) return "vừa xong";
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " phút";
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + " giờ";
    return Math.floor(diff / 86400000) + " ngày";
  }
  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(".", ",") + " KB";
    return (n / (1024 * 1024)).toFixed(2).replace(".", ",") + " MB";
  }
  function tsMillis(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    if (ts instanceof Date) return ts.getTime();
    return null;
  }
  function initial(name) {
    var s = String(name || "?").trim();
    return s ? s.charAt(0).toUpperCase() : "?";
  }
  /* Màu avatar pastel theo màu định danh của nhân viên (phong cách Mẫu C):
     nền pastel nhạt + chữ đậm cùng tông, ổn định theo mã màu đã lưu. */
  var PASTEL_PAIRS = {
    "#4f46e5": ["#E0E7FF", "#3538CD"],
    "#7c3aed": ["#E9D7FE", "#6941C6"],
    "#0ea5e9": ["#D1E9FF", "#175CD3"],
    "#059669": ["#D1FADF", "#027A48"],
    "#d97706": ["#FFEAD5", "#7A2E0E"],
    "#db2777": ["#FEE4E2", "#912018"],
    "#0891b2": ["#D3F2FB", "#155E75"],
    "#65a30d": ["#E6F4D7", "#3F6212"],
    "#9333ea": ["#E9D7FE", "#6941C6"],
    "#ea580c": ["#FFEAD5", "#9A3412"]
  };
  function pastelFor(color) {
    var c = String(color || "").toLowerCase();
    if (PASTEL_PAIRS[c]) return PASTEL_PAIRS[c];
    var m = /^#?([0-9a-f]{6})$/.exec(c);
    if (!m) return ["#E4E7EC", "#344054"];
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    function mix(v, t, f) { return Math.round(v + (t - v) * f); }
    function hx(v) { return ("0" + v.toString(16)).slice(-2); }
    return ["#" + hx(mix(r, 255, 0.84)) + hx(mix(g, 255, 0.84)) + hx(mix(b, 255, 0.84)),
            "#" + hx(mix(r, 0, 0.28)) + hx(mix(g, 0, 0.28)) + hx(mix(b, 0, 0.28))];
  }
  function avatarHtml(e, sizeCls) {
    /* Phase 4 — hiển thị avatar có sẵn (employees/{id}.avatar = {color, hair, img}).
       CHỈ HIỂN THỊ: không có chức năng sửa avatar, không đụng Rules. Ảnh chỉ nhận
       data URL ảnh (png/jpeg/gif/webp) để tránh chèn nội dung lạ qua trường img. */
    var color = (e && e.avatar && typeof e.avatar.color === "string" && e.avatar.color.charAt(0) === "#")
      ? e.avatar.color : ((e && e.color) || "#4f46e5");
    var name = e ? (e.name || "") : "?";
    var pair = pastelFor(color);
    var img = e && e.avatar && isValidAvatarImg(e.avatar.img) ? e.avatar.img : null;
    if (img) {
      return '<span class="avatar ' + (sizeCls || "") + '"><img src="' + img + '" alt="' + esc(name) + '"></span>';
    }
    return '<span class="avatar ' + (sizeCls || "") + '" style="background:' + pair[0] + ";color:" + pair[1] + '">' + esc(initial(name)) + '</span>';
  }

  /* ---------- Nhân viên: tra cứu + trạng thái kiểm tra ---------- */
  function empById(id) {
    for (var i = 0; i < state.employees.length; i++) {
      if (state.employees[i].id === id) return state.employees[i];
    }
    return null;
  }
  function empName(id) {
    var e = empById(id);
    if (e) return e.name || "";
    if (state.me && state.me.id === id) return state.me.name;
    if (id === "director") return "Chung";
    return "(chưa rõ)";
  }
  function orgMaps() {
    var byId = {};
    state.employees.forEach(function (e) { byId[e.id] = e; });
    var children = {}, roots = [];
    state.employees.forEach(function (e) {
      var m = e.managerId;
      if (m && byId[m] && m !== e.id) {
        if (!children[m]) children[m] = [];
        children[m].push(e);
      } else {
        roots.push(e);
      }
    });
    return { byId: byId, children: children, roots: roots };
  }

  /* Mốc hoạt động gần nhất của một nhân viên — suy từ MỌI dấu vết ứng dụng đã tải:
     - lastCheckAt: lần điểm danh khi chính người đó mở giao diện web;
     - tin nhắn gần nhất người đó gửi trong phòng họp (messages: senderId + createdAt);
     - bình luận gần nhất của người đó trong công việc (tasks[].comments: authorId + createdAt);
     - hoạt động gần nhất trong nhật ký (activities: actorId + createdAt — chỉ nạp 12 mục mới nhất).
     Nhân viên AI làm việc qua kênh riêng (gửi tin thẳng vào hệ thống, không mở giao
     diện web) nên lastCheckAt thường trống; chỉ mốc MỚI NHẤT trong các dấu vết
     trên mới phản ánh đúng hoạt động thật. Trả về {ms, ts} của dấu vết mới nhất,
     hoặc null khi thật sự không có bất kỳ dấu vết nào. */
  function lastActivityOf(e) {
    if (!e) return null;
    var bestMs = null, bestTs = null;
    function consider(ts) {
      var ms = tsMillis(ts);
      if (ms !== null && (bestMs === null || ms > bestMs)) { bestMs = ms; bestTs = ts; }
    }
    consider(e.lastCheckAt);
    state.messages.forEach(function (m) { if (m.senderId === e.id) consider(m.createdAt); });
    state.tasks.forEach(function (t) {
      (t.comments || []).forEach(function (c) { if (c.authorId === e.id) consider(c.createdAt); });
    });
    state.activities.forEach(function (a) { if (a.actorId === e.id) consider(a.createdAt); });
    return bestMs === null ? null : { ms: bestMs, ts: bestTs };
  }

  /* Trạng thái kiểm tra phòng họp: luật áp dụng cho TẤT CẢ nhân viên, tính trên
     mốc hoạt động suy ra (lastActivityOf) thay vì chỉ lastCheckAt.
     - provisioning "pending": Chờ mở trình duyệt
     - không có bất kỳ dấu vết hoạt động nào: Chưa từng vào phòng họp
     - quá chu kỳ: Quá hạn kiểm tra. Đúng chu kỳ: Kiểm tra đúng hạn */
  function checkInfo(e) {
    if (e.provisioning === "pending") {
      return { kind: "wait", text: "Chờ mở trình duyệt", cls: "chip check-wait" };
    }
    var iv = state.checkIntervalMinutes || 10;
    var act = lastActivityOf(e);
    if (!act) {
      return { kind: "never", text: "Chưa từng vào phòng họp", cls: "chip check-wait" };
    }
    if ((Date.now() - act.ms) > iv * 60000) {
      return { kind: "late", text: "Quá hạn kiểm tra", cls: "chip check-late" };
    }
    return { kind: "ok", text: "Kiểm tra đúng hạn", cls: "chip check-ok" };
  }
  function checkChipHtml(e) {
    if (e.suspended) return "";
    var ci = checkInfo(e);
    return '<span class="' + ci.cls + '">' + ci.text + '</span>';
  }

  /* Hiện diện: MỘT hàm suy trạng thái duy nhất, dùng ở mọi nơi
     (header, dải hiện diện, thẻ nhân viên, cây tổ chức, hồ sơ chi tiết).
     Mốc hoạt động lấy từ lastActivityOf — mốc MỚI NHẤT trong: điểm danh web
     (lastCheckAt), tin nhắn phòng họp, bình luận công việc, nhật ký hoạt động —
     vì nhân viên AI hoạt động qua kênh riêng nên không có mốc điểm danh web.
     Trực tuyến nếu hoạt động trong vòng max(2 × chu kỳ kiểm tra, 6 phút);
     chỉ báo "Chưa từng vào phòng họp" khi không có bất kỳ dấu vết nào. */
  function presenceOf(e) {
    var iv = state.checkIntervalMinutes || 10;
    if (e.suspended) {
      return { state: "suspended", online: false, dot: "dot off", label: "Tạm ngưng", sub: "" };
    }
    if (e.provisioning === "pending") {
      return { state: "pending", online: false, dot: "dot off", label: "Chờ mở trình duyệt", sub: "Chưa kích hoạt tài khoản" };
    }
    var act = lastActivityOf(e);
    if (!act) {
      return { state: "never", online: false, dot: "dot off", label: "Chưa từng vào phòng họp", sub: "" };
    }
    var age = Date.now() - act.ms;
    if (age <= Math.max(2 * iv, 6) * 60000) {
      return { state: "online", online: true, dot: "dot on", label: "Đang trực tuyến", sub: "Kiểm tra lúc " + fmtClock(act.ts) };
    }
    return { state: "recent", online: false, dot: "dot late", label: "Hoạt động " + fmtRel(act.ts) + " trước", sub: fmtTime(act.ts) };
  }
  function statusDot(e) {
    return presenceOf(e).dot;
  }

  function isDirector() { return !!state.me && state.me.level === "Giám đốc"; }
  function canManage() {
    return !!state.me && (state.me.level === "Giám đốc" || state.me.level === "Phó giám đốc");
  }

  /* ---------- Chưa đọc (badge Phòng họp) ---------- */
  function lastReadKey() { return "cty_lastReadAt_" + (state.user ? state.user.uid : "anon"); }
  function getLastReadAt() {
    try { return parseInt(localStorage.getItem(lastReadKey()) || "0", 10) || 0; }
    catch (e) { return 0; }
  }
  function setLastReadAt(ms) {
    try { localStorage.setItem(lastReadKey(), String(ms)); } catch (e) {}
  }
  function unreadCount() {
    if (!state.me) return 0;
    var last = getLastReadAt();
    var count = 0;
    state.messages.forEach(function (m) {
      var t = tsMillis(m.createdAt);
      if (t === null) t = Date.now();
      if (t > last && m.senderId !== state.me.id) count++;
    });
    return state.currentTab === "room" ? 0 : count;
  }
  function refreshUnreadBadge() {
    var badge = $("unreadBadge");
    if (!badge) return;
    var count = unreadCount();
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  /* Tin CHƯA ĐỌC có nhắc tên CHÍNH MÌNH: tập con của tin chưa đọc (cùng mốc đã đọc
     với unreadCount, loại tin của chính mình) — hiển thị riêng trong chuông nhưng
     KHÔNG cộng thêm vào tổng, tránh đếm trùng một tin hai lần. */
  function mentionUnreadMessages() {
    if (!state.me || state.currentTab === "room") return [];
    var last = getLastReadAt();
    return state.messages.filter(function (m) {
      if (m.senderId === state.me.id) return false;
      if (!m.mentions || m.mentions.indexOf(state.me.id) < 0) return false;
      var t = tsMillis(m.createdAt);
      if (t === null) t = Date.now();
      return t > last;
    });
  }
  function markRoomRead() {
    var max = getLastReadAt();
    state.messages.forEach(function (m) {
      var t = tsMillis(m.createdAt);
      if (t !== null && t > max) max = t;
    });
    setLastReadAt(Math.max(max, Date.now() - 1));
    refreshUnreadBadge();
    renderBell();
  }

  /* ---------- Nhật ký hoạt động ---------- */
  function logActivity(text, kind) {
    if (!db || !state.me) return;
    db.collection("activities").add({
      actorId: state.me.id,
      actorName: state.me.name,
      text: text,
      kind: kind || "chung",
      createdAt: serverTimestamp()
    }).catch(function (e) { console.warn("log activity:", e); });
  }

  /* ---------- Nhật ký quyết định (phase 1, append-only) ----------
     Collection riêng "decisions": mỗi quyết định duyệt / trả lại / hoàn thành /
     trình duyệt ghi 1 bản ghi kèm lý do + bằng chứng + mức xác minh + thời gian.
     Ghi fire-and-forget SAU khi đổi trạng thái việc thành công — nếu ghi log
     thất bại (vd Rules chưa mở collection này) thì việc vẫn đổi trạng thái
     bình thường, chỉ báo console. Mức xác minh phân biệt rõ:
     "agent báo cáo" (người làm tự nói đã xong, chưa ai xác nhận) với
     "đã xác nhận" (người khác — người duyệt hoặc quản lý — xác nhận). */
  function logDecision(action, t, reason, evidence, verification, verifiedBy, approvalId) {
    if (!db || !state.me || !t) return;
    db.collection("decisions").add({
      actorId: state.me.id,
      actorName: state.me.name,
      action: action,
      targetType: "task",
      targetId: t.id,
      targetTitle: t.title || "",
      assigneeId: t.assigneeId || "",
      assigneeName: empName(t.assigneeId),
      reason: reason || "",
      evidence: evidence || "",
      verification: verification || "",
      verifiedBy: verifiedBy || "",
      approvalId: approvalId || "",
      createdAt: serverTimestamp()
    }).catch(function (e) { console.warn("log decision:", e); });
  }

  /* ---------- Hồ sơ phê duyệt (phase 1 bổ sung) ----------
     Phê duyệt là thực thể riêng (collection "approvals"), không chỉ là trạng
     thái của việc: ghi người trình, thời điểm trình, người duyệt, thời điểm
     duyệt, kết quả từng mục. Việc chuyển sang "Chờ duyệt" tạo 1 hồ sơ pending;
     quyết định xong cập nhật hồ sơ đó. Việc cũ (đã "Chờ duyệt" từ trước khi
     có collection này) thì tạo bù hồ sơ khi quyết định, kèm cờ backfilled. */
  function createApprovalRequest(t) {
    if (!db || !state.me) return Promise.resolve("");
    return db.collection("approvals").add({
      taskId: t.id,
      taskTitle: t.title || "",
      assigneeId: t.assigneeId || "",
      assigneeName: empName(t.assigneeId),
      requesterId: state.me.id,
      requesterName: state.me.name,
      requestedAt: serverTimestamp(),
      status: "pending",
      decidedBy: "",
      decidedByName: "",
      decidedAt: null,
      decision: "",
      reason: "",
      evidence: "",
      batchId: "",
      backfilled: false
    }).then(function (ref) {
      db.collection("tasks").doc(t.id).update({ pendingApprovalId: ref.id }).catch(function (e) { console.warn("link approval:", e); });
      return ref.id;
    }).catch(function (e) { console.warn("create approval:", e); return ""; });
  }
  function ensureApprovalDoc(t) {
    if (t.pendingApprovalId) return Promise.resolve(t.pendingApprovalId);
    if (!db || !state.me) return Promise.resolve("");
    return db.collection("approvals").add({
      taskId: t.id,
      taskTitle: t.title || "",
      assigneeId: t.assigneeId || "",
      assigneeName: empName(t.assigneeId),
      requesterId: "",
      requesterName: "",
      requestedAt: null,
      status: "pending",
      decidedBy: "",
      decidedByName: "",
      decidedAt: null,
      decision: "",
      reason: "",
      evidence: "",
      batchId: "",
      backfilled: true
    }).then(function (ref) {
      db.collection("tasks").doc(t.id).update({ pendingApprovalId: ref.id }).catch(function () {});
      return ref.id;
    }).catch(function (e) { console.warn("backfill approval:", e); return ""; });
  }
  function finalizeApproval(approvalId, decision, reason, evidence, batchId) {
    if (!approvalId || !db || !state.me) return Promise.resolve();
    return db.collection("approvals").doc(approvalId).update({
      status: decision === "Duyệt" ? "approved" : "rejected",
      decidedBy: state.me.id,
      decidedByName: state.me.name,
      decidedAt: serverTimestamp(),
      decision: decision,
      reason: reason || "",
      evidence: evidence || "",
      batchId: batchId || ""
    }).catch(function (e) { console.warn("finalize approval:", e); });
  }

  /* Side effects dùng chung cho MỌI lần đổi trạng thái việc (bảng, modal,
     Hộp duyệt): tạo hồ sơ phê duyệt khi trình duyệt, ghi decision log kèm
     bằng chứng + mức xác minh. Không ghi activity ở đây (bên gọi đã ghi). */
  function handleStatusSideEffects(t, oldStatus, newStatus, ctx) {
    ctx = ctx || {};
    if (newStatus === "Chờ duyệt" && oldStatus !== "Chờ duyệt") {
      createApprovalRequest(t).then(function (approvalId) {
        logDecision("Trình duyệt", t, "", ctx.evidence || "", "agent báo cáo", "", approvalId || "");
      });
      return;
    }
    if (ctx.action === "Duyệt" || ctx.action === "Trả lại") {
      logDecision(ctx.action, t, ctx.reason || "", ctx.evidence || "", "đã xác nhận", state.me ? state.me.name : "", ctx.approvalId || "");
    } else if (newStatus === "Hoàn thành") {
      var isSelf = !!(state.me && t.assigneeId === state.me.id);
      logDecision("Hoàn thành", t, ctx.reason || "", ctx.evidence || "", isSelf ? "agent báo cáo" : "đã xác nhận", isSelf ? "" : (state.me ? state.me.name : ""), ctx.approvalId || "");
    }
  }

  /* ---------- Khởi tạo Firebase ---------- */
  function initFirebase() {
    if (!CONFIGURED) {
      $("configNotice").classList.remove("hidden");
      return false;
    }
    try {
      firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.firestore();
      serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;
      return true;
    } catch (e) {
      $("configNotice").classList.remove("hidden");
      return false;
    }
  }

  /* ---------- Đăng nhập / đăng xuất ---------- */
  function loginErrorText(err) {
    var code = (err && err.code) || "";
    switch (code) {
      case "auth/invalid-email": return "Địa chỉ email không hợp lệ.";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials":
        return "Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.";
      case "auth/user-disabled": return "Tài khoản đã bị khóa. Liên hệ Giám đốc để được hỗ trợ.";
      case "auth/too-many-requests": return "Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.";
      case "auth/network-request-failed": return "Lỗi mạng. Kiểm tra kết nối internet rồi thử lại.";
      default: return "Đăng nhập thất bại. Vui lòng thử lại sau.";
    }
  }

  function onLoginSubmit(ev) {
    ev.preventDefault();
    var errBox = $("loginError");
    errBox.classList.add("hidden");
    if (!CONFIGURED || !auth) {
      errBox.textContent = "Chưa có cấu hình Firebase. Hãy điền thông tin project vào file config.js trước.";
      errBox.classList.remove("hidden");
      return;
    }
    var email = $("loginEmail").value.trim();
    var pw = $("loginPassword").value;
    var btn = $("loginBtn");
    btn.disabled = true;
    btn.textContent = "Đang đăng nhập...";
    /* Giữ mật khẩu vừa nhập trong bộ nhớ phiên trang: cổng 2FA của Giám đốc cần nó
       để mở khoá bí mật xác thực (khoá suy từ mật khẩu). Xoá ngay khi đăng nhập lỗi,
       đăng xuất, hoặc đã qua cổng. */
    gatePassword = pw;
    auth.signInWithEmailAndPassword(email, pw)
      .catch(function (err) {
        gatePassword = null;
        errBox.textContent = loginErrorText(err);
        errBox.classList.remove("hidden");
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = "Đăng nhập";
      });
  }

  function doLogout() {
    stopListeners();
    stopCheckin();
    stopClock();
    closeBell();
    clearGateState();
    if (auth) auth.signOut();
  }

  /* ---------- Hồ sơ người dùng ---------- */
  function setMeFromDoc(doc) {
    var d = doc.data();
    state.me = {
      id: doc.id, name: d.name || "", title: d.title || "", level: d.level || "",
      role: d.role || "", realDoc: true
    };
  }
  function loadMyProfile(user) {
    var email = String(user.email || "").trim().toLowerCase();
    var directorEmail = String(DIRECTOR_EMAIL || "").trim().toLowerCase();
    /* Cách 1: truy vấn thẳng theo loginEmail đã chuẩn hoá */
    return db.collection("employees").where("loginEmail", "==", email).limit(1).get()
      .then(function (snap) {
        if (!snap.empty) {
          setMeFromDoc(snap.docs[0]);
          return true;
        }
        /* Cách 2 (dự phòng): quét toàn bộ danh sách, so khớp không phân biệt hoa/thường
           và chấp nhận cả khoảng trắng thừa — tránh trượt hồ sơ vì dữ liệu nhập tay. */
        return db.collection("employees").get().then(function (all) {
          var found = null;
          all.forEach(function (doc) {
            if (found) return;
            var d = doc.data();
            var le = String(d.loginEmail || "").trim().toLowerCase();
            if (le && le === email) found = doc;
            /* Giám đốc dùng bản ghi "chung" kể cả khi loginEmail trong bản ghi bị trống/sai */
            if (!found && email === directorEmail && doc.id === "chung") found = doc;
          });
          if (found) {
            setMeFromDoc(found);
            return true;
          }
          if (email === directorEmail) {
            console.warn("loadMyProfile: không tìm thấy bản ghi nhân viên cho email Giám đốc — dùng hồ sơ Giám đốc dự phòng (realDoc=false, check-in sẽ không ghi được). Hãy kiểm tra trường loginEmail của bản ghi Giám đốc trong Firestore.");
            state.me = {
              id: "director", name: "Chung", title: "Giám đốc", level: "Giám đốc",
              role: "Điều hành chung", realDoc: false
            };
            return true;
          }
          return false;
        });
      })
      .catch(function (e) {
        console.error("loadMyProfile thất bại:", e);
        throw e;
      });
  }

  /* ---------- Vào / ra ứng dụng ---------- */
  function enterApp() {
    $("loginView").classList.add("hidden");
    $("gateView").classList.add("hidden");
    $("noProfileView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("currentUserLabel").textContent = state.me.name + " — " + state.me.title;
    $("taskForm").classList.toggle("hidden", !canManage());
    $("quickTaskForm").classList.toggle("hidden", !canManage());
    applyRoleGating();
    $("empFormCard").classList.toggle("hidden", !isDirector());
    $("securityCard").classList.toggle("hidden", !isDirectorAccount());
    if (isDirectorAccount()) renderSecurityCard();
    var canEdit = isDirector();
    $("intervalInput").disabled = !canEdit;
    $("intervalSave").disabled = !canEdit;
    var ackIn = $("ackTimeoutInput"), ackBtn = $("ackTimeoutSave");
    if (ackIn) ackIn.disabled = !canEdit;
    if (ackBtn) ackBtn.disabled = !canEdit;
    startListeners();
    startCheckin();
    startClock();
    renderSelfStatus();
  }

  /* Chip trạng thái của CHÍNH MÌNH trên header — luôn thấy ở mọi tab:
     "Đang trực tuyến · kiểm tra lúc HH:MM" kèm avatar của mình. */
  function renderSelfStatus() {
    var chip = $("selfStatus"), av = $("selfAvatar");
    if (!chip) return;
    if (!state.me) {
      chip.classList.add("hidden");
      if (av) { av.classList.add("hidden"); av.innerHTML = ""; }
      return;
    }
    var mine = state.me.realDoc ? empById(state.me.id) : null;
    var act = mine ? lastActivityOf(mine) : null;
    var lastMs = act ? act.ms : null;
    var lastTs = act ? act.ts : null;
    if (state.lastCheckinAt && (lastMs === null || state.lastCheckinAt > lastMs)) {
      lastMs = state.lastCheckinAt; lastTs = state.lastCheckinAt;
    }
    var label;
    if (lastMs) label = "Đang trực tuyến · kiểm tra lúc " + fmtClock(lastTs);
    else if (state.me.realDoc) label = "Đang trực tuyến · đang điểm danh…";
    else label = "Đang trực tuyến";
    chip.innerHTML = '<span class="dot on"></span><span class="ss-text">' + esc(label) + "</span>";
    chip.classList.remove("hidden");
    if (av) {
      var src = mine || { name: state.me.name, color: "#4f46e5" };
      av.innerHTML = avatarHtml(src, "sm");
      av.classList.remove("hidden");
    }
  }

  function showLogin() {
    state.user = null;
    state.me = null;
    state.security = null;
    state.messages = []; state.tasks = []; state.employees = []; state.activities = [];
    state.pendingFiles = [];
    clearGateState();
    $("appView").classList.add("hidden");
    $("gateView").classList.add("hidden");
    $("noProfileView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    renderSelfStatus();
  }

  function showNoProfile(email) {
    $("loginView").classList.add("hidden");
    $("appView").classList.add("hidden");
    $("noProfileEmail").textContent = email || "";
    $("noProfileView").classList.remove("hidden");
  }

  /* ---------- Listeners Firestore ---------- */
  function startListeners() {
    stopListeners();
    state.unsub.push(
      db.collection("messages").orderBy("createdAt", "asc").onSnapshot(function (snap) {
        var prevMsgIds = {};
        state.messages.forEach(function (m) { prevMsgIds[m.id] = true; });
        var firstMsgLoad = !state.messagesLoadedOnce;
        state.messagesLoadedOnce = true;
        state.messages = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderMessages();
        renderPinned();
        if (!firstMsgLoad) maybeNotifyMentions(prevMsgIds);
        refreshRoom3dBubbles(prevMsgIds);
        renderRightRail();
        if (state.currentTab === "room") markRoomRead(); else { refreshUnreadBadge(); renderBell(); renderInbox(); }
      }, function (e) { console.warn("messages listener:", e); })
    );
    state.unsub.push(
      db.collection("tasks").orderBy("createdAt", "desc").onSnapshot(function (snap) {
        state.tasks = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderTasks();
        renderOverview();
        /* Không dựng lại Hộp duyệt khi người duyệt đang gõ lý do (tránh mất chữ đang nhập) */
        var aeAp = document.activeElement;
        if (!(aeAp && aeAp.closest && aeAp.closest("#approvalList"))) renderApproval();
        renderBell();
        renderInbox();
        renderTaskModalIfOpen();
        refreshRoom3dBoard();
      }, function (e) { console.warn("tasks listener:", e); })
    );
    state.unsub.push(
      db.collection("employees").onSnapshot(function (snap) {
        state.employees = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderOverview();
        renderOrgTree();
        renderEmployeesTab();
        renderAssigneeOptions();
        renderBell();
        renderInbox();
        renderSelfStatus();
        applyRoleGating();
        renderChatFilters();
      }, function (e) { console.warn("employees listener:", e); })
    );
    state.unsub.push(
      db.collection("presence").onSnapshot(function (snap) {
        var map = {};
        snap.docs.forEach(function (d) { map[d.id] = d.data(); });
        state.presence = map;
        renderHealth();
        renderRightRail();
        refreshRoom3dPeople();
      }, function (e) {
        state.lastStreamError = { code: e.code || "", message: e.message || "" };
        renderHealth();
        console.warn("presence listener:", e);
      })
    );
    state.unsub.push(
      db.collection("activities").orderBy("createdAt", "desc").limit(12).onSnapshot(function (snap) {
        state.activities = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderActivities();
      }, function (e) { console.warn("activities listener:", e); })
    );
    state.unsub.push(
      db.collection("settings").doc("room").onSnapshot(function (doc) {
        var d = doc.exists ? doc.data() : {};
        var v = d.checkIntervalMinutes;
        var n = parseInt(v, 10);
        var next = (!isNaN(n) && n > 0) ? n : 10;
        var changed = next !== state.checkIntervalMinutes;
        state.checkIntervalMinutes = next;
        var input = $("intervalInput");
        if (document.activeElement !== input) input.value = String(next);
        /* Phase 2 — ngưỡng quá hạn xác nhận, cùng doc settings/room. */
        var av = parseInt(d.ackTimeoutHours, 10);
        var anext = (!isNaN(av) && av >= 1 && av <= 168) ? av : 24;
        var achanged = anext !== state.ackTimeoutHours;
        state.ackTimeoutHours = anext;
        var ainput = $("ackTimeoutInput");
        if (ainput && document.activeElement !== ainput) ainput.value = String(anext);
        /* Phase 4 — phiên bản quy tắc (nếu có) để hiển thị ở Cài đặt. */
        state.rulesVersion = d.rulesVersion ? String(d.rulesVersion) : "";
        var rv = $("rulesVersionText");
        if (rv) rv.textContent = state.rulesVersion || "chưa có dữ liệu";
        if (changed && state.user) {
          startCheckin();
          renderOverview();
          renderEmployeesTab();
        }
        if (achanged && state.user) {
          renderOverview();
          renderBell();
        }
      }, function (e) { console.warn("settings listener:", e); })
    );
  }

  function stopListeners() {
    state.unsub.forEach(function (u) { try { u(); } catch (e) {} });
    state.unsub = [];
  }

  /* ---------- Check-in tự động: áp dụng cho MỌI tài khoản có hồ sơ ----------
     Chạy NGAY khi đăng nhập xong, lặp theo chu kỳ cài đặt, và chạy lại mỗi khi
     người dùng quay lại tab (focus / visibilitychange -> visible). */
  function doCheckin() {
    if (!db || !state.me) return;
    if (!state.me.realDoc) {
      console.warn("check-in: bỏ qua vì hồ sơ của tôi chưa gắn với bản ghi nhân viên thật (realDoc=false). Kiểm tra trường loginEmail trong Firestore để check-in ghi đúng bản ghi.");
      return;
    }
    state.lastCheckinTry = Date.now();
    db.collection("employees").doc(state.me.id).update({
      lastCheckAt: serverTimestamp(),
      status: "Đang hoạt động"
    }).then(function () {
      /* Ghi nhận lạc quan tại máy này để chip trạng thái trên header hiện đúng
         ngay lập tức, không phải đợi snapshot Firestore quay về. */
      state.lastCheckinAt = Date.now();
      renderSelfStatus();
    }).catch(function (e) { console.error("check-in thất bại:", e); });
  }
  function checkinOnReturn() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    /* Chống ghi dồn: bỏ qua nếu lần thử gần nhất cách đây chưa đầy 20 giây */
    if (Date.now() - (state.lastCheckinTry || 0) < 20000) return;
    doCheckin();
  }
  function onVisibilityForCheckin() {
    if (!document.visibilityState || document.visibilityState === "visible") checkinOnReturn();
  }
  function startCheckin() {
    stopCheckin();
    doCheckin();
    var ms = Math.max(1, state.checkIntervalMinutes || 10) * 60 * 1000;
    state.checkinTimer = setInterval(doCheckin, ms);
    if (!state.presenceBound) {
      document.addEventListener("visibilitychange", onVisibilityForCheckin);
      window.addEventListener("focus", checkinOnReturn);
      state.presenceBound = true;
    }
  }
  function stopCheckin() {
    if (state.checkinTimer) { clearInterval(state.checkinTimer); state.checkinTimer = null; }
    if (state.presenceBound) {
      document.removeEventListener("visibilitychange", onVisibilityForCheckin);
      window.removeEventListener("focus", checkinOnReturn);
      state.presenceBound = false;
    }
  }

  /* Đồng hồ 30 giây: làm mới mọi nhãn phụ thuộc thời gian (hiện diện, quá hạn kiểm tra,
     quá hạn việc, thời gian tương đối) mà không cần tải lại trang */
  function startClock() {
    stopClock();
    state.clockTimer = setInterval(function () {
      if (!state.me) return;
      renderSelfStatus();
      renderOverview();
      renderOrgTree();
      renderEmployeesTab();
      /* Không dựng lại bảng việc khi người dùng đang gõ trong thẻ (tránh mất chữ đang nhập) */
      var ae = document.activeElement;
      var board = $("taskBoard");
      if (!(ae && board && board.contains(ae))) renderTasks();
      renderBell();
    }, 30 * 1000);
  }
  function stopClock() {
    if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
  }

  /* ---------- Tabs ---------- */
  var TABS = ["overview", "org", "room", "tasks", "inbox", "employees", "settings", "duyet", "3d", "log"];
  function switchTab(name) {
    if (name === "more") { toggleMoreMenu(); return; }
    var prevTab = state.currentTab;
    state.currentTab = name;
    var tabs = document.querySelectorAll("#tabBar .tab");
    tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
    TABS.forEach(function (k) {
      $("tab-" + k).classList.toggle("hidden", k !== name);
    });
    closeMoreMenu();
    if (prevTab === "3d" && name !== "3d") stop3dLoop();
    closeSearchPanel();
    var moreBtn = document.querySelector("#tabBar .tab-more");
    if (moreBtn) moreBtn.classList.toggle("active", ["org", "employees", "settings"].indexOf(name) !== -1);
    if (name === "room") {
      markRoomRead();
      scrollMessagesBottom();
    } else {
      closeMentionBox();
      if (name === "inbox") renderInbox();
      if (name === "duyet") renderApproval();
      if (name === "3d") init3d();
      if (name === "log" && !state.decisionsLoaded) loadDecisions();
    }
  }

  /* ---------- Chuông thông báo ---------- */
  function canApprove() { return canManage(); }
  function bellData() {
    var unread = unreadCount();
    var mentions = mentionUnreadMessages();
    var mine = [];
    var review = [];
    var ackOverdue = [];
    if (state.me) {
      mine = state.tasks.filter(function (t) {
        return t.assigneeId === state.me.id && t.status === "Chờ nhận";
      });
      if (canApprove()) {
        review = state.tasks.filter(function (t) { return t.status === "Chờ duyệt"; });
        /* Phase 2 — việc quá hạn xác nhận của NGƯỜI KHÁC (việc của mình đã
           nằm trong mine nên không cộng thêm, tránh đếm trùng một việc
           hai lần — cùng nguyên tắc dedup như mentions/unread). */
        ackOverdue = ackOverdueTasks().filter(function (t) { return t.assigneeId !== state.me.id; });
      }
    }
    /* Tổng mục chưa xử lý = tin chưa đọc (ĐÃ gồm các tin nhắc tên mình — chúng là
       tập con của tin chưa đọc nên không cộng thêm lần nữa) + việc chờ mình nhận
       + việc chờ duyệt + việc quá hạn xác nhận của người khác. Lấy max(unread, mentions) hay cộng mentions vào unread
       đều sai: một là thiếu, hai là đếm trùng. */
    return { unread: unread, mentions: mentions, mine: mine, review: review, ackOverdue: ackOverdue, total: unread + mine.length + review.length + ackOverdue.length };
  }
  function renderBell() {
    var badge = $("bellBadge");
    if (!badge || !state.me) return;
    var b = bellData();
    badge.textContent = String(b.total);
    badge.classList.toggle("hidden", b.total === 0);
    var ib = $("inboxBadge");
    if (ib) { ib.textContent = String(b.total); ib.classList.toggle("hidden", b.total === 0); }
    if (!$("bellPanel").classList.contains("hidden")) renderBellList(b);
  }
  function snippetOf(text) {
    var s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > 64 ? s.slice(0, 64) + "…" : s;
  }
  function renderBellList(b) {
    var box = $("bellList");
    if (!box) return;
    var html = "";
    /* Lượt nhắc tên mình lên đầu danh sách — bấm vào nhảy thẳng tới tin đó. */
    b.mentions.slice(0, 5).forEach(function (m) {
      html += '<div class="bell-item" data-goto-msg="' + esc(m.id) + '"><span class="dot" style="margin-top:6px;background:#0a7bef"></span>' +
        '<div class="b-text"><b>' + esc(m.senderName || "") + '</b> nhắc đến bạn trong phòng họp' +
        '<div class="b-sub">' + esc(snippetOf(m.content)) + "</div></div></div>";
    });
    /* Phần tin chưa đọc còn lại ngoài các lượt nhắc (tránh lặp lại chính chúng). */
    var restUnread = b.unread - b.mentions.length;
    if (restUnread > 0) {
      html += '<div class="bell-item" data-goto="room"><span class="dot late" style="margin-top:6px"></span>' +
        '<div class="b-text"><b>' + (b.mentions.length ? "Còn " : "") + restUnread + ' tin phòng họp chưa đọc</b>' +
        '<div class="b-sub">Bấm để vào phòng họp xem và nhận việc</div></div></div>';
    }
    b.mine.forEach(function (t) {
      html += '<div class="bell-item" data-goto="tasks"><span class="dot on" style="margin-top:6px"></span>' +
        '<div class="b-text">Việc chờ bạn nhận: <b>' + esc(t.title || "") + '</b>' +
        '<div class="b-sub">Giao bởi: ' + esc(empName(t.assignerId)) + '</div></div></div>';
    });
    b.review.forEach(function (t) {
      html += '<div class="bell-item" data-goto="tasks"><span class="dot" style="margin-top:6px;background:#f59e0b"></span>' +
        '<div class="b-text">Việc chờ duyệt: <b>' + esc(t.title || "") + '</b>' +
        '<div class="b-sub">Phụ trách: ' + esc(empName(t.assigneeId)) + '</div></div></div>';
    });
    b.ackOverdue.forEach(function (t) {
      html += '<div class="bell-item" data-goto="tasks"><span class="dot" style="margin-top:6px;background:#b3261e"></span>' +
        '<div class="b-text">Việc quá hạn xác nhận: <b>' + esc(t.title || "") + '</b>' +
        '<div class="b-sub">Phụ trách: ' + esc(empName(t.assigneeId)) + ' · chờ ' + esc(ageText(ackAgeMs(t))) + '</div></div></div>';
    });
    box.innerHTML = html || '<div class="bell-empty">Không có thông báo mới.</div>';
  }
  function toggleBell() {
    var panel = $("bellPanel");
    var willOpen = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !willOpen);
    if (willOpen) renderBellList(bellData());
  }
  function closeBell() {
    var panel = $("bellPanel");
    if (panel) panel.classList.add("hidden");
  }

  /* Trung tâm điều phối M06 — Hộp thư công việc: gom từ bellData() (tin nhắc
     tên, tin chưa đọc, việc chờ mình nhận, việc chờ duyệt, việc quá hạn xác
     nhận). Không tạo collection mới; bellData đã tránh đếm trùng. Bấm mục
     nào cũng đi thẳng tới đúng chỗ (tin nhắn / chi tiết việc / phòng họp)
     nhờ bộ xử lý click toàn cục đã có (data-goto-msg / data-taskopen /
     data-goto). */
  function renderInbox() {
    var box = $("inboxList");
    if (!box) return;
    if (!state.me) { box.innerHTML = '<p class="hint">Đăng nhập để xem hộp thư.</p>'; return; }
    var b = bellData();
    function group(title, itemsHtml) {
      if (!itemsHtml) return "";
      return '<div class="inbox-group"><h3>' + title + "</h3>" + itemsHtml + "</div>";
    }
    var html = "";
    html += group("Nhắc đến bạn", b.mentions.map(function (m) {
      return '<button class="inbox-item" type="button" data-goto-msg="' + esc(m.id) + '">' +
        '<span class="dot" style="margin-top:6px;background:#0a7bef"></span>' +
        '<div class="i-text"><b>' + esc(m.senderName || "") + '</b> nhắc đến bạn trong phòng họp' +
        '<div class="i-sub">' + esc(snippetOf(m.content)) + "</div></div></button>";
    }).join(""));
    var restUnread = b.unread - b.mentions.length;
    if (restUnread > 0) {
      html += group("Tin phòng họp chưa đọc", '<button class="inbox-item" type="button" data-goto="room">' +
        '<span class="dot late" style="margin-top:6px"></span>' +
        '<div class="i-text"><b>' + (b.mentions.length ? "Còn " : "") + restUnread + " tin phòng họp chưa đọc</b>" +
        '<div class="i-sub">Bấm để vào phòng họp xem và nhận việc</div></div></button>');
    }
    html += group("Việc chờ bạn nhận", b.mine.map(function (t) {
      return '<button class="inbox-item" type="button" data-taskopen="' + esc(t.id) + '">' +
        '<span class="dot on" style="margin-top:6px"></span>' +
        '<div class="i-text">Việc chờ bạn nhận: <b>' + esc(t.title || "") + '</b>' +
        '<div class="i-sub">Giao bởi: ' + esc(empName(t.assignerId)) + "</div></div></button>";
    }).join(""));
    html += group("Việc chờ duyệt", b.review.map(function (t) {
      return '<button class="inbox-item" type="button" data-taskopen="' + esc(t.id) + '">' +
        '<span class="dot" style="margin-top:6px;background:#f59e0b"></span>' +
        '<div class="i-text">Việc chờ duyệt: <b>' + esc(t.title || "") + '</b>' +
        '<div class="i-sub">Phụ trách: ' + esc(empName(t.assigneeId)) + "</div></div></button>";
    }).join(""));
    html += group("Việc quá hạn xác nhận", b.ackOverdue.map(function (t) {
      return '<button class="inbox-item" type="button" data-taskopen="' + esc(t.id) + '">' +
        '<span class="dot" style="margin-top:6px;background:#b3261e"></span>' +
        '<div class="i-text">Việc quá hạn xác nhận: <b>' + esc(t.title || "") + '</b>' +
        '<div class="i-sub">Phụ trách: ' + esc(empName(t.assigneeId)) + " · chờ " + esc(ageText(ackAgeMs(t))) + "</div></div></button>";
    }).join(""));
    box.innerHTML = html || '<div class="card" style="padding:16px"><p class="hint" style="margin:0">Không có mục nào cần xử lý.</p></div>';
  }
  function closeMoreMenu() { var m = $("moreMenu"); if (m) m.classList.add("hidden"); }
  function toggleMoreMenu() { var m = $("moreMenu"); if (m) m.classList.toggle("hidden"); }
  /* Bấm một lượt nhắc trong chuông: vào phòng họp và làm nổi bật đúng tin đó
     trong ~2,8 giây (class msg-highlight), cuộn tin vào giữa màn hình. */
  function jumpToMessage(id) {
    if (!id) return;
    if (state.highlightTimer) { clearTimeout(state.highlightTimer); state.highlightTimer = null; }
    state.highlightMsgId = id;
    switchTab("room");
    renderMessages();
    requestAnimationFrame(function () {
      var el = document.querySelector('.msg[data-msg-id="' + id + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    state.highlightTimer = setTimeout(function () {
      state.highlightMsgId = null;
      state.highlightTimer = null;
      var el = document.querySelector(".msg.msg-highlight");
      if (el) el.classList.remove("msg-highlight");
    }, 2800);
  }

  /* ---------- Ghim thông báo ---------- */
  function latestPinned() {
    var best = null;
    state.messages.forEach(function (m) {
      if (m.pinned && (!best || (tsMillis(m.createdAt) || 0) >= (tsMillis(best.createdAt) || 0))) best = m;
    });
    return best;
  }
  function renderPinned() {
    var m = latestPinned();
    var html = "";
    if (m) {
      html = '<div class="pin-banner"><span class="pin-tag">THÔNG BÁO GHIM</span>' +
        '<div class="pin-content">' + formatContentHtml(m.content || "", m.mentions, state.employees, state.me ? state.me.id : null) +
        '<div class="pin-meta">' + esc(m.senderName || "") +
        (m.senderTitle ? " — " + esc(m.senderTitle) : "") + " · " + esc(fmtTime(m.createdAt)) + '</div></div>' +
        (canManage() ? '<button class="btn ghost small" type="button" data-unpin="' + esc(m.id) + '">Bỏ ghim</button>' : "") +
        '</div>';
    }
    var o = $("pinBannerOverview"), r = $("pinBannerRoom");
    if (o) o.innerHTML = html;
    if (r) r.innerHTML = html;
  }
  function setPinned(msgId, val) {
    if (!db) return;
    db.collection("messages").doc(msgId).update({ pinned: val })
      .catch(function (e) { console.warn("pin message:", e); });
  }

  /* ---------- Nhắc tên (@tag) trong phòng họp ----------
     Luật nhận diện (áp dụng giống nhau cho lúc gửi, lúc hiển thị và hộp gợi ý):
     - "@" chỉ mở một lượt nhắc khi nó đứng ở đầu nội dung hoặc ngay sau khoảng trắng
       (nên "abc@hung" kiểu địa chỉ email KHÔNG bao giờ thành lượt nhắc).
     - Tên được so khớp TRỰC TIẾP bằng chuỗi (không dựng RegExp từ tên nhân viên,
       nên không có bề mặt tiêm mẫu tìm kiếm), không phân biệt hoa/thường và gấp dấu
       tiếng Việt ("@hung", "@HÙNG", "@Hùng" đều khớp nhân viên "Hùng").
     - Ngay sau tên phải là ký tự không thuộc từ (khoảng trắng, dấu câu, hết câu...)
       để "@HùngTuấn" không bị tính nhầm là nhắc "Hùng". */
  function mentionFold(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\u0111/g, "d").replace(/\u0110/g, "d").toLowerCase();
  }
  /* Gấp dấu từng ký tự, kèm bản đồ vị trí: map[i] = vị trí kết thúc (exclusive)
     trong chuỗi gốc tương ứng với ký tự gấp thứ i — để cắt lại đúng đoạn gốc. */
  function foldWithMap(s) {
    var folded = "", map = [];
    for (var i = 0; i < s.length; i++) {
      var f = mentionFold(s.charAt(i));
      for (var j = 0; j < f.length; j++) { folded += f.charAt(j); map.push(i + 1); }
    }
    return { folded: folded, map: map };
  }
  function isWordChar(ch) {
    if (!ch) return false;
    if (ch === "_") return true;
    if (ch >= "0" && ch <= "9") return true;
    return ch.toLowerCase() !== ch.toUpperCase();
  }
  function matchMentionAt(text, at, list) {
    var win = foldWithMap(text.slice(at + 1, at + 1 + 64));
    for (var i = 0; i < list.length; i++) {
      var fn = list[i].folded;
      if (win.folded.length < fn.length) continue;
      if (win.folded.slice(0, fn.length) !== fn) continue;
      var endOrig = at + 1 + win.map[fn.length - 1];
      if (isWordChar(text.charAt(endOrig))) continue;
      return { id: list[i].id, name: text.slice(at + 1, endOrig), start: at, end: endOrig };
    }
    return null;
  }
  /* Trả về mọi lượt nhắc trong nội dung: [{id, name (như đã gõ), start, end}] */
  function findMentions(content, employees) {
    var text = String(content || "");
    var list = (employees || []).filter(function (e) { return e && e.name; }).map(function (e) {
      return { id: e.id, folded: mentionFold(e.name) };
    }).filter(function (e) { return e.folded.length > 0; })
      .sort(function (a, b) { return b.folded.length - a.folded.length; });
    var out = [];
    if (!list.length || text.indexOf("@") < 0) return out;
    var re = /(^|\s)@/g, m;
    while ((m = re.exec(text)) !== null) {
      var at = m.index + m[1].length;
      var hit = matchMentionAt(text, at, list);
      if (hit) { out.push(hit); re.lastIndex = hit.end; }
    }
    return out;
  }
  /* Mảng employee id bị nhắc trong nội dung (khử trùng, giữ thứ tự xuất hiện) —
     đây là giá trị lưu vào trường mentions của doc message khi gửi. */
  function computeMentions(content, employees) {
    var seen = {}, ids = [];
    findMentions(content, employees).forEach(function (h) {
      if (!seen[h.id]) { seen[h.id] = true; ids.push(h.id); }
    });
    return ids;
  }
  /* Dựng HTML hiển thị nội dung tin: escape TOÀN BỘ nội dung trước, chỉ bọc
     <span class="mention"> quanh các đoạn "@Tên" thuộc về người có trong mentions.
     mentionsField là mảng id đã lưu trong doc; tin cũ chưa có trường này thì
     suy từ nội dung theo cùng luật nhận diện. Nhắc chính người đang xem thì
     thêm class mention-me (nền + viền nhấn nhẹ). */
  function formatContentHtml(content, mentionsField, employees, myId) {
    var text = String(content == null ? "" : content);
    if (!text) return "";
    var hits = findMentions(text, employees || []);
    if (Array.isArray(mentionsField)) {
      var allowed = {};
      mentionsField.forEach(function (id) { allowed[id] = true; });
      hits = hits.filter(function (h) { return !!allowed[h.id]; });
    }
    if (!hits.length) return esc(text);
    var html = "", last = 0;
    hits.forEach(function (h) {
      html += esc(text.slice(last, h.start));
      html += '<span class="mention' + (myId && h.id === myId ? " mention-me" : "") + '">' +
        esc(text.slice(h.start, h.end)) + "</span>";
      last = h.end;
    });
    html += esc(text.slice(last));
    return html;
  }

  /* ---------- Phòng họp ---------- */
  function kindClass(kind) {
    if (kind === "Giao việc") return "kind k-task";
    if (kind === "Thông báo") return "kind k-notice";
    if (kind === "Cập nhật tiến độ") return "kind k-progress";
    if (kind === "Báo cáo kết quả") return "kind k-report";
    return "kind";
  }
  function empOfSender(senderId) { return empById(senderId); }

  function attachmentsHtml(m) {
    var atts = m.attachments || [];
    if (!atts.length) return "";
    var html = '<div class="attachments">';
    atts.forEach(function (a) {
      if (a.type && a.type.indexOf("image/") === 0) {
        html += '<div class="att-img" data-attimg="' + esc(a.fileId) + '" data-atttype="' + esc(a.type) + '">' +
          '<div class="att-loading">Đang tải ảnh...</div></div>';
      } else {
        html += '<button type="button" class="att-file" data-dl="' + esc(a.fileId) + '">' +
          '<span class="f-name">' + esc(a.name || "Tệp đính kèm") + '</span>' +
          '<span class="f-size">' + esc(fmtSize(a.size)) + " · Tải xuống</span></button>";
      }
    });
    return html + "</div>";
  }

  function renderMessages() {
    var box = $("messageList");
    if (!box) return;
    renderChatFilters();
    var msgList = chatFilteredMessages();
    if (!state.messages.length) {
      box.innerHTML = '<p class="hint" style="text-align:center">Chưa có tin nhắn nào. Hãy gửi tin đầu tiên.</p>';
      var ci0 = $("chatFilterInfo");
      if (ci0) ci0.textContent = "";
      return;
    }
    if (!msgList.length) {
      box.innerHTML = '<p class="hint" style="text-align:center">Không có tin nào khớp bộ lọc hiện tại.</p>';
      return;
    }
    box.innerHTML = msgList.map(function (m) {
      var sender = empOfSender(m.senderId);
      var colorEmp = sender || { name: m.senderName || "?", color: "#4f46e5" };
      var cls = "msg" + (m.kind === "Giao việc" ? " is-task" : "") + (m.kind === "Thông báo" ? " is-notice" : "") +
        (state.highlightMsgId && state.highlightMsgId === m.id ? " msg-highlight" : "");
      var pinRow = "";
      if (m.kind === "Thông báo" && canManage()) {
        pinRow = '<div class="pin-row"><button class="btn ghost small" type="button" data-pin="' + esc(m.id) +
          '" data-state="' + (m.pinned ? "1" : "0") + '">' + (m.pinned ? "Bỏ ghim thông báo" : "Ghim thông báo") + "</button></div>";
      }
      return '<div class="' + cls + '" data-msg-id="' + esc(m.id) + '">' +
        avatarHtml(colorEmp, "sm") +
        '<div class="msg-body">' +
          '<div class="meta">' +
            '<span class="sender">' + esc(m.senderName || "") + "</span>" +
            (m.senderTitle ? '<span class="title">' + esc(m.senderTitle) + "</span>" : "") +
            '<span class="' + kindClass(m.kind) + '">' + esc(m.kind || "Trao đổi") + "</span>" +
            (m.pinned ? '<span class="chip" style="background:#eef1f4;color:#374151">Đã ghim</span>' : "") +
            (m.needsReply ? '<span class="chip chip-need">Cần trả lời</span>' : "") +
            (m.priority === "khẩn" ? '<span class="chip chip-urgent">Khẩn</span>' : "") +
            '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span>" +
          "</div>" +
          (m.content ? '<div class="content">' + formatContentHtml(m.content, m.mentions, state.employees, state.me ? state.me.id : null) + "</div>" : "") +
          attachmentsHtml(m) +
          (m.linkedTaskTitle ? '<span class="linked-task">Đã tạo việc: ' + esc(m.linkedTaskTitle) + "</span>" : "") +
          pinRow +
          handledActionHtml(m) +
        "</div>" +
      "</div>";
    }).join("");
    hydrateImages();
    scrollMessagesBottom();
    updateChatFilterInfo(msgList.length);
  }

  function scrollMessagesBottom() {
    if (state.currentTab !== "room") return;
    if (state.highlightMsgId) return; /* đang làm nổi bật một tin — không giật xuống cuối */
    requestAnimationFrame(function () { window.scrollTo(0, document.body.scrollHeight); });
  }

  /* ----- Tệp đính kèm: lưu/đọc trong Firestore dạng mảnh base64 ----- */
  function loadFile(fileId) {
    if (state.fileCache[fileId]) return state.fileCache[fileId];
    var p = db.collection("files").doc(fileId).get().then(function (doc) {
      if (!doc.exists) throw new Error("Không tìm thấy tệp");
      var d = doc.data();
      var n = d.chunks || 0;
      return db.collection("files").doc(fileId).collection("parts").get().then(function (snap) {
        var parts = {};
        snap.forEach(function (pd) { parts[pd.id] = (pd.data() && pd.data().data) || ""; });
        var out = "";
        for (var i = 0; i < n; i++) out += parts["p" + i] || "";
        return { b64: out, type: d.type || "application/octet-stream", name: d.name || "tep" };
      });
    });
    state.fileCache[fileId] = p;
    return p;
  }
  function hydrateImages() {
    var nodes = document.querySelectorAll("[data-attimg]");
    nodes.forEach(function (node) {
      if (node.getAttribute("data-done")) return;
      node.setAttribute("data-done", "1");
      var fid = node.getAttribute("data-attimg");
      var type = node.getAttribute("data-atttype") || "image/png";
      loadFile(fid).then(function (f) {
        node.innerHTML = '<img alt="Ảnh đính kèm" src="data:' + esc(f.type || type) + ";base64," + f.b64 + '">';
      }).catch(function () {
        node.innerHTML = '<div class="att-loading">Không tải được ảnh đính kèm.</div>';
      });
    });
  }
  function b64ToBlob(b64, type) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || "application/octet-stream" });
  }
  function downloadFile(fileId, btn) {
    var old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="f-name">Đang chuẩn bị tệp...</span>';
    loadFile(fileId).then(function (f) {
      var blob = b64ToBlob(f.b64, f.type);
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      btn.disabled = false;
      btn.innerHTML = old;
    }).catch(function () {
      btn.disabled = false;
      btn.innerHTML = old;
      showMsgError("Không tải được tệp đính kèm. Vui lòng thử lại.");
    });
  }
  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(new Error("Không đọc được tệp")); };
      r.readAsDataURL(file);
    });
  }
  function uploadOneFile(file, onProgress) {
    return readAsDataURL(file).then(function (dataUrl) {
      var b64 = dataUrl.split(",")[1] || "";
      var chunks = [];
      for (var i = 0; i < b64.length; i += CHUNK_CHARS) chunks.push(b64.substr(i, CHUNK_CHARS));
      if (!chunks.length) chunks.push("");
      return db.collection("files").add({
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        uploaderId: state.me.id,
        uploaderName: state.me.name,
        createdAt: serverTimestamp(),
        chunks: chunks.length
      }).then(function (ref) {
        var chain = Promise.resolve();
        chunks.forEach(function (c, idx) {
          chain = chain.then(function () {
            onProgress(idx + 1, chunks.length, file.name);
            return ref.collection("parts").doc("p" + idx).set({ data: c });
          });
        });
        return chain.then(function () {
          return { fileId: ref.id, name: file.name, size: file.size, type: file.type || "application/octet-stream" };
        });
      });
    });
  }

  function showMsgError(text) {
    var e = $("msgError");
    e.textContent = text;
    e.classList.remove("hidden");
  }
  function hideMsgError() { $("msgError").classList.add("hidden"); }

  function renderAttachList() {
    var box = $("attachList");
    if (!box) return;
    box.innerHTML = state.pendingFiles.map(function (f, i) {
      return '<span class="attach-chip">' + esc(f.name) +
        ' <span class="muted">(' + esc(fmtSize(f.size)) + ")</span>" +
        '<button type="button" class="x" data-rmfile="' + i + '" aria-label="Bỏ tệp">✕</button></span>';
    }).join("");
  }
  function onAttachChange() {
    var input = $("attachInput");
    var files = Array.prototype.slice.call(input.files || []);
    var err = "";
    files.forEach(function (f) {
      if (f.size > MAX_FILE_SIZE) {
        err = "Tệp “" + f.name + "” vượt quá giới hạn 5MB nên không được đính kèm.";
      } else {
        state.pendingFiles.push(f);
      }
    });
    input.value = "";
    if (err) showMsgError(err); else hideMsgError();
    renderAttachList();
  }

  function onSendMessage(ev) {
    ev.preventDefault();
    if (!state.me || !db || state.sending) return;
    var content = $("messageInput").value.trim();
    var kind = $("messageKind").value;
    if (MSG_KINDS.indexOf(kind) < 0) kind = "Trao đổi";
    var files = state.pendingFiles.slice();
    if (!content && !files.length) {
      showMsgError("Hãy nhập nội dung hoặc đính kèm ít nhất một tệp.");
      return;
    }
    closeMentionBox();
    hideMsgError();
    state.sending = true;
    $("msgSendBtn").disabled = true;
    var progress = $("attachProgress");
    var atts = [];
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return uploadOneFile(f, function (done, total, name) {
          progress.textContent = "Đang tải tệp " + name + ": " + done + "/" + total + " mảnh...";
          progress.classList.remove("hidden");
        }).then(function (a) { atts.push(a); });
      });
    });
    var linkedTitle = "";
    chain.then(function () {
      var msg = {
        senderId: state.me.id,
        senderName: state.me.name,
        senderTitle: state.me.title,
        content: content,
        kind: kind,
        mentions: computeMentions(content, state.employees),
        createdAt: serverTimestamp(),
        attachments: atts,
        pinned: false
      };
      if ($("msgNeedsReply") && $("msgNeedsReply").checked) msg.needsReply = true;
      if ($("msgUrgent") && $("msgUrgent").checked) msg.priority = "khẩn";
      if (kind === "Giao việc") {
        var t = $("msgTaskTitle").value.trim();
        if (t) { msg.linkedTaskTitle = t; linkedTitle = t; }
      }
      return db.collection("messages").add(msg);
    }).then(function () {
      var extra = Promise.resolve();
      if (kind === "Giao việc") {
        var assignee = $("msgTaskAssignee").value;
        if (linkedTitle && assignee) {
          extra = db.collection("tasks").add({
            title: linkedTitle,
            description: content,
            assigneeId: assignee,
            assignerId: state.me.id,
            status: "Chờ nhận",
            priority: "Trung bình",
            resultNote: "",
            dueAt: null,
            comments: [],
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        logActivity("đã giao việc trong phòng họp" + (linkedTitle ? ": “" + linkedTitle + "”" : ""), "message");
      }
      return extra;
    }).then(function () {
      $("messageInput").value = "";
      if ($("msgNeedsReply")) $("msgNeedsReply").checked = false;
      if ($("msgUrgent")) $("msgUrgent").checked = false;
      $("msgTaskTitle").value = "";
      state.pendingFiles = [];
      renderAttachList();
      progress.classList.add("hidden");
      progress.textContent = "";
      state.sending = false;
      $("msgSendBtn").disabled = false;
    }).catch(function (e) {
      console.warn("send message:", e);
      showMsgError("Gửi tin thất bại (có thể do mạng hoặc tệp lỗi). Nội dung đã soạn vẫn được giữ nguyên — hãy thử gửi lại.");
      progress.classList.add("hidden");
      state.sending = false;
      $("msgSendBtn").disabled = false;
    });
  }

  /* ----- Hộp gợi ý @tag trong ô soạn tin -----
     Gõ "@" ở đầu câu hoặc sau khoảng trắng → hộp gợi ý nhân viên hiện ngay trên
     ô soạn; lọc theo phần chữ đã gõ sau "@" (gấp dấu, không phân biệt hoa/thường).
     Chọn bằng chạm/click, Enter hoặc Tab; Esc đóng hộp; xoá hết đoạn đang gõ
     (kể cả dấu @) thì ngữ cảnh nhắc biến mất và hộp tự đóng. */
  function mentionContext(ta) {
    var pos = ta.selectionStart;
    if (pos == null) return null;
    var text = ta.value.slice(0, pos);
    var i = text.lastIndexOf("@");
    if (i < 0) return null;
    if (i > 0 && !/\s/.test(text.charAt(i - 1))) return null; /* @ dính liền chữ phía trước — kiểu email */
    var query = text.slice(i + 1);
    if (/[\s@]/.test(query)) return null;
    return { start: i, query: query };
  }
  function closeMentionBox() {
    state.mentionUI = null;
    var box = $("mentionBox");
    if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  }
  function renderMentionBox() {
    var box = $("mentionBox");
    var st = state.mentionUI;
    if (!box || !st || !st.items.length) { closeMentionBox(); return; }
    box.innerHTML = st.items.map(function (e, i) {
      return '<button type="button" class="mention-item' + (i === st.active ? " active" : "") +
        '" data-mention-idx="' + i + '" role="option" aria-selected="' + (i === st.active ? "true" : "false") + '">' +
        avatarHtml(e, "sm") +
        '<span class="m-main"><span class="m-name">' + esc(e.name || "") + "</span>" +
        (e.title ? '<span class="m-title">' + esc(e.title) + "</span>" : "") + "</span></button>";
    }).join("");
    box.classList.remove("hidden");
  }
  function updateMentionBox(fromDelete) {
    var ta = $("messageInput");
    var box = $("mentionBox");
    if (!ta || !box || !state.me) { closeMentionBox(); return; }
    var ctx = mentionContext(ta);
    /* Xoá ngược tới khi chỉ còn "@" trơ trọi → đóng hộp (đúng yêu cầu đóng khi
       xoá hết phần gõ sau @); vừa gõ "@" mới thì mở danh sách đầy đủ. */
    if (!ctx || (fromDelete && ctx.query === "")) { closeMentionBox(); return; }
    var q = mentionFold(ctx.query);
    var items = state.employees.filter(function (e) {
      return e && !e.suspended && e.name && e.id !== state.me.id;
    }).filter(function (e) {
      return mentionFold(e.name).indexOf(q) >= 0;
    });
    items.sort(function (a, b) {
      var fa = mentionFold(a.name), fb = mentionFold(b.name);
      var sa = fa.indexOf(q) === 0 ? 0 : 1, sb = fb.indexOf(q) === 0 ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return fa < fb ? -1 : fa > fb ? 1 : 0;
    });
    items = items.slice(0, 8);
    if (!items.length) { closeMentionBox(); return; }
    var prev = state.mentionUI;
    state.mentionUI = {
      start: ctx.start,
      items: items,
      active: (prev && prev.start === ctx.start) ? Math.min(prev.active, items.length - 1) : 0
    };
    renderMentionBox();
  }
  function pickMention(idx) {
    var st = state.mentionUI;
    var ta = $("messageInput");
    if (!st || !ta) return;
    var item = st.items[idx == null ? st.active : idx];
    if (!item) return;
    var pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    if (pos < st.start) { closeMentionBox(); return; }
    var insert = "@" + item.name + " ";
    ta.value = ta.value.slice(0, st.start) + insert + ta.value.slice(pos);
    var caret = st.start + insert.length;
    closeMentionBox();
    ta.focus();
    try { ta.setSelectionRange(caret, caret); } catch (e) {}
  }
  function onMessageKeydown(ev) {
    var st = state.mentionUI;
    var box = $("mentionBox");
    if (!st || !box || box.classList.contains("hidden") || !st.items.length) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      st.active = (st.active + 1) % st.items.length;
      renderMentionBox();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      st.active = (st.active - 1 + st.items.length) % st.items.length;
      renderMentionBox();
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      pickMention(st.active);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeMentionBox();
    }
  }

  /* ---------- Công việc ---------- */
  function prioClass(p) {
    if (p === "Cao") return "prio p-Cao";
    if (p === "Thấp") return "prio p-Thap";
    return "prio p-TrungBinh";
  }
  function statusChipClass(s) {
    if (s === "Đang làm") return "status-chip s-doing";
    if (s === "Chờ duyệt") return "status-chip s-review";
    if (s === "Hoàn thành") return "status-chip s-done";
    return "status-chip";
  }
  /* Tên hiển thị của trạng thái — giá trị lưu trong Firestore giữ nguyên
     ("Chờ nhận") để không mồ côi việc cũ; chỉ đổi cách hiển thị:
     việc chưa xác nhận tuyệt đối không hiển thị thành "Đang làm". */
  function statusText(s) {
    if (s === "Chờ nhận") return "Đã gửi — chưa xác nhận";
    return s || "—";
  }
  function isOverdue(t) {
    if (!t || t.status === "Hoàn thành") return false;
    var ms = tsMillis(t.dueAt);
    return !!ms && ms < Date.now();
  }
  /* Phase 2 — quá hạn xác nhận nhận việc + thời gian chờ duyệt. Tất cả tính
     từ dữ liệu thật (createdAt / history.at); thiếu mốc thời gian thì không
     kết luận, không bịa. */
  function ageText(ms) {
    if (ms === null || ms === undefined || ms < 0) return "";
    var h = Math.floor(ms / 3600000);
    if (h < 1) return "dưới 1 giờ";
    if (h < 48) return h + " giờ";
    return Math.floor(h / 24) + " ngày";
  }
  function ackAgeMs(t) {
    var ms = tsMillis(t ? t.createdAt : null);
    return ms ? (Date.now() - ms) : null;
  }
  function isAckOverdue(t) {
    if (!t || t.status !== "Chờ nhận") return false;
    var age = ackAgeMs(t);
    if (age === null) return false;
    return age > (state.ackTimeoutHours || 24) * 3600 * 1000;
  }
  function ackOverdueTasks() {
    return state.tasks.filter(isAckOverdue);
  }
  function waitMs(t) {
    /* Thời gian chờ duyệt: từ lần cuối việc chuyển sang "Chờ duyệt" (ghi
       trong history), fallback về lúc tạo việc; thiếu cả hai thì null. */
    var hist = (t.history || []).slice().reverse();
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].to === "Chờ duyệt") {
        var ms = tsMillis(hist[i].at);
        if (ms) return Date.now() - ms;
      }
    }
    return ackAgeMs(t);
  }
  function dueChipHtml(t) {
    if (!t.dueAt) return "";
    if (isOverdue(t)) {
      return '<span class="due-chip overdue">Quá hạn · Hạn: ' + esc(fmtDate(t.dueAt)) + "</span>";
    }
    return '<span class="due-chip">Hạn: ' + esc(fmtDate(t.dueAt)) + "</span>";
  }
  function visibleTasks() {
    var list = state.tasks;
    if (state.taskFilter === "mine" && state.me) {
      list = list.filter(function (t) { return t.assigneeId === state.me.id; });
    } else if (state.taskFilter === "overdue") {
      list = list.filter(isOverdue);
    } else if (state.taskFilter === "ackoverdue") {
      list = list.filter(isAckOverdue);
    }
    /* Phase 4 — lọc nâng cao (kết hợp AND với lọc chính). Lưu ý: task chưa có
       trường dự án (guide định nghĩa roleInJob); lọc thứ ba dùng trường role
       thật ("Vai trò của job này") và được ghi nhãn đúng như vậy. */
    if (state.taskAssigneeFilter) list = list.filter(function (t) { return t.assigneeId === state.taskAssigneeFilter; });
    if (state.taskPrioFilter) list = list.filter(function (t) { return t.priority === state.taskPrioFilter; });
    if (state.taskRoleFilter) list = list.filter(function (t) { return t.role === state.taskRoleFilter; });
    return list;
  }
  function commentCount(t) { return (t.comments || []).length; }

  function renderAssigneeOptions() {
    var opts = state.employees.filter(function (e) { return !e.suspended; }).map(function (e) {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.title ? " — " + esc(e.title) : "") + "</option>";
    }).join("");
    ["taskAssignee", "msgTaskAssignee", "quickTaskAssignee"].forEach(function (id) {
      var sel = $(id);
      if (!sel) return;
      var current = sel.value;
      sel.innerHTML = opts;
      if (current) sel.value = current;
    });
  }

  /* Đổi trạng thái việc — điểm choke duy nhất cho đường bảng + Hộp duyệt.
     ctx: {reason, action, evidence, approvalId, historyNote}.
     Lịch sử thay đổi ghi bằng arrayUnion (chỉ thêm, không bao giờ ghi đè),
     mỗi sự kiện gồm người đổi, từ → sang, ghi chú, thời điểm. */
  function setTaskStatus(t, newStatus, ctx) {
    if (!db || !t) return Promise.resolve();
    ctx = ctx || {};
    var oldStatus = t.status || "";
    var ev = {
      actorId: state.me ? state.me.id : "",
      actorName: state.me ? state.me.name : "",
      from: oldStatus,
      to: newStatus,
      note: ctx.historyNote || "",
      at: firebase.firestore.Timestamp.now()
    };
    return db.collection("tasks").doc(t.id).update({
      status: newStatus, updatedAt: serverTimestamp(),
      history: firebase.firestore.FieldValue.arrayUnion(ev)
    }).then(function () {
      if (newStatus === "Hoàn thành") {
        logActivity("đã hoàn thành việc “" + (t.title || "") + "”", "task");
      } else {
        logActivity("đã chuyển việc “" + (t.title || "") + "” sang trạng thái " + newStatus, "task");
      }
      handleStatusSideEffects(t, oldStatus, newStatus, ctx);
    }).catch(function (e) { console.warn("update task status:", e); });
  }

  /* Xác nhận nhận việc — bước bắt buộc của người được giao khi việc còn ở
     "Đã gửi — chưa xác nhận". Không đi qua setTaskStatus để không bị lẫn
     với đổi trạng thái thường, nhưng vẫn ghi lịch sử + activity.
     Phase 4: ack chuyển sang "Đã nhận" (cột Kanban thứ 5 theo guide); assignee
     chuyển tiếp sang "Đang làm" khi bắt đầu làm. */
  function acknowledgeTask(t) {
    if (!db || !state.me || !t || state.me.id !== t.assigneeId) return;
    var ev = {
      actorId: state.me.id,
      actorName: state.me.name,
      from: "Chờ nhận",
      to: "Đã nhận",
      note: "Đã xác nhận nhận việc",
      at: firebase.firestore.Timestamp.now()
    };
    db.collection("tasks").doc(t.id).update({
      status: "Đã nhận", updatedAt: serverTimestamp(),
      history: firebase.firestore.FieldValue.arrayUnion(ev)
    }).then(function () {
      logActivity("đã xác nhận nhận việc “" + (t.title || "") + "”", "task");
    }).catch(function (e) { console.warn("acknowledge:", e); });
  }

  /* Chấm chỉ thị cột (mobile): bảng việc vuốt ngang snap từng cột, chấm cho biết đang ở cột nào */
  function renderBoardDots() {
    var dots = $("boardDots"), board = $("taskBoard");
    if (!dots || !board) return;
    var cols = board.querySelectorAll(".board-col");
    if (!cols.length) { dots.innerHTML = ""; return; }
    if (state.boardIdx > cols.length - 1) state.boardIdx = 0;
    var html = "";
    for (var i = 0; i < cols.length; i++) {
      html += '<button type="button" class="bdot' + (i === state.boardIdx ? " active" : "") +
        '" data-bdot="' + i + '" aria-label="Xem cột ' + (i + 1) + '"></button>';
    }
    dots.innerHTML = html;
  }
  function scrollBoardTo(idx) {
    var board = $("taskBoard");
    if (!board) return;
    var col = board.querySelector(".board-col");
    if (!col) return;
    board.scrollTo({ left: idx * (col.offsetWidth + 10), behavior: "smooth" });
  }

  function renderTasks() {
    var board = $("taskBoard");
    if (!board) return;
    var list = visibleTasks();
    var html = "";
    TASK_STATUSES.forEach(function (status) {
      var col = list.filter(function (t) { return t.status === status; });
      html += '<div class="board-col" data-col="' + esc(status) + '"><h3>' + esc(statusText(status)) +
        ' <span class="chip count">' + col.length + "</span></h3>";
      if (!col.length) html += '<p class="col-empty">Không có việc nào.</p>';
      col.forEach(function (t) {
        var opts = TASK_STATUSES.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === t.status ? " selected" : "") + ">" + esc(statusText(s)) + "</option>";
        }).join("");
        var needsAck = !!(state.me && state.me.id === t.assigneeId && t.status === "Chờ nhận");
        html += '<div class="task-card' + (isOverdue(t) ? " overdue" : "") + '" data-task-id="' + esc(t.id) + '" draggable="true">' +
          '<div class="t-title">' + esc(t.title || "") + "</div>" +
          (t.description ? '<div class="t-desc">' + esc(t.description) + "</div>" : "") +
          '<div class="t-tags"><span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + "</span>" +
            dueChipHtml(t) +
            (t.role ? '<span class="chip role">' + esc(t.role) + "</span>" : "") +
            (t.sensitive ? '<span class="chip" style="border-color:#FEDF89">⚠ Quan trọng</span>' : "") +
            '<button class="chip" type="button" data-taskopen="' + esc(t.id) + '" style="cursor:pointer">Bình luận: ' + commentCount(t) + "</button></div>" +
          '<div class="t-meta">Phụ trách: <b>' + esc(empName(t.assigneeId)) + "</b> · Giao bởi: " + esc(empName(t.assignerId)) +
          (t.updatedAt ? " · Cập nhật: " + esc(fmtTime(t.updatedAt)) : "") + "</div>" +
          (needsAck
            ? '<div class="row"><span class="chip">Đã gửi — chưa xác nhận</span>' +
              (isAckOverdue(t) ? '<span class="chip" style="border-color:#FECDC2;color:#b3261e">Quá hạn xác nhận · chờ ' + esc(ageText(ackAgeMs(t))) + '</span>' : "") +
              '<button class="btn primary small" type="button" data-ack="' + esc(t.id) + '">Xác nhận nhận việc</button></div>'
            : '<div class="row"><span>Trạng thái:</span><select class="task-status">' + opts + "</select></div>") +
          '<div class="t-note-label">Ghi chú kết quả</div>' +
          '<textarea class="task-note" rows="2" placeholder="Ghi chú kết quả...">' + esc(t.resultNote || "") + "</textarea>" +
          '<div class="row"><button class="btn ghost small task-note-save" type="button">Lưu ghi chú</button>' +
          '<button class="btn ghost small" type="button" data-taskopen="' + esc(t.id) + '">Chi tiết &amp; bình luận</button></div>' +
        "</div>";
      });
      html += "</div>";
    });
    board.innerHTML = html;

    board.querySelectorAll(".task-card").forEach(function (card) {
      var id = card.getAttribute("data-task-id");
      var sel = card.querySelector(".task-status");
      if (sel) sel.addEventListener("change", function () {
        var t = null;
        state.tasks.forEach(function (x) { if (x.id === id) t = x; });
        setTaskStatus(t || { id: id, title: "" }, sel.value);
      });
      var saveBtn = card.querySelector(".task-note-save");
      saveBtn.addEventListener("click", function () {
        var note = card.querySelector(".task-note").value;
        saveBtn.disabled = true;
        db.collection("tasks").doc(id).update({
          resultNote: note, updatedAt: serverTimestamp()
        }).then(function () { saveBtn.disabled = false; })
          .catch(function (e) { console.warn("update task note:", e); saveBtn.disabled = false; });
      });
    });
    renderBoardDots();
    renderKanbanChips();
    applyKanbanColFilter();
    renderTaskAdvFilters();
    if (state.taskView === "tree") {
      board.classList.add("hidden");
      renderTaskTree();
    } else {
      board.classList.remove("hidden");
      var tt = $("taskTree");
      if (tt) tt.classList.add("hidden");
    }
    wireKanbanDrag(board);
  }

  function dateInputToTimestamp(val) {
    if (!val) return null;
    var parts = val.split("-");
    if (parts.length !== 3) return null;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 23, 59, 59);
    return firebase.firestore.Timestamp.fromDate(d);
  }
  function timestampToDateInput(ts) {
    var ms = tsMillis(ts);
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function onCreateTask(ev) {
    ev.preventDefault();
    if (!canManage() || !db) return;
    var errBox = $("taskError");
    errBox.classList.add("hidden");
    var title = $("taskTitle").value.trim();
    var assignee = $("taskAssignee").value;
    var jobRole = $("taskRole") ? $("taskRole").value.trim() : "";
    if (!title) return;
    if (!assignee) {
      errBox.textContent = "Chưa có nhân viên nào để giao việc. Hãy đăng ký hồ sơ nhân viên trước.";
      errBox.classList.remove("hidden");
      return;
    }
    var due = dateInputToTimestamp($("taskDue").value);
    db.collection("tasks").add({
      title: title,
      description: $("taskDesc").value.trim(),
      assigneeId: assignee,
      assignerId: state.me.id,
      status: "Chờ nhận",
      priority: $("taskPriority").value,
      role: jobRole,
      sensitive: $("taskSensitive") ? $("taskSensitive").checked : false,
      resultNote: "",
      dueAt: due,
      comments: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }).then(function () {
      $("taskTitle").value = "";
      $("taskDesc").value = "";
      $("taskDue").value = "";
      if ($("taskRole")) $("taskRole").value = "";
      if ($("taskSensitive")) $("taskSensitive").checked = false;
      logActivity("đã tạo việc “" + title + "” giao cho " + empName(assignee), "task");
    }).catch(function (e) {
      errBox.textContent = "Tạo công việc thất bại. Vui lòng thử lại.";
      errBox.classList.remove("hidden");
      console.warn("create task:", e);
    });
  }

  /* ----- Modal chi tiết việc + bình luận ----- */
  function findTask(id) {
    for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === id) return state.tasks[i];
    return null;
  }
  function openTask(id) {
    state.taskModalId = id;
    renderTaskBody();
    $("taskModal").classList.remove("hidden");
  }
  function closeTask() {
    state.taskModalId = null;
    $("taskModal").classList.add("hidden");
  }
  function renderTaskModalIfOpen() {
    if (!state.taskModalId) return;
    var ae = document.activeElement;
    if (ae && (ae.id === "tmCommentInput" || ae.id === "tmNote" || ae.id === "tmRole")) return;
    if (!findTask(state.taskModalId)) { closeTask(); return; }
    renderTaskBody();
  }
  function renderTaskBody() {
    var t = findTask(state.taskModalId);
    var box = $("taskBody");
    if (!t || !box) return;
    var comments = (t.comments || []).slice().sort(function (a, b) {
      return (tsMillis(a.createdAt) || 0) - (tsMillis(b.createdAt) || 0);
    });
    var statusOpts = TASK_STATUSES.map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === t.status ? " selected" : "") + ">" + esc(statusText(s)) + "</option>";
    }).join("");
    var commentsHtml = comments.length ? comments.map(function (c) {
      return '<div class="comment-item"><div class="c-head"><b>' + esc(c.authorName || "") + "</b> · " +
        esc(fmtTime(c.createdAt)) + '</div><div class="c-body">' + esc(c.content || "") + "</div></div>";
    }).join("") : '<p class="hint">Chưa có bình luận nào.</p>';
    var needsAckModal = !!(state.me && state.me.id === t.assigneeId && t.status === "Chờ nhận");
    var histHtml = (t.history || []).length
      ? (t.history || []).slice().reverse().map(function (h) {
          return '<div class="comment-item"><div class="c-head"><b>' + esc(h.actorName || "") + "</b> · " +
            esc(fmtTime(h.at)) + '</div><div class="c-body">' + esc(statusText(h.from)) + " → " + esc(statusText(h.to)) +
            (h.note ? " — " + esc(h.note) : "") + "</div></div>";
        }).join("")
      : '<p class="hint">Chưa có lịch sử (việc tạo trước khi bật lịch sử).</p>';

    box.innerHTML =
      '<div class="profile-head"><div><div class="p-name" style="font-size:1.2rem">' + esc(t.title || "") + "</div>" +
      '<div class="p-chips"><span class="' + statusChipClass(t.status) + '">' + esc(statusText(t.status)) + "</span>" +
      '<span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + "</span>" + dueChipHtml(t) + "</div></div></div>" +
      "<dl>" +
        "<dt>Phụ trách</dt><dd>" + esc(empName(t.assigneeId)) + "</dd>" +
        "<dt>Người giao</dt><dd>" + esc(empName(t.assignerId)) + "</dd>" +
        "<dt>Vai trò của job</dt><dd>" + (t.role ? esc(t.role) : "— (dùng vai trò hồ sơ)") + "</dd>" +
        "<dt>Hạn hoàn thành</dt><dd>" + (t.dueAt ? esc(fmtDate(t.dueAt)) : "Chưa đặt") + "</dd>" +
        "<dt>Tạo lúc</dt><dd>" + esc(fmtTime(t.createdAt)) + "</dd>" +
        "<dt>Cập nhật</dt><dd>" + esc(fmtTime(t.updatedAt)) + "</dd>" +
      "</dl>" +
      (t.description ? "<h3>Mô tả</h3><div style='white-space:pre-wrap;word-break:break-word'>" + esc(t.description) + "</div>" : "") +
      "<h3>Cập nhật việc</h3>" +
      (needsAckModal
        ? '<div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="chip">Đã gửi — chưa xác nhận</span>' +
          (isAckOverdue(t) ? '<span class="chip" style="border-color:#FECDC2;color:#b3261e">Quá hạn xác nhận · chờ ' + esc(ageText(ackAgeMs(t))) + '</span>' : "") +
          '<button class="btn primary small" type="button" data-ack="' + esc(t.id) + '">Xác nhận nhận việc</button></div>'
        : "") +
      '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
        (needsAckModal ? "" :
        '<div style="flex:1;min-width:150px"><label for="tmStatus" style="margin-top:0">Trạng thái</label><select id="tmStatus">' + statusOpts + "</select></div>") +
        '<div style="flex:1;min-width:150px"><label for="tmDue" style="margin-top:0">Hạn hoàn thành</label><input type="date" id="tmDue" value="' + esc(timestampToDateInput(t.dueAt)) + '"></div>' +
        '<div style="flex:1;min-width:150px"><label for="tmRole" style="margin-top:0">Vai trò của job</label><input type="text" id="tmRole" value="' + esc(t.role || "") + '" placeholder="VD: QA, Editor…"></div>' +
      "</div>" +
      '<label style="display:block;margin-top:8px"><input type="checkbox" id="tmSensitive"' + (t.sensitive ? " checked" : "") + '> Việc quan trọng — cần kiểm tra riêng khi duyệt</label>' +
      '<label for="tmNote">Ghi chú kết quả</label>' +
      '<textarea id="tmNote" rows="2" placeholder="Ghi chú kết quả...">' + esc(t.resultNote || "") + "</textarea>" +
      '<div style="margin-top:10px"><button class="btn primary small" type="button" id="tmSave">Lưu thay đổi</button> ' +
      '<span id="tmMsg" class="ok-text hidden">Đã lưu.</span> <span id="tmErr" class="hidden" style="color:#b3261e"></span></div>' +
      "<h3>Lịch sử thay đổi</h3>" +
      histHtml +
      "<h3>Bình luận (" + comments.length + ")</h3>" +
      '<div id="tmComments">' + commentsHtml + "</div>" +
      '<div class="comment-form"><textarea id="tmCommentInput" rows="2" placeholder="Viết bình luận..."></textarea>' +
      '<button class="btn primary" type="button" id="tmCommentBtn">Gửi</button></div>';

    $("tmSave").addEventListener("click", function () {
      var statusEl = $("tmStatus");
      var newStatus = statusEl ? statusEl.value : t.status;
      var noteVal = $("tmNote").value;
      var roleVal = $("tmRole") ? $("tmRole").value.trim() : "";
      var sensVal = $("tmSensitive") ? $("tmSensitive").checked : !!t.sensitive;
      var statusChanged = newStatus !== t.status;
      /* Chốt hoàn thành phải ghi lý do — Ghi chú kết quả chính là lý do. */
      if (statusChanged && newStatus === "Hoàn thành" && !noteVal.trim()) {
        var er = $("tmErr");
        if (er) { er.textContent = "Chốt hoàn thành cần ghi lý do vào Ghi chú kết quả."; er.classList.remove("hidden"); }
        return;
      }
      var patch = {
        resultNote: noteVal,
        role: roleVal,
        sensitive: sensVal,
        dueAt: dateInputToTimestamp($("tmDue").value),
        updatedAt: serverTimestamp()
      };
      if (statusChanged) {
        patch.status = newStatus;
        patch.history = firebase.firestore.FieldValue.arrayUnion({
          actorId: state.me ? state.me.id : "",
          actorName: state.me ? state.me.name : "",
          from: t.status || "",
          to: newStatus,
          note: newStatus === "Hoàn thành" ? noteVal.trim() : "",
          at: firebase.firestore.Timestamp.now()
        });
      }
      db.collection("tasks").doc(t.id).update(patch).then(function () {
        var msg = $("tmMsg");
        if (msg) { msg.classList.remove("hidden"); setTimeout(function () { msg.classList.add("hidden"); }, 2000); }
        var er2 = $("tmErr");
        if (er2) er2.classList.add("hidden");
        if (statusChanged) {
          if (newStatus === "Hoàn thành") logActivity("đã hoàn thành việc “" + (t.title || "") + "”", "task");
          else logActivity("đã chuyển việc “" + (t.title || "") + "” sang trạng thái " + newStatus, "task");
          handleStatusSideEffects(t, t.status, newStatus, { evidence: noteVal.trim() });
        }
      }).catch(function (e) { console.warn("task modal save:", e); });
    });
    $("tmCommentBtn").addEventListener("click", function () {
      var input = $("tmCommentInput");
      var content = input.value.trim();
      if (!content || !state.me) return;
      var comment = {
        authorId: state.me.id,
        authorName: state.me.name,
        content: content,
        createdAt: firebase.firestore.Timestamp.now()
      };
      input.value = "";
      db.collection("tasks").doc(t.id).update({
        comments: firebase.firestore.FieldValue.arrayUnion(comment),
        updatedAt: serverTimestamp()
      }).catch(function (e) { console.warn("add comment:", e); input.value = content; });
    });
  }

  /* ---------- Tổng quan ---------- */
  function openTasksOf(id) {
    return state.tasks.filter(function (t) {
      return t.assigneeId === id && t.status !== "Hoàn thành";
    }).length;
  }
  function relText(ts) {
    var r = fmtRel(ts);
    return r === "vừa xong" ? r : r + " trước";
  }

  function renderOverview() {
    if (!$("statTotal")) return;
    var active = state.employees.filter(function (e) {
      return !e.suspended && presenceOf(e).online;
    }).length;
    var doing = state.tasks.filter(function (t) { return t.status !== "Hoàn thành"; }).length;
    var done = state.tasks.filter(function (t) { return t.status === "Hoàn thành"; }).length;
    $("statTotal").textContent = String(state.employees.length);
    $("statActive").textContent = String(active);
    $("statDoing").textContent = String(doing);
    $("statDone").textContent = String(done);
    renderHighlightCards();
    renderTaskStatusCounts();

    /* Phase 2 — banner cảnh báo quá hạn xác nhận (chỉ quản lý thấy, chỉ hiện
       khi có việc thật quá hạn; số liệu từ dữ liệu thật, không bịa). */
    var ackBanner = $("ackOverdueBanner");
    if (ackBanner) {
      var ao = canManage() ? ackOverdueTasks() : [];
      if (ao.length) {
        ackBanner.innerHTML = '<div class="card" style="padding:10px 12px;border-color:#FECDC2">⚠ Có <b>' + ao.length + '</b> việc quá hạn xác nhận (chưa xác nhận quá ' + (state.ackTimeoutHours || 24) + ' giờ). Xem tab Công việc, lọc “Quá hạn xác nhận”.</div>';
        ackBanner.classList.remove("hidden");
      } else {
        ackBanner.innerHTML = "";
        ackBanner.classList.add("hidden");
      }
    }

    var grid = $("overviewGrid");
    var overviewEmps = state.employees.filter(function (e) { return e.level !== "Giám đốc"; });
    if (!overviewEmps.length) {
      grid.innerHTML = '<p class="hint">Chưa có hồ sơ nhân viên nào.</p>';
    } else {
      grid.innerHTML = overviewEmps.map(function (e) {
        var p = presenceOf(e);
        return '<div class="emp-card clickable" data-profile="' + esc(e.id) + '">' +
          '<div class="e-head">' + avatarHtml(e) +
            "<div><div class=\"e-name\">" + esc(e.name || "") + "</div>" +
            '<div class="e-title">' + esc(e.title || "") + "</div></div>" +
            '<span class="' + p.dot + '" style="margin-left:auto"></span>' +
          "</div>" +
          '<div class="e-chips">' +
            '<span class="chip level">' + esc(e.level || "") + "</span>" +
            (e.role ? '<span class="chip role">' + esc(e.role) + "</span>" : "") +
            (e.suspended ? '<span class="chip susp">Tạm ngưng</span>' : checkChipHtml(e)) +
          "</div>" +
          (function () {
            var pr = presOf(e.id);
            var wk = (pr && pr.currentWork) || e.currentWork || "—";
            var pct = pr ? presProgressPct(pr) : null;
            var h = '<div class="e-work">Đang làm: ' + esc(wk) + "</div>";
            if (pct !== null) h += '<div class="pbar"><div style="width:' + pct + '%"></div></div>';
            if (pr && pr.blocker) h += '<div class="e-blocker">Kẹt: ' + esc(pr.blocker) + "</div>";
            return h;
          })() +
          '<div class="e-foot"><span>Việc đang mở: <b>' + openTasksOf(e.id) + "</b></span>" +
            "<span>" + esc(p.label) + (p.sub ? " · " + esc(p.sub) : "") + "</span></div>" +
        "</div>";
      }).join("");
    }
    renderPresence();
    renderHealth();
    renderRightRail();
  }

  /* Dải hiện diện ngang: avatar + chấm trạng thái + tên + trạng thái + việc đang làm,
     người trực tuyến xếp trước. Bấm vào từng người để mở hồ sơ chi tiết. */
  function renderPresence() {
    var box = $("presenceList");
    if (!box) return;
    if (!state.employees.length) {
      box.innerHTML = '<p class="hint" style="padding:10px 0">Chưa có nhân viên nào.</p>';
      return;
    }
    var list = state.employees.slice().sort(function (a, b) {
      var pa = presenceOf(a), pb = presenceOf(b);
      if (pa.online !== pb.online) return pa.online ? -1 : 1;
      var am = lastActivityOf(a), bm = lastActivityOf(b);
      return (bm ? bm.ms : 0) - (am ? am.ms : 0);
    });
    box.innerHTML = list.map(function (e) {
      var p = presenceOf(e);
      return '<div class="pstrip-item clickable" data-profile="' + esc(e.id) + '">' +
        '<div class="pstrip-av">' + avatarHtml(e) +
          '<span class="pstrip-dot ' + p.dot + '"></span></div>' +
        '<div class="pstrip-name">' + esc(e.name || "") + "</div>" +
        '<div class="pstrip-state' + (p.online ? " on" : "") + '">' + esc(p.label) + "</div>" +
        (p.sub ? '<div class="pstrip-sub">' + esc(p.sub) + "</div>" : "") +
        (function () { var pr = presOf(e.id); return '<div class="pstrip-work">' + esc((pr && pr.currentWork) || e.currentWork || "—") + "</div>"; })() +
      "</div>";
    }).join("");
  }

  /* Phase 2 — retry có giới hạn cho các lượt ĐỌC Firestore (tối đa 3 lần,
     chờ tăng dần). Chỉ dùng cho đọc: ghi vẫn 1 lần để tránh ghi trùng
     (history arrayUnion có timestamp nên retry ghi sẽ tạo 2 sự kiện). */
  function getWithRetry(query, attempts) {
    attempts = attempts || 3;
    function attempt(n) {
      return query.get().catch(function (e) {
        if (n < attempts) {
          return new Promise(function (res) { setTimeout(res, n * 600); }).then(function () { return attempt(n + 1); });
        }
        throw e;
      });
    }
    return attempt(1);
  }

  /* Phase 2 — khối hồ sơ duyệt đã quyết trong hộp duyệt. Vẽ lại từ state
     mỗi lần renderApproval chạy nên không mất khi bảng việc tải lại; dữ
     liệu gốc nằm ở collection approvals (bền vững qua tải lại trang). */
  function renderApprovalHistoryBlock() {
    var h = '<div style="margin-top:14px">' +
      '<h3 style="margin:0 0 4px">Hồ sơ đã quyết</h3>' +
      '<p class="hint" style="margin-top:0">Hồ sơ phê duyệt đã có quyết định, tải trực tiếp từ collection approvals — không phụ thuộc trạng thái việc hiện tại.</p>' +
      '<div style="margin-bottom:8px"><button class="btn primary small" type="button" id="apHistoryBtn">Tải hồ sơ đã quyết</button> ' +
      '<span id="apHistoryStatus" class="hint">' +
      (state.approvalsHistoryLoading ? "Đang tải…" :
        (state.approvalsHistoryLoaded ? "Đã tải " + state.approvalsHistory.length + " hồ sơ đã quyết." : "")) +
      "</span></div>" +
      '<div id="apHistoryList">';
    if (!state.approvalsHistoryLoaded) {
      h += '<p class="hint">Chưa tải — bấm nút để tải.</p>';
    } else if (!state.approvalsHistory.length) {
      h += '<p class="hint">Chưa có hồ sơ duyệt đã quyết.</p>';
    } else {
      h += state.approvalsHistory.map(function (a) {
        return '<div class="activity-item"><span class="a-actor">' + esc(a.decidedByName || "") + "</span>" +
          "<span>" + esc(a.decision === "Duyệt" ? "Đã duyệt" : "Đã trả lại") + " việc “" + esc(a.taskTitle || "") + "”" +
          (a.assigneeName ? " (phụ trách: " + esc(a.assigneeName) + ")" : "") +
          " — lý do: " + esc(a.reason ? a.reason : "không ghi lý do") +
          " — bằng chứng: " + esc(a.evidence ? a.evidence : "không kèm bằng chứng") + "</span>" +
          '<span class="a-time">' + esc(relText(a.decidedAt)) + "</span></div>";
      }).join("");
    }
    h += "</div></div>";
    return h;
  }
  function loadApprovalsHistory() {
    if (!db || state.approvalsHistoryLoading) return;
    state.approvalsHistoryLoading = true;
    renderApproval();
    /* Không lọc bằng where ở server để khỏi cần composite index: lấy 50 hồ
       sơ mới nhất theo decidedAt rồi lọc quyết định đã xong ở máy khách.
       decidedAt null (hồ sơ chờ) xếp cuối khi orderBy desc nên không lấn
       chỗ của hồ sơ đã quyết. */
    getWithRetry(db.collection("approvals").orderBy("decidedAt", "desc").limit(50)).then(function (snap) {
      state.approvalsHistory = snap.docs.map(function (d) {
        var o = d.data(); o.id = d.id; return o;
      }).filter(function (a) { return a.status && a.status !== "pending"; });
      state.approvalsHistoryLoaded = true;
      state.approvalsHistoryLoading = false;
      renderApproval();
    }).catch(function (e) {
      state.approvalsHistoryLoading = false;
      renderApproval();
      var st = $("apHistoryStatus");
      if (st) st.textContent = "Tải thất bại — có thể Firestore Rules chưa mở collection “approvals”. Thử lại sau.";
      console.warn("load approvals history:", e);
    });
  }

  /* Hộp duyệt (phase 1, kiểu Inbox): việc Chờ duyệt, mỗi mục là 1 hồ sơ
     phê duyệt riêng. Mỗi mục có ô lý do (bắt buộc) + ô bằng chứng +
     nút Duyệt / Trả lại. KHÔNG có nút duyệt tất cả vô điều kiện:
     duyệt lô chỉ áp dụng cho các mục đã tick và cùng mức ưu tiên, mỗi mục
     có kết quả độc lập và được báo riêng. Agent không được tự phê duyệt
     việc của chính mình. Việc quan trọng (sensitive) không duyệt lô được
     mà phải duyệt riêng từng mục kèm tick kiểm tra riêng. */
  function showApprovalError(text) {
    var el = $("apError");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }
  function hideApprovalError() {
    var el = $("apError");
    if (el) el.classList.add("hidden");
  }
  function renderApproval() {
    var sec = $("approvalSection"), box = $("approvalList");
    if (!sec || !box) return;
    if (!canApprove()) {
      sec.classList.add("hidden");
      box.innerHTML = "";
      var dh0 = $("duyetStaffHint");
      if (dh0) dh0.classList.remove("hidden");
      return;
    }
    var dh = $("duyetStaffHint");
    if (dh) dh.classList.add("hidden");
    var list = state.tasks.filter(function (t) { return t.status === "Chờ duyệt"; });
    /* Phase 2 — inbox bền vững: quản lý luôn thấy hộp duyệt (kể cả khi hàng
       chờ rỗng) + hồ sơ đã quyết tải từ collection approvals. */
    sec.classList.remove("hidden");
    var html = "";
    if (list.length) {
      var waits = list.map(waitMs).filter(function (x) { return x !== null; });
      var oldest = waits.length ? ageText(Math.max.apply(null, waits)) : "chưa rõ thời gian chờ";
      html += '<p class="hint">Hàng chờ: <b>' + list.length + '</b> mục · chờ lâu nhất: <b>' + esc(oldest) + '</b> (tính từ lúc việc chuyển sang “Chờ duyệt”).</p>';
      html +=
      '<p class="hint">Mỗi mục là một hồ sơ phê duyệt riêng (người duyệt, thời điểm, kết quả từng mục được lưu riêng). Không có nút duyệt tất cả vô điều kiện.</p>' +
      '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">' +
        '<label style="margin:0;white-space:nowrap"><input type="checkbox" id="apSelectAll"> Chọn tất cả</label>' +
        '<input type="text" id="apBatchReason" placeholder="Lý do chung cho các mục đã chọn (bắt buộc)" style="flex:1;min-width:200px">' +
        '<input type="text" id="apBatchEvidence" placeholder="Bằng chứng chung (không bắt buộc)" style="flex:1;min-width:200px">' +
        '<button class="btn primary small" type="button" id="apBatchBtn">Duyệt các mục đã chọn</button>' +
      "</div>" +
      '<p class="hint" style="margin-top:0">Duyệt lô chỉ áp dụng cho các mục cùng mức ưu tiên; mỗi mục có kết quả độc lập, báo riêng từng mục. Việc quan trọng không duyệt lô được.</p>' +
      '<p id="apBatchResult" class="hidden"></p>' +
      '<p id="apError" class="hidden" style="color:#b3261e"></p>';
    html += list.map(function (t) {
      return '<div class="approval-item">' +
        '<input type="checkbox" class="apBatchCheck" data-batch="' + esc(t.id) + '" title="Chọn để duyệt lô">' +
        '<div class="ap-title">' + esc(t.title || "") +
        '<div class="ap-meta">Phụ trách: ' + esc(empName(t.assigneeId)) + " · Giao bởi: " + esc(empName(t.assignerId)) +
        (t.role ? " · Vai trò job: " + esc(t.role) : "") + " · Ưu tiên: " + esc(t.priority || "Trung bình") + "</div>" +
        (t.sensitive ? '<div class="ap-meta" style="color:#b3261e">⚠ Việc quan trọng — cần kiểm tra riêng, chỉ duyệt riêng từng mục</div>' : "") +
        "</div>" +
        '<div style="flex:1;min-width:220px">' +
          '<input type="text" id="apReason-' + esc(t.id) + '" placeholder="Lý do duyệt / trả lại (bắt buộc)">' +
          '<input type="text" id="apEvidence-' + esc(t.id) + '" placeholder="Bằng chứng / căn cứ (không bắt buộc)" style="margin-top:6px">' +
          (t.sensitive ? '<label style="display:block;margin-top:6px"><input type="checkbox" id="apSensCheck-' + esc(t.id) + '"> Tôi đã kiểm tra riêng việc này</label>' : "") +
        "</div>" +
        '<button class="btn primary small" type="button" data-approve="' + esc(t.id) + '">Duyệt — Hoàn thành</button>' +
        '<button class="btn ghost small" type="button" data-return="' + esc(t.id) + '">Trả lại — Đang làm</button></div>';
    }).join("");
    } else {
      html += '<p class="hint">Không có mục chờ duyệt.</p>';
    }
    html += renderApprovalHistoryBlock();
    box.innerHTML = html;
    var selAll = $("apSelectAll");
    if (selAll) selAll.addEventListener("change", function () {
      var checks = box.querySelectorAll(".apBatchCheck");
      for (var i = 0; i < checks.length; i++) checks[i].checked = selAll.checked;
    });
    var batchBtn = $("apBatchBtn");
    if (batchBtn) batchBtn.addEventListener("click", runBatchApprove);
    var histBtn = $("apHistoryBtn");
    if (histBtn) histBtn.addEventListener("click", loadApprovalsHistory);
  }

  /* Quyết định 1 mục: chặn tự phê duyệt, chặn duyệt việc quan trọng khi
     chưa tick kiểm tra riêng, lý do bắt buộc. */
  function decideOne(t, decision) {
    if (!state.me) return;
    if (state.me.id === t.assigneeId) {
      showApprovalError("Không được tự phê duyệt việc của chính mình (“" + (t.title || "") + "”).");
      return;
    }
    var rin = $("apReason-" + t.id);
    var ein = $("apEvidence-" + t.id);
    var reason = rin ? rin.value.trim() : "";
    var evidence = ein ? ein.value.trim() : "";
    if (!reason) {
      showApprovalError((decision === "Duyệt" ? "Duyệt" : "Trả lại") + " cần ghi lý do cho việc “" + (t.title || "") + "”.");
      if (rin) rin.focus();
      return;
    }
    if (t.sensitive && decision === "Duyệt") {
      var chk = $("apSensCheck-" + t.id);
      if (!chk || !chk.checked) {
        showApprovalError("Việc quan trọng “" + (t.title || "") + "” cần bước kiểm tra riêng: hãy tick “Tôi đã kiểm tra riêng việc này” trước khi duyệt.");
        return;
      }
    }
    hideApprovalError();
    var target = decision === "Duyệt" ? "Hoàn thành" : "Đang làm";
    ensureApprovalDoc(t).then(function (approvalId) {
      return setTaskStatus(t, target, { reason: reason, action: decision, evidence: evidence, approvalId: approvalId, historyNote: decision + " — lý do: " + reason }).then(function () { return approvalId; });
    }).then(function (approvalId) {
      return finalizeApproval(approvalId, decision, reason, evidence, "");
    }).catch(function (e) { console.warn("decide one:", e); });
  }

  /* Duyệt lô có kiểm soát: chỉ các mục đã tick + cùng mức ưu tiên, mỗi mục
     kết quả độc lập, báo cáo riêng từng mục — không bao giờ báo cả lô
     thành công khi có mục thất bại. */
  function runBatchApprove() {
    var box = $("approvalList");
    if (!box || !state.me) return;
    var checked = box.querySelectorAll(".apBatchCheck:checked");
    var tasks = [];
    for (var i = 0; i < checked.length; i++) {
      var t = findTask(checked[i].getAttribute("data-batch"));
      if (t) tasks.push(t);
    }
    if (!tasks.length) { showApprovalError("Chưa chọn mục nào để duyệt lô."); return; }
    var prios = [];
    tasks.forEach(function (t) {
      var p = t.priority || "Trung bình";
      if (prios.indexOf(p) === -1) prios.push(p);
    });
    if (prios.length > 1) {
      showApprovalError("Duyệt lô chỉ áp dụng cho các mục cùng mức ưu tiên. Các mục đã chọn gồm: " + prios.join(", ") + ". Hãy chọn lại các mục cùng một mức.");
      return;
    }
    var reasonEl = $("apBatchReason"), evEl = $("apBatchEvidence");
    var reason = reasonEl ? reasonEl.value.trim() : "";
    var evidence = evEl ? evEl.value.trim() : "";
    if (!reason) { showApprovalError("Duyệt lô cần ghi lý do chung."); if (reasonEl) reasonEl.focus(); return; }
    hideApprovalError();
    var btn = $("apBatchBtn");
    if (btn) btn.disabled = true;
    var batchId = "batch_" + Date.now();
    var results = [];
    var chain = Promise.resolve();
    tasks.forEach(function (t) {
      chain = chain.then(function () {
        if (state.me.id === t.assigneeId) { results.push({ t: t, ok: false, cause: "không được tự phê duyệt" }); return; }
        if (t.sensitive) { results.push({ t: t, ok: false, cause: "việc quan trọng — cần duyệt riêng từng mục" }); return; }
        return ensureApprovalDoc(t).then(function (approvalId) {
          return setTaskStatus(t, "Hoàn thành", { reason: reason, action: "Duyệt", evidence: evidence, approvalId: approvalId, historyNote: "Duyệt theo lô — lý do: " + reason }).then(function () { return approvalId; });
        }).then(function (approvalId) {
          return finalizeApproval(approvalId, "Duyệt", reason, evidence, batchId);
        }).then(function () {
          results.push({ t: t, ok: true });
        }).catch(function () {
          results.push({ t: t, ok: false, cause: "lỗi ghi dữ liệu" });
        });
      });
    });
    chain.then(function () {
      if (btn) { btn.disabled = false; if (document.activeElement === btn && btn.blur) btn.blur(); }
      renderApproval();
      var ok = 0, fail = [];
      results.forEach(function (r) { if (r.ok) ok++; else fail.push(r); });
      var resEl = $("apBatchResult");
      if (resEl) {
        var html = "Kết quả duyệt lô: " + ok + " thành công, " + fail.length + " thất bại.";
        if (fail.length) html += "<br>" + fail.map(function (f) { return "• " + esc(f.t.title || "") + ": " + esc(f.cause); }).join("<br>");
        if (fail.length === 0 && ok === results.length && ok > 0) html += "<br>Tất cả các mục đã chọn đều duyệt thành công.";
        resEl.innerHTML = html;
        resEl.classList.remove("hidden");
      }
    });
  }

  function renderActivities() {
    var box = $("activityList");
    if (!box) return;
    if (!state.activities.length) {
      box.innerHTML = '<p class="hint" style="padding:10px 0">Chưa có hoạt động nào được ghi nhận.</p>';
      return;
    }
    box.innerHTML = state.activities.map(function (a) {
      return '<div class="activity-item"><span class="a-actor">' + esc(a.actorName || "") + "</span>" +
        "<span>" + esc(a.text || "") + "</span>" +
        '<span class="a-time">' + esc(relText(a.createdAt)) + "</span></div>";
    }).join("");
  }

  /* ---------- Nhật ký quyết định (phase 1) ----------
     KHÔNG dùng onSnapshot: chỉ tải 1 lần khi bấm nút (get + limit 50),
     để không cộng thêm lượt đọc thường trực vào quota Firestore gói miễn phí. */
  function decisionActionText(action) {
    if (action === "Duyệt") return "đã duyệt";
    if (action === "Trả lại") return "đã trả lại";
    if (action === "Hoàn thành") return "đã hoàn thành";
    if (action === "Trình duyệt") return "đã trình duyệt";
    return action || "—";
  }
  function renderDecisions() {
    var box = $("decisionsList"), st = $("decisionsStatus");
    if (!box) return;
    if (!state.decisions.length) {
      box.innerHTML = '<p class="hint" style="padding:10px 0">Chưa có quyết định nào được ghi nhận.</p>';
      if (st) st.textContent = state.decisionsLoaded ? "Đã tải: 0 quyết định." : "";
      return;
    }
    box.innerHTML = state.decisions.map(decisionItemHtml).join("");
    if (st) st.textContent = "Đã tải " + state.decisions.length + " quyết định mới nhất.";
    renderDecisionsLog();
  }
  function loadDecisions() {
    if (!db || state.decisionsLoading) return;
    state.decisionsLoading = true;
    var st = $("decisionsStatus");
    if (st) st.textContent = "Đang tải…";
    getWithRetry(db.collection("decisions").orderBy("createdAt", "desc").limit(50)).then(function (snap) {
      state.decisions = snap.docs.map(function (d) {
        var o = d.data(); o.id = d.id; return o;
      });
      state.decisionsLoaded = true;
      state.decisionsLoading = false;
      renderDecisions();
    }).catch(function (e) {
      state.decisionsLoading = false;
      if (st) st.textContent = "Tải thất bại — có thể Firestore Rules chưa mở collection “decisions”. Thử lại sau.";
      console.warn("load decisions:", e);
    });
  }

  /* ---------- Sơ đồ tổ chức ---------- */
  function orgNodeHtml(e, maps) {
    var kids = maps.children[e.id] || [];
    var collapsed = !!state.collapsedOrg[e.id];
    var html = '<li><div class="org-node clickable" data-profile="' + esc(e.id) + '">' +
      '<span class="o-dot"><span class="' + statusDot(e) + '"></span></span>' +
      avatarHtml(e) +
      '<div class="o-name">' + esc(e.name || "") + "</div>" +
      '<div class="o-title">' + esc(e.title || "") + "</div>" +
      '<div class="o-chips"><span class="chip level">' + esc(e.level || "") + "</span>" +
      (e.role ? '<span class="chip role">' + esc(e.role) + "</span>" : "") +
      (e.suspended ? '<span class="chip susp">Tạm ngưng</span>' : checkChipHtml(e)) +
      "</div>" +
      (kids.length
        ? '<button class="toggle-btn" type="button" data-collapse-org="' + esc(e.id) + '" aria-label="Thu gọn hoặc mở rộng nhánh">' + (collapsed ? "+" : "−") + "</button>"
        : "") +
      "</div>";
    if (kids.length && !collapsed) {
      html += "<ul>" + kids.map(function (k) { return orgNodeHtml(k, maps); }).join("") + "</ul>";
    }
    return html + "</li>";
  }
  function renderOrgTree() {
    var box = $("orgTreeWrap");
    if (!box) return;
    if (!state.employees.length) {
      box.innerHTML = '<p class="hint">Chưa có dữ liệu tổ chức.</p>';
      return;
    }
    var maps = orgMaps();
    box.innerHTML = '<div class="org-tree"><ul>' +
      maps.roots.map(function (r) { return orgNodeHtml(r, maps); }).join("") +
      "</ul></div>";
  }

  /* ---------- Tab Nhân viên: cây + quản trị ---------- */
  function tvNodeHtml(e, maps) {
    var kids = maps.children[e.id] || [];
    var collapsed = !!state.collapsedTv[e.id];
    var p = presenceOf(e);
    var html = '<li><div class="tv-node clickable" data-profile="' + esc(e.id) + '">' +
      (kids.length
        ? '<button class="tv-toggle" type="button" data-collapse-tv="' + esc(e.id) + '" aria-label="Thu gọn hoặc mở rộng">' + (collapsed ? "+" : "−") + "</button>"
        : '<span style="width:28px;flex:0 0 auto"></span>') +
      avatarHtml(e, "sm") +
      '<span class="n-name">' + esc(e.name || "") + "</span>" +
      (e.title ? '<span class="n-title">' + esc(e.title) + "</span>" : "") +
      '<span class="chip level">' + esc(e.level || "") + "</span>" +
      (e.role ? '<span class="chip role">' + esc(e.role) + "</span>" : "") +
      (kids.length ? '<span class="n-kids">' + kids.length + " cấp dưới</span>" : "") +
      '<span class="spacer">' +
        (e.suspended ? '<span class="chip susp">Tạm ngưng</span>' : checkChipHtml(e)) +
        '<span class="' + p.dot + '"></span>' +
        '<span class="muted" style="font-size:.88rem">' + esc(p.label) + "</span>" +
      "</span></div>";
    if (kids.length && !collapsed) {
      html += '<ul class="tv">' + kids.map(function (k) { return tvNodeHtml(k, maps); }).join("") + "</ul>";
    }
    return html + "</li>";
  }
  function renderEmpTree() {
    var box = $("empTreeWrap");
    if (!box) return;
    if (!state.employees.length) {
      box.innerHTML = '<p class="hint">Chưa có nhân viên nào.</p>';
      return;
    }
    var maps = orgMaps();
    box.innerHTML = '<ul class="tv root">' +
      maps.roots.map(function (r) { return tvNodeHtml(r, maps); }).join("") +
      "</ul>";
  }

  function renderEmpAdmin() {
    var box = $("empAdminList");
    if (!box) return;
    if (!state.employees.length) {
      box.innerHTML = '<p class="hint">Chưa có hồ sơ nhân viên nào.</p>';
      return;
    }
    var director = isDirector();
    box.innerHTML = state.employees.map(function (e) {
      var mgr = e.managerId ? empById(e.managerId) : null;
      var act = lastActivityOf(e);
      var actions = '<div class="a-actions">' +
        '<button class="btn ghost small" type="button" data-profile="' + esc(e.id) + '">Xem hồ sơ</button>';
      if (director) {
        actions += '<button class="btn ghost small" type="button" data-emp-edit="' + esc(e.id) + '">Sửa thông tin</button>' +
          '<button class="btn ghost small" type="button" data-emp-reset="' + esc(e.id) + '">Đặt lại mã truy cập</button>' +
          '<button class="btn ghost small" type="button" data-emp-suspend="' + esc(e.id) + '">' +
          (e.suspended ? "Kích hoạt lại" : "Tạm ngưng") + "</button>";
      }
      actions += "</div>";
      return '<div class="admin-item">' +
        '<div class="a-head">' + avatarHtml(e) +
          "<div><span class=\"a-name\">" + esc(e.name || "") + "</span>" +
          '<div class="a-title">' + esc(e.title || "") + "</div></div>" +
          '<span class="chip level">' + esc(e.level || "") + "</span>" +
          (e.role ? '<span class="chip role">' + esc(e.role) + "</span>" : "") +
          (e.suspended ? '<span class="chip susp">Tạm ngưng</span>' : checkChipHtml(e)) +
          '<span class="' + statusDot(e) + '" style="margin-left:auto"></span>' +
          '<span class="muted" style="font-size:.9rem">' + esc(presenceOf(e).label) + "</span>" +
        "</div>" +
        "<dl>" +
          "<dt>Đang làm</dt><dd>" + esc(e.currentWork || "—") + "</dd>" +
          "<dt>Cấp trên</dt><dd>" + (mgr ? esc(mgr.name) : "— (cấp cao nhất)") + "</dd>" +
          "<dt>Tài khoản Muse</dt><dd>" + esc(e.accountLabel || "—") + "</dd>" +
          "<dt>Hồ sơ trình duyệt</dt><dd>" + esc(e.browserProfile || "—") + "</dd>" +
          "<dt>Email đăng nhập</dt><dd>" + esc(e.loginEmail || "—") + "</dd>" +
          "<dt>Mã truy cập</dt><dd>Chỉ cấp qua kênh chính thức, không hiển thị tại đây</dd>" +
          "<dt>Hoạt động gần nhất</dt><dd>" + (act ? esc(fmtTime(act.ts)) + " (" + esc(fmtRel(act.ts)) + " trước)" : "Chưa từng vào phòng họp") + "</dd>" +
          "<dt>Kích hoạt</dt><dd>" + (e.provisioning === "pending" ? "Chờ mở trình duyệt (provisioning: pending)" : "Đã kích hoạt") + "</dd>" +
        "</dl>" +
        actions +
      "</div>";
    }).join("");
  }

  function managerOptionsHtml(excludeId, selectedId) {
    var html = '<option value="">— Không có (cấp cao nhất) —</option>';
    state.employees.forEach(function (e) {
      if (excludeId && e.id === excludeId) return;
      html += '<option value="' + esc(e.id) + '"' + (e.id === selectedId ? " selected" : "") + ">" +
        esc(e.name) + (e.title ? " — " + esc(e.title) : "") + "</option>";
    });
    return html;
  }
  function fillManagerOptions() {
    var sel = $("empManager");
    if (!sel) return;
    var editingId = $("empId").value || null;
    var current = sel.value;
    sel.innerHTML = managerOptionsHtml(editingId, current || "");
    if (current && current !== editingId) sel.value = current;
  }
  function renderEmployeesTab() {
    renderEmpTree();
    renderEmpAdmin();
    renderEmpStatsGrid();
    fillManagerOptions();
  }

  /* ----- Đăng ký / sửa nhân viên (chỉ Giám đốc) ----- */
  function genAccessCode() {
    var chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var out = "";
    for (var i = 0; i < 6; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }
  function slugify(name) {
    var s = String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/đ/g, "d").replace(/Đ/g, "d");
    s = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s;
  }
  function showEmpError(text) {
    var e = $("empFormError");
    e.textContent = text;
    e.classList.remove("hidden");
    $("empFormSuccess").classList.add("hidden");
  }
  function showEmpSuccess(html) {
    var s = $("empFormSuccess");
    s.innerHTML = html;
    s.classList.remove("hidden");
    $("empFormError").classList.add("hidden");
  }
  function resetEmpForm() {
    $("empForm").reset();
    $("empId").value = "";
    $("empFormTitle").textContent = "Đăng ký nhân viên mới";
    $("empSubmitBtn").textContent = "Đăng ký nhân viên";
    $("empCancelEdit").classList.add("hidden");
    fillManagerOptions();
  }

  /* Tạo tài khoản Auth bằng app phụ để Giám đốc không bị đăng xuất */
  function createAuthAccount(email, password) {
    var appName = "secondary-" + Date.now();
    var secApp;
    try {
      secApp = firebase.initializeApp(cfg, appName);
    } catch (e) {
      return Promise.reject(e);
    }
    return secApp.auth().createUserWithEmailAndPassword(email, password)
      .then(function () {
        return secApp.auth().signOut().catch(function () {});
      })
      .then(function () { return secApp.delete(); })
      .catch(function (err) {
        return secApp.delete().catch(function () {}).then(function () { throw err; });
      });
  }
  function registerErrorText(err) {
    var code = (err && err.code) || "";
    if (code === "auth/email-already-in-use") return "Email đăng nhập này đã tồn tại trên hệ thống. Hãy đổi tên nhân viên hoặc kiểm tra lại danh sách.";
    if (code === "auth/weak-password") return "Mã truy cập không đạt yêu cầu mật khẩu của hệ thống.";
    if (code === "auth/invalid-email") return "Email đăng nhập sinh ra không hợp lệ. Hãy kiểm tra lại tên nhân viên.";
    if (code === "auth/network-request-failed") return "Lỗi mạng khi tạo tài khoản. Vui lòng thử lại.";
    return "Đăng ký thất bại. Vui lòng thử lại sau.";
  }

  function onEmpSubmit(ev) {
    ev.preventDefault();
    if (!isDirector() || !db) return;
    $("empFormError").classList.add("hidden");
    $("empFormSuccess").classList.add("hidden");
    var editingId = $("empId").value || null;
    var name = $("empName").value.trim();
    if (!name) { showEmpError("Tên nhân viên là bắt buộc."); return; }
    var fields = {
      name: name,
      title: $("empTitle").value.trim() || $("empLevel").value,
      level: $("empLevel").value,
      role: $("empRole").value.trim(),
      managerId: $("empManager").value || null,
      accountLabel: $("empAccountLabel").value.trim(),
      browserProfile: $("empBrowserProfile").value.trim()
    };
    if (editingId && fields.managerId === editingId) {
      showEmpError("Nhân viên không thể là cấp trên của chính mình.");
      return;
    }
    var btn = $("empSubmitBtn");

    if (editingId) {
      btn.disabled = true;
      var patch = {};
      Object.keys(fields).forEach(function (k) { patch[k] = fields[k]; });
      patch.updatedAt = serverTimestamp();
      db.collection("employees").doc(editingId).update(patch)
        .then(function () {
          resetEmpForm();
          showEmpSuccess("Đã cập nhật hồ sơ của <b>" + esc(name) + "</b>.");
          btn.disabled = false;
        })
        .catch(function (e) {
          console.warn("update employee:", e);
          showEmpError("Cập nhật thất bại. Vui lòng thử lại.");
          btn.disabled = false;
        });
      return;
    }

    /* Đăng ký mới */
    var code = genAccessCode();
    var base = slugify(name) || "nhan-vien";
    var used = {};
    state.employees.forEach(function (e) {
      if (e.loginEmail) used[String(e.loginEmail).toLowerCase()] = true;
    });
    var email = base + "@aicompany.app";
    var n = 2;
    while (used[email]) {
      email = base + "-" + n + "@aicompany.app";
      n++;
    }
    btn.disabled = true;
    btn.textContent = "Đang đăng ký...";
    createAuthAccount(email, code)
      .then(function () {
        return db.collection("employees").add({
          name: fields.name,
          title: fields.title,
          level: fields.level,
          role: fields.role,
          managerId: fields.managerId,
          loginEmail: email,
          accessCode: code,
          accountLabel: fields.accountLabel,
          browserProfile: fields.browserProfile,
          status: "Ngoại tuyến",
          currentWork: "Chờ kết nối tài khoản",
          provisioning: "pending",
          color: PALETTE[state.employees.length % PALETTE.length],
          createdAt: serverTimestamp()
        });
      })
      .then(function () {
        logActivity("đã đăng ký nhân viên mới " + fields.name + " (" + email + ")", "employee");
        resetEmpForm();
        showEmpSuccess(
          "Đã đăng ký nhân viên <b>" + esc(fields.name) + "</b>.<br>" +
          "Email đăng nhập: <b class=\"mono\">" + esc(email) + "</b><br>" +
          "Mã truy cập (dùng làm mật khẩu đăng nhập): <b class=\"mono\">" + esc(code) + "</b><br>" +
          "Hồ sơ đang ở trạng thái <b>Chờ kích hoạt</b> — hệ thống phía sau sẽ mở hồ sơ trình duyệt cho tài khoản Muse của nhân viên này."
        );
        btn.disabled = false;
        btn.textContent = "Đăng ký nhân viên";
      })
      .catch(function (err) {
        console.warn("register employee:", err);
        showEmpError(registerErrorText(err));
        btn.disabled = false;
        btn.textContent = "Đăng ký nhân viên";
      });
  }

  function startEditEmployee(id) {
    var e = empById(id);
    if (!e) return;
    $("empId").value = e.id;
    $("empName").value = e.name || "";
    $("empTitle").value = e.title || "";
    $("empLevel").value = LEVELS.indexOf(e.level) >= 0 ? e.level : "Nhân viên";
    $("empRole").value = e.role || "";
    $("empAccountLabel").value = e.accountLabel || "";
    $("empBrowserProfile").value = e.browserProfile || "";
    fillManagerOptions();
    $("empManager").value = e.managerId || "";
    $("empFormTitle").textContent = "Sửa thông tin nhân viên";
    $("empSubmitBtn").textContent = "Lưu thay đổi";
    $("empCancelEdit").classList.remove("hidden");
    $("empFormError").classList.add("hidden");
    $("empFormSuccess").classList.add("hidden");
    $("empFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleSuspend(id) {
    var e = empById(id);
    if (!e || !isDirector() || !db) return;
    db.collection("employees").doc(id).update({ suspended: !e.suspended })
      .catch(function (err) { console.warn("toggle suspend:", err); });
  }
  function resetAccessCode(id) {
    var e = empById(id);
    if (!e || !isDirector() || !db) return;
    var code = genAccessCode();
    db.collection("employees").doc(id).update({ accessCode: code })
      .then(function () {
        showEmpSuccess(
          "Đã đặt lại mã truy cập cho <b>" + esc(e.name || "") + "</b>: mã mới <b class=\"mono\">" + esc(code) + "</b>.<br>" +
          "Lưu ý: mật khẩu đăng nhập hiện tại vẫn là mã cũ cho tới khi tài khoản được cấp lại."
        );
        $("empFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function (err) { console.warn("reset access code:", err); });
  }

  /* ---------- Hồ sơ chi tiết (modal) ---------- */
  function openProfile(id) {
    state.profileId = id;
    renderProfile();
    $("profileModal").classList.remove("hidden");
  }
  function closeProfile() {
    state.profileId = null;
    $("profileModal").classList.add("hidden");
  }
  function renderProfile() {
    var box = $("profileBody");
    if (!box) return;
    var e = empById(state.profileId);
    if (!e) {
      box.innerHTML = '<p class="hint">Không tìm thấy hồ sơ nhân viên.</p>';
      return;
    }
    var maps = orgMaps();
    var mgr = e.managerId ? empById(e.managerId) : null;
    var subs = maps.children[e.id] || [];
    var myTasks = state.tasks.filter(function (t) { return t.assigneeId === e.id; });
    var open = myTasks.filter(function (t) { return t.status !== "Hoàn thành"; }).length;
    var done = myTasks.filter(function (t) { return t.status === "Hoàn thành"; }).length;
    var given = state.tasks.filter(function (t) { return t.assignerId === e.id; }).length;
    var sent = state.messages.filter(function (m) { return m.senderId === e.id; }).length;
    /* Phase 1 — thống kê thật từ dữ liệu đã nạp, không số liệu giả: */
    var openTasks = myTasks.filter(function (t) { return t.status !== "Hoàn thành"; });
    var jobRoles = [];
    myTasks.forEach(function (t) { if (t.role && jobRoles.indexOf(t.role) === -1) jobRoles.push(t.role); });
    var reviewCount = myTasks.filter(function (t) { return t.status === "Chờ duyệt"; }).length;
    var unackedCount = myTasks.filter(function (t) { return t.status === "Chờ nhận"; }).length;
    var ackOverdueCount = myTasks.filter(isAckOverdue).length;
    var avgAckMs = avgAckMsFor(e.id);
    var commentCount = 0;
    state.tasks.forEach(function (t) { (t.comments || []).forEach(function (c) { if (c.authorId === e.id) commentCount++; }); });
    var p = presenceOf(e);
    var act = lastActivityOf(e);

    var subsHtml = subs.length
      ? '<div class="sub-list">' + subs.map(function (s) {
          return '<button class="sub-item" type="button" data-profile="' + esc(s.id) + '">' +
            avatarHtml(s, "sm") + esc(s.name || "") + "</button>";
        }).join("") + "</div>"
      : '<p class="hint">Không có cấp dưới.</p>';

    var tasksHtml = myTasks.length
      ? myTasks.map(function (t) {
          return '<div class="mini-task"><span class="mt-title">' + esc(t.title || "") + "</span>" +
            (t.role ? '<span class="chip role">' + esc(t.role) + "</span>" : "") +
            '<span class="' + statusChipClass(t.status) + '">' + esc(statusText(t.status)) + "</span>" +
            '<span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + "</span>" +
            '<button class="link-btn" type="button" data-taskopen="' + esc(t.id) + '" style="margin-left:auto">Mở việc</button></div>';
        }).join("")
      : '<p class="hint">Chưa được giao việc nào.</p>';

    /* Ô sửa luật làm việc: chỉ Giám đốc / Phó giám đốc thấy. */
    var guidanceEditHtml = "";
    if (canManage()) {
      guidanceEditHtml = '<div style="margin-top:8px"><textarea id="guidanceInput" rows="3" placeholder="Luật làm việc của nhân viên này, ví dụ: chỉ nhận việc có mô tả rõ, báo cáo mỗi tối…">' + esc(e.guidance || "") + "</textarea>" +
        '<div style="margin-top:8px"><button class="btn primary small" type="button" id="guidanceSave">Lưu luật làm việc</button> ' +
        '<span id="guidanceMsg" class="ok-text hidden">Đã lưu.</span></div></div>';
    }

    box.innerHTML =
      '<div class="profile-head">' + avatarHtml(e, "lg") +
        "<div><div class=\"p-name\">" + esc(e.name || "") + "</div>" +
        '<div class="p-title">' + esc(e.title || "") + "</div>" +
        '<div class="p-chips"><span class="chip level">' + esc(e.level || "") + "</span>" +
        (e.role ? '<span class="chip role">' + esc(e.role) + "</span>" : "") +
        '<span class="chip"><span class="' + p.dot + '" style="box-shadow:none"></span>' + esc(p.label) + "</span>" +
        (e.suspended ? '<span class="chip susp">Tạm ngưng</span>' : checkChipHtml(e)) +
        "</div></div></div>" +
      "<dl>" +
        "<dt>Chức vụ</dt><dd>" + esc(e.title || "—") + "</dd>" +
        "<dt>Cấp bậc</dt><dd>" + esc(e.level || "—") + "</dd>" +
        "<dt>Vai trò</dt><dd>" + esc(e.role || "—") + "</dd>" +
        "<dt>Vai trò theo job hiện tại</dt><dd>" + (jobRoles.length
          ? jobRoles.map(function (r) { return '<span class="chip role">' + esc(r) + "</span>"; }).join(" ")
          : "Chưa gắn vai trò theo job — dùng vai trò hồ sơ: " + esc(e.role || "—")) + "</dd>" +
        "<dt>Luật làm việc</dt><dd>" + (e.guidance
          ? "<div style='white-space:pre-wrap;word-break:break-word'>" + esc(e.guidance) + "</div>"
          : "chưa có dữ liệu") + guidanceEditHtml + "</dd>" +
        "<dt>Kiểm tra phòng gần nhất</dt><dd>" + (e.lastCheckAt
          ? esc(fmtTime(e.lastCheckAt)) + " (" + esc(fmtRel(e.lastCheckAt)) + " trước)"
          : "Chưa từng kiểm tra") + "</dd>" +
        "<dt>Chi phí / chuyển đổi</dt><dd>chưa có dữ liệu</dd>" +
        "<dt>Hiện diện</dt><dd>" + esc(p.label) + (p.sub ? " · " + esc(p.sub) : "") + "</dd>" +
        "<dt>Đang làm</dt><dd>" + esc(e.currentWork || "—") + "</dd>" +
        "<dt>Độ trễ ack trung bình</dt><dd>" + (avgAckMs === null ? "chưa có dữ liệu" : ageText(avgAckMs)) + "</dd>" +
        "<dt>Cấp trên</dt><dd>" + (mgr
          ? '<button class="link-btn" type="button" data-profile="' + esc(mgr.id) + '">' + esc(mgr.name) + "</button>"
          : "— Cấp cao nhất") + "</dd>" +
        "<dt>Hoạt động gần nhất</dt><dd>" + (act
          ? esc(fmtTime(act.ts)) + " (" + esc(fmtRel(act.ts)) + " trước)"
          : "Chưa từng vào phòng họp") + "</dd>" +
        "<dt>Trạng thái kiểm tra</dt><dd>" + (e.suspended ? "Đang tạm ngưng" : esc(checkInfo(e).text)) + "</dd>" +
        "<dt>Kích hoạt</dt><dd>" + (e.provisioning === "pending" ? "Chờ mở trình duyệt (provisioning: pending)" : "Đã kích hoạt") + "</dd>" +
        "<dt>Tài khoản Muse</dt><dd>" + esc(e.accountLabel || "—") + "</dd>" +
        "<dt>Hồ sơ trình duyệt</dt><dd>" + esc(e.browserProfile || "—") + "</dd>" +
        "<dt>Email đăng nhập</dt><dd>" + esc(e.loginEmail || "—") + "</dd>" +
        "<dt>Mã truy cập</dt><dd>Chỉ cấp qua kênh chính thức, không hiển thị tại đây</dd>" +
      "</dl>" +
      '<div class="profile-stats">' +
        '<div class="ps"><b>' + open + "</b><span>Việc đang mở</span></div>" +
        '<div class="ps"><b>' + done + "</b><span>Việc hoàn thành</span></div>" +
        '<div class="ps"><b>' + given + "</b><span>Việc đã giao</span></div>" +
        '<div class="ps"><b>' + sent + "</b><span>Tin đã gửi</span></div>" +
        '<div class="ps"><b>' + reviewCount + "</b><span>Việc chờ duyệt</span></div>" +
        '<div class="ps"><b>' + unackedCount + "</b><span>Chưa xác nhận</span></div>" +
        '<div class="ps"><b>' + ackOverdueCount + "</b><span>Quá hạn xác nhận</span></div>" +
        '<div class="ps"><b>' + commentCount + "</b><span>Bình luận đã gửi</span></div>" +
      "</div>" +
      "<h3>Cấp dưới (" + subs.length + ")</h3>" + subsHtml +
      "<h3>Công việc được giao (" + myTasks.length + ")</h3>" + tasksHtml;

    var gSave = $("guidanceSave");
    if (gSave) gSave.addEventListener("click", function () {
      var val = $("guidanceInput") ? $("guidanceInput").value.trim() : "";
      db.collection("employees").doc(e.id).update({ guidance: val }).then(function () {
        var m = $("guidanceMsg");
        if (m) { m.classList.remove("hidden"); setTimeout(function () { m.classList.add("hidden"); }, 2000); }
        renderProfile();
      }).catch(function (err) { console.warn("save guidance:", err); });
    });
  }

  /* ---------- Cài đặt ---------- */
  function onSaveInterval() {
    if (!isDirector() || !db) return;
    var n = parseInt($("intervalInput").value, 10);
    var msg = $("intervalMsg");
    msg.classList.add("hidden");
    if (isNaN(n) || n < 1 || n > 240) {
      msg.textContent = "Số phút phải từ 1 đến 240.";
      msg.style.color = "var(--danger)";
      msg.classList.remove("hidden");
      return;
    }
    db.collection("settings").doc("room").set({ checkIntervalMinutes: n }, { merge: true })
      .then(function () {
        msg.textContent = "Đã lưu: tất cả nhân viên phải kiểm tra phòng họp mỗi " + n + " phút.";
        msg.style.color = "var(--ok)";
        msg.classList.remove("hidden");
      })
      .catch(function (e) {
        msg.textContent = "Lưu thất bại. Vui lòng thử lại.";
        msg.style.color = "var(--danger)";
        msg.classList.remove("hidden");
        console.warn("save interval:", e);
      });
  }

  /* Phase 2 — lưu ngưỡng quá hạn xác nhận (giờ), mirror onSaveInterval. */
  function onSaveAckTimeout() {
    if (!isDirector() || !db) return;
    var n = parseInt($("ackTimeoutInput").value, 10);
    var msg = $("ackTimeoutMsg");
    msg.classList.add("hidden");
    if (isNaN(n) || n < 1 || n > 168) {
      msg.textContent = "Số giờ phải từ 1 đến 168.";
      msg.style.color = "var(--danger)";
      msg.classList.remove("hidden");
      return;
    }
    db.collection("settings").doc("room").set({ ackTimeoutHours: n }, { merge: true })
      .then(function () {
        state.ackTimeoutHours = n;
        msg.textContent = "Đã lưu: việc quá " + n + " giờ chưa xác nhận sẽ bị đánh dấu quá hạn xác nhận.";
        msg.style.color = "var(--ok)";
        msg.classList.remove("hidden");
        renderOverview(); renderBell(); renderTasks();
      })
      .catch(function (e) {
        msg.textContent = "Lưu thất bại. Vui lòng thử lại.";
        msg.style.color = "var(--danger)";
        msg.classList.remove("hidden");
        console.warn("save ack timeout:", e);
      });
  }

  function onChangePassword() {
    var errBox = $("passwordError");
    var msg = $("passwordMsg");
    errBox.classList.add("hidden");
    msg.classList.add("hidden");
    var np = $("newPassword").value;
    var cf = $("confirmPassword").value;
    function fail(text) {
      errBox.textContent = text;
      errBox.classList.remove("hidden");
    }
    if (!np || np.length < 6) { fail("Mật khẩu mới phải có ít nhất 6 ký tự."); return; }
    if (np !== cf) { fail("Hai ô mật khẩu chưa khớp nhau."); return; }
    if (!state.user) { fail("Phiên đăng nhập đã hết. Hãy đăng nhập lại."); return; }
    state.user.updatePassword(np)
      .then(function () {
        $("newPassword").value = "";
        $("confirmPassword").value = "";
        msg.textContent = "Đổi mật khẩu thành công.";
        msg.classList.remove("hidden");
      })
      .catch(function (err) {
        if (err && err.code === "auth/requires-recent-login") {
          fail("Vì lý do bảo mật, hãy đăng xuất rồi đăng nhập lại trước khi đổi mật khẩu.");
        } else if (err && err.code === "auth/weak-password") {
          fail("Mật khẩu quá yếu. Hãy chọn mật khẩu mạnh hơn.");
        } else {
          fail("Đổi mật khẩu thất bại. Vui lòng thử lại.");
        }
      });
  }

  /* ==================================================================
     BẢO MẬT XÁC MINH ADMIN — 2FA cho riêng tài khoản Giám đốc
     - TOTP RFC 6238 (HMAC-SHA-1, cửa sổ 30s, lệch ±1 cửa sổ)
     - Bí mật TOTP mã hoá PBKDF2-SHA256 (210.000 vòng) + AES-GCM bằng mật khẩu
       Giám đốc, lưu trong settings/security (directorTotpEnc) — không lưu thô
     - 10 mã khôi phục dùng 1 lần, chỉ lưu SHA-256 hash (recoveryHashes)
     - Mã QR tự sinh trong file (không tải thư viện ngoài)
     ================================================================== */

  /* === 2FA-CORE-BEGIN === */
  var subtleCrypto = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle)
    ? globalThis.crypto : null;

  function bytesToB64(bytes) {
    var ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += ALPH[(b0 >> 2) & 63] + ALPH[((b0 << 4) | (b1 >> 4)) & 63] +
        (i + 1 < bytes.length ? ALPH[((b1 << 2) | (b2 >> 6)) & 63] : "=") +
        (i + 2 < bytes.length ? ALPH[b2 & 63] : "=");
    }
    return out;
  }
  function b64ToBytes(b64) {
    var ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var s = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
    var out = [];
    for (var i = 0; i + 3 < s.length + 1 && i < s.length; i += 4) {
      var c0 = ALPH.indexOf(s[i]), c1 = ALPH.indexOf(s[i + 1]);
      var c2 = s[i + 2] === "=" ? 0 : ALPH.indexOf(s[i + 2]);
      var c3 = s[i + 3] === "=" ? 0 : ALPH.indexOf(s[i + 3]);
      out.push(((c0 << 2) | (c1 >> 4)) & 255);
      if (s[i + 2] !== "=" && s[i + 2] !== undefined) out.push(((c1 << 4) | (c2 >> 2)) & 255);
      if (s[i + 3] !== "=" && s[i + 3] !== undefined) out.push(((c2 << 6) | c3) & 255);
    }
    return new Uint8Array(out);
  }

  /* ----- Base32 (RFC 4648) ----- */
  var B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32Encode(bytes) {
    var out = "", val = 0, bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { out += B32_ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32_ALPHABET[(val << (5 - bits)) & 31];
    return out;
  }
  function base32Decode(str) {
    var s = String(str || "").toUpperCase().replace(/[\s=]/g, "");
    var out = [], val = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var idx = B32_ALPHABET.indexOf(s.charAt(i));
      if (idx < 0) continue;
      val = (val << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  /* ----- TOTP (RFC 6238, HMAC-SHA-1) ----- */
  function hmacSha1(keyBytes, msgBytes) {
    return subtleCrypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
      .then(function (key) { return subtleCrypto.subtle.sign("HMAC", key, msgBytes); })
      .then(function (sig) { return new Uint8Array(sig); });
  }
  function totpAt(secretBytes, counter) {
    var msg = new Uint8Array(8);
    var c = counter;
    for (var i = 7; i >= 0; i--) { msg[i] = c % 256; c = Math.floor(c / 256); }
    return hmacSha1(secretBytes, msg).then(function (mac) {
      var off = mac[mac.length - 1] & 0x0f;
      var bin = ((mac[off] & 0x7f) << 24) | ((mac[off + 1] & 0xff) << 16) |
        ((mac[off + 2] & 0xff) << 8) | (mac[off + 3] & 0xff);
      var code = bin % 1000000;
      return ("00000" + code).slice(-6);
    });
  }
  function totpVerify(secretBytes, code, dateMs) {
    var want = String(code || "").replace(/\D/g, "");
    if (want.length !== 6) return Promise.resolve(false);
    var counter = Math.floor((dateMs == null ? Date.now() : dateMs) / 30000);
    var offsets = [-1, 0, 1], i = 0;
    function next() {
      if (i >= offsets.length) return Promise.resolve(false);
      var off = offsets[i++];
      return totpAt(secretBytes, counter + off).then(function (gen) {
        return gen === want ? true : next();
      });
    }
    return next();
  }

  /* ----- Mã hoá bí mật bằng mật khẩu: PBKDF2-SHA256 + AES-GCM ----- */
  var TFA_ITERATIONS = 210000;
  function tfaDeriveKey(password, saltBytes, iterations) {
    return subtleCrypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return subtleCrypto.subtle.deriveKey(
          { name: "PBKDF2", salt: saltBytes, iterations: iterations, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }
  function tfaEncryptSecret(password, secretText) {
    var salt = subtleCrypto.getRandomValues(new Uint8Array(16));
    var iv = subtleCrypto.getRandomValues(new Uint8Array(12));
    return tfaDeriveKey(password, salt, TFA_ITERATIONS).then(function (key) {
      return subtleCrypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(String(secretText)));
    }).then(function (ct) {
      return {
        v: 1, kdf: "PBKDF2-SHA256", iter: TFA_ITERATIONS,
        salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct))
      };
    });
  }
  function tfaDecryptSecret(password, payload) {
    if (!payload || !payload.salt || !payload.iv || !payload.data) {
      return Promise.reject(new Error("directorTotpEnc thiếu trường dữ liệu"));
    }
    return tfaDeriveKey(password, b64ToBytes(payload.salt), payload.iter || TFA_ITERATIONS)
      .then(function (key) {
        return subtleCrypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(payload.iv) }, key, b64ToBytes(payload.data));
      })
      .then(function (pt) { return new TextDecoder().decode(pt); });
  }

  /* ----- Mã khôi phục: chỉ lưu SHA-256 hash ----- */
  function sha256Hex(text) {
    return subtleCrypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)))
      .then(function (h) {
        var b = new Uint8Array(h), s = "";
        for (var i = 0; i < b.length; i++) s += ("0" + b[i].toString(16)).slice(-2);
        return s;
      });
  }
  var RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; /* bỏ 0/O/1/I/L tránh nhầm */
  function genRecoveryCode() {
    var chars = [];
    while (chars.length < 8) {
      var rnd = subtleCrypto.getRandomValues(new Uint8Array(16));
      for (var i = 0; i < rnd.length && chars.length < 8; i++) {
        if (rnd[i] < 248) chars.push(RECOVERY_ALPHABET[rnd[i] % RECOVERY_ALPHABET.length]); /* 248 = 31*8, chống lệch modulo */
      }
    }
    return chars.slice(0, 4).join("") + "-" + chars.slice(4, 8).join("");
  }
  function normalizeRecovery(code) {
    return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function hashRecovery(code) {
    return sha256Hex(normalizeRecovery(code));
  }

  function otpauthUrl(secretB32, accountEmail) {
    return "otpauth://totp/Enteesee:" + encodeURIComponent(String(accountEmail || "")) +
      "?secret=" + secretB32 + "&issuer=Enteesee";
  }

  /* ----- Sinh mã QR (byte mode, mức sửa lỗi M, version 1–10) — tự cài đặt ----- */
  var QR_GEXP = new Array(512), QR_GLOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { QR_GEXP[i] = x; QR_GLOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) QR_GEXP[j] = QR_GEXP[j - 255];
  })();
  function qrGmul(a, b) { return (a && b) ? QR_GEXP[QR_GLOG[a] + QR_GLOG[b]] : 0; }
  function qrRsGenPoly(nsym) {
    var poly = [1];
    for (var i = 0; i < nsym; i++) {
      var next = new Array(poly.length + 1), k;
      for (k = 0; k < next.length; k++) next[k] = 0;
      for (k = 0; k < poly.length; k++) {
        next[k] ^= qrGmul(poly[k], QR_GEXP[i]);
        next[k + 1] ^= poly[k];
      }
      poly = next;
    }
    return poly;
  }
  function qrRsEc(dataBytes, nsym) {
    var gen = qrRsGenPoly(nsym);
    var work = dataBytes.slice();
    var i, j;
    for (i = 0; i < nsym; i++) work.push(0);
    for (i = 0; i < dataBytes.length; i++) {
      var coef = work[i];
      if (coef === 0) continue;
      for (j = 0; j < gen.length; j++) work[i + j] ^= qrGmul(gen[j], coef);
    }
    return work.slice(dataBytes.length);
  }
  /* Bảng khối mức M: [ecPerBlock, [số codeword dữ liệu mỗi block]] */
  var QR_M_BLOCKS = {
    1: [10, [16]], 2: [16, [28]], 3: [26, [44]], 4: [18, [32, 32]], 5: [24, [43, 43]],
    6: [16, [27, 27, 27, 27]], 7: [18, [31, 31, 31, 31]], 8: [22, [38, 38, 39, 39]],
    9: [22, [36, 36, 36, 37, 37]], 10: [26, [43, 43, 43, 43, 44]]
  };
  var QR_ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  function qrBchDigit(data) { var d = 0; while (data !== 0) { d++; data >>>= 1; } return d; }
  function qrFormatInfo(ecBits, mask) {
    var data = (ecBits << 3) | mask;
    var d = data << 10, g = 0x537;
    while (qrBchDigit(d) - qrBchDigit(g) >= 0) d ^= (g << (qrBchDigit(d) - qrBchDigit(g)));
    return ((data << 10) | d) ^ 0x5412;
  }
  function qrVersionInfo(version) {
    var d = version << 12, g = 0x1f25;
    while (qrBchDigit(d) - qrBchDigit(g) >= 0) d ^= (g << (qrBchDigit(d) - qrBchDigit(g)));
    return (version << 12) | d;
  }
  function qrDataCodewords(bytes, version) {
    var spec = QR_M_BLOCKS[version];
    var totalData = 0, i;
    spec[1].forEach(function (n) { totalData += n; });
    var bits = [], bitLen = 0;
    function put(num, len) {
      for (var k = len - 1; k >= 0; k--) {
        var pos = bitLen >> 3;
        if (bits[pos] === undefined) bits[pos] = 0;
        if ((num >>> k) & 1) bits[pos] |= (1 << (7 - (bitLen & 7)));
        bitLen++;
      }
    }
    put(4, 4); /* byte mode */
    put(bytes.length, version < 10 ? 8 : 16);
    for (i = 0; i < bytes.length; i++) put(bytes[i], 8);
    var capBits = totalData * 8;
    var term = Math.min(4, capBits - bitLen);
    for (i = 0; i < term; i++) put(0, 1);
    while (bitLen % 8 !== 0) put(0, 1);
    var pads = [0xec, 0x11], pi = 0;
    while ((bitLen >> 3) < totalData) { put(pads[pi % 2], 8); pi++; }
    return bits.slice(0, totalData);
  }
  function qrInterleave(dataCw, version) {
    var spec = QR_M_BLOCKS[version], ecLen = spec[0];
    var blocks = [], ecs = [], pos = 0, i, j;
    spec[1].forEach(function (n) {
      var chunk = dataCw.slice(pos, pos + n);
      blocks.push(chunk);
      ecs.push(qrRsEc(chunk, ecLen));
      pos += n;
    });
    var out = [], maxLen = 0;
    blocks.forEach(function (b) { if (b.length > maxLen) maxLen = b.length; });
    for (i = 0; i < maxLen; i++) for (j = 0; j < blocks.length; j++) if (i < blocks[j].length) out.push(blocks[j][i]);
    for (i = 0; i < ecLen; i++) for (j = 0; j < ecs.length; j++) out.push(ecs[j][i]);
    return out;
  }
  function qrMaskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  function qrBuildMatrix(version, codewords, mask) {
    var size = version * 4 + 17;
    var m = [], r, c, i;
    for (r = 0; r < size; r++) { m.push([]); for (c = 0; c < size; c++) m[r].push(null); }
    function probe(row, col) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = row + dr, cc = col + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        m[rr][cc] = (0 <= dr && dr <= 6 && (dc === 0 || dc === 6)) ||
          (0 <= dc && dc <= 6 && (dr === 0 || dr === 6)) ||
          (2 <= dr && dr <= 4 && 2 <= dc && dc <= 4);
      }
    }
    probe(0, 0); probe(size - 7, 0); probe(0, size - 7);
    var align = QR_ALIGN[version];
    align.forEach(function (row) {
      align.forEach(function (col) {
        if (m[row][col] !== null) return;
        for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
          /* vòng ngoài + tâm: tối; vòng giữa: sáng */
          m[row + dr][col + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0));
        }
      });
    });
    for (i = 8; i < size - 8; i++) {
      if (m[i][6] === null) m[i][6] = (i % 2 === 0);
      if (m[6][i] === null) m[6][i] = (i % 2 === 0);
    }
    function typeInfo(test, info) {
      for (var k = 0; k < 15; k++) {
        var mod = !test && ((info >> k) & 1) === 1;
        if (k < 6) m[k][8] = mod;
        else if (k < 8) m[k + 1][8] = mod;
        else m[size - 15 + k][8] = mod;
        if (k < 8) m[8][size - k - 1] = mod;
        else if (k < 9) m[8][15 - k] = mod;
        else m[8][15 - k - 1] = mod;
      }
      m[size - 8][8] = !test;
    }
    typeInfo(true, 0); /* giữ chỗ format info trước khi đặt dữ liệu */
    if (version >= 7) {
      var vinfo = qrVersionInfo(version);
      for (i = 0; i < 18; i++) {
        var vmod = ((vinfo >> i) & 1) === 1;
        m[Math.floor(i / 3)][(i % 3) + size - 11] = vmod;
        m[(i % 3) + size - 11][Math.floor(i / 3)] = vmod;
      }
    }
    /* Đặt dữ liệu: zigzag từ góc dưới phải, bỏ qua cột 6 */
    var inc = -1, row = size - 1, bitIdx = 7, byteIdx = 0;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (var cc2 = 0; cc2 < 2; cc2++) {
          var ccol = col - cc2;
          if (m[row][ccol] === null) {
            var dark = false;
            if (byteIdx < codewords.length) dark = ((codewords[byteIdx] >>> bitIdx) & 1) === 1;
            if (qrMaskBit(mask, row, ccol)) dark = !dark;
            m[row][ccol] = dark;
            bitIdx--;
            if (bitIdx === -1) { byteIdx++; bitIdx = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
    typeInfo(false, qrFormatInfo(0, mask)); /* 0 = mức sửa lỗi M */
    return m;
  }
  function qrPenalty(m) {
    var size = m.length, score = 0, r, c, i;
    function linePenalty(line) {
      var s = 0, run = 1;
      for (var k = 1; k < line.length; k++) {
        if (line[k] === line[k - 1]) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
      for (var p = 0; p + 11 <= line.length; p++) {
        var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1], hit1 = true, hit2 = true;
        for (var q = 0; q < 11; q++) {
          var v = line[p + q] ? 1 : 0;
          if (v !== pat1[q]) hit1 = false;
          if (v !== pat2[q]) hit2 = false;
        }
        if (hit1 || hit2) s += 40;
      }
      return s;
    }
    for (r = 0; r < size; r++) {
      var rowLine = [], colLine = [];
      for (c = 0; c < size; c++) { rowLine.push(m[r][c]); colLine.push(m[c][r]); }
      score += linePenalty(rowLine) + linePenalty(colLine);
    }
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var percent = dark * 100 / (size * size);
    var lower = Math.floor(percent / 5) * 5, upper = lower + 5;
    var k = Math.min(Math.abs(lower - 50), Math.abs(upper - 50)) / 5;
    score += k * 10;
    return score;
  }
  function qrGenerate(text) {
    var bytes = Array.prototype.slice.call(new TextEncoder().encode(String(text)));
    var version = 0, dataCw = null;
    for (var v = 1; v <= 10; v++) {
      var totalData = 0;
      QR_M_BLOCKS[v][1].forEach(function (n) { totalData += n; });
      var lenBits = v < 10 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= totalData * 8) { version = v; dataCw = qrDataCodewords(bytes, v); break; }
    }
    if (!version) throw new Error("Nội dung quá dài cho mã QR (tối đa version 10-M)");
    var codewords = qrInterleave(dataCw, version);
    var best = null, bestMask = 0, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var matrix = qrBuildMatrix(version, codewords, mask);
      var pen = qrPenalty(matrix);
      if (pen < bestScore) { bestScore = pen; best = matrix; bestMask = mask; }
    }
    return { version: version, size: version * 4 + 17, mask: bestMask, modules: best };
  }
  /* === 2FA-CORE-END === */

  /* ---------- Cổng 2FA + thẻ bảo mật (giao diện) ---------- */
  var gatePassword = null;   // mật khẩu vừa đăng nhập (chỉ trong bộ nhớ trang), cần để mở khoá 2FA
  var gateCtx = null;        // {sec, secretBytes} trong lúc đứng ở cổng
  var gateAttempts = 0;
  var loginLoggedFor = null; // uid đã ghi activity "đăng nhập thành công" trong phiên này
  var tfSetup = null;        // dữ liệu tạm của trình bật 2FA {secretB32, secretBytes, codes, hashes}

  function isDirectorAccount() {
    if (!state.user || !state.user.email) return false;
    return String(state.user.email).trim().toLowerCase() === String(DIRECTOR_EMAIL || "").trim().toLowerCase();
  }
  function clearGateState() {
    gatePassword = null;
    gateCtx = null;
    gateAttempts = 0;
    loginLoggedFor = null;
    tfSetup = null;
  }
  function loadSecurityDoc() {
    if (!db) return Promise.resolve({});
    return db.collection("settings").doc("security").get().then(function (snap) {
      return snap.exists ? snap.data() : {};
    });
  }

  /* Thiết bị tin cậy: localStorage giữ mốc hết hạn 7 ngày + dấu thiết bị +
     salt của bản mã hoá tại thời điểm ghi nhớ (đổi/đặt lại 2FA là salt đổi -> phải qua cổng lại) */
  var TRUST_KEY = "cty_trustedDeviceV1";
  var DEVICE_KEY = "cty_deviceIdV1";
  function deviceId() {
    try {
      var v = localStorage.getItem(DEVICE_KEY);
      if (!v) {
        v = "dev-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
        localStorage.setItem(DEVICE_KEY, v);
      }
      return v;
    } catch (e) { console.error("deviceId lỗi:", e); return "dev-unknown"; }
  }
  function isTrustedDevice(email, sec) {
    try {
      var raw = localStorage.getItem(TRUST_KEY);
      if (!raw) return false;
      var rec = JSON.parse(raw);
      if (!rec || rec.email !== email) return false;
      if (!rec.exp || rec.exp <= Date.now()) return false;
      if (!sec || !sec.directorTotpEnc) return false;
      return rec.salt === (sec.directorTotpEnc.salt || "");
    } catch (e) { console.error("isTrustedDevice lỗi:", e); return false; }
  }
  function grantTrust(email, sec) {
    try {
      localStorage.setItem(TRUST_KEY, JSON.stringify({
        email: email,
        exp: Date.now() + 7 * 24 * 3600 * 1000,
        device: deviceId(),
        salt: (sec && sec.directorTotpEnc && sec.directorTotpEnc.salt) || ""
      }));
    } catch (e) { console.error("grantTrust lỗi:", e); }
  }

  /* Điểm vào sau khi hồ sơ đã nạp: nhân viên vào thẳng như cũ;
     Giám đốc phải qua cổng 2FA nếu đã bật và thiết bị chưa được ghi nhớ */
  function enterAppAfterSecurity(user) {
    if (!isDirectorAccount()) {
      gatePassword = null;
      enterApp();
      switchTab("overview");
      return;
    }
    loadSecurityDoc().then(function (sec) {
      state.security = sec || {};
      var enabled = !!(state.security && state.security.directorTotpEnc);
      if (!enabled) { finishEnter(); return; }
      var email = String(user.email || "").trim().toLowerCase();
      if (isTrustedDevice(email, state.security)) { finishEnter(); return; }
      showGate(state.security, null);
    }).catch(function (e) {
      console.error("Không đọc được cấu hình bảo mật settings/security:", e);
      showGate(null, e);
    });
  }
  function finishEnter() {
    enterApp();
    switchTab("overview");
    if (isDirectorAccount() && state.user && loginLoggedFor !== state.user.uid) {
      loginLoggedFor = state.user.uid;
      logActivity("đã đăng nhập thành công", "security");
    }
  }

  function showGate(sec, loadError) {
    gateCtx = { sec: sec || {}, secretBytes: null };
    gateAttempts = 0;
    $("loginView").classList.add("hidden");
    $("noProfileView").classList.add("hidden");
    $("appView").classList.add("hidden");
    $("gateView").classList.remove("hidden");
    $("gateCode").value = "";
    $("gatePassword").value = "";
    $("gateRemember").checked = false;
    $("gateHint").classList.add("hidden");
    var errBox = $("gateError");
    errBox.classList.add("hidden");
    /* Phiên được khôi phục tự động (không qua ô đăng nhập) sẽ không có mật khẩu
       trong bộ nhớ -> hiện ô nhập lại mật khẩu để mở khoá bí mật */
    $("gatePasswordWrap").classList.toggle("hidden", !!gatePassword);
    var broken = !!loadError;
    $("gateCode").disabled = broken;
    $("gateBtn").disabled = broken;
    $("gateRetry").classList.toggle("hidden", !broken);
    if (broken) {
      errBox.textContent = "Không đọc được cấu hình bảo mật từ máy chủ. Kiểm tra mạng rồi tải lại trang để thử lại.";
      errBox.classList.remove("hidden");
    }
    if (!broken) setTimeout(function () { $("gateCode").focus(); }, 60);
  }

  function gateFail(msg) {
    gateAttempts++;
    var errBox = $("gateError");
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
    var hint = $("gateHint");
    if (gateAttempts >= 3) {
      hint.textContent = "Bạn đã nhập sai " + gateAttempts + " lần. Hãy kiểm tra đồng hồ trên điện thoại có khớp giờ hệ thống không (mã đổi mỗi 30 giây), hoặc dùng một mã khôi phục chưa dùng.";
      hint.classList.remove("hidden");
    }
    $("gateCode").select();
  }

  function onGateSubmit(ev) {
    ev.preventDefault();
    if (!gateCtx || !gateCtx.sec) return;
    var sec = gateCtx.sec;
    var code = $("gateCode").value.trim();
    var errBox = $("gateError");
    errBox.classList.add("hidden");
    if (!code) { gateFail("Hãy nhập mã xác minh."); return; }
    var pw = gatePassword || $("gatePassword").value;
    if (!pw) { gateFail("Hãy nhập mật khẩu của bạn để mở khoá bảo mật."); return; }
    var btn = $("gateBtn");
    btn.disabled = true;
    btn.textContent = "Đang xác minh...";

    function tryRecovery() {
      return hashRecovery(code).then(function (h) {
        var hashes = sec.recoveryHashes || [];
        if (hashes.indexOf(h) === -1) return null;
        return h;
      });
    }
    function succeed(via, usedHash) {
      if ($("gateRemember").checked && state.user) {
        grantTrust(String(state.user.email || "").trim().toLowerCase(), sec);
      }
      var jobs = [];
      if (via === "recovery" && usedHash) {
        jobs.push(
          db.collection("settings").doc("security").update({
            recoveryHashes: firebase.firestore.FieldValue.arrayRemove(usedHash),
            updatedAt: serverTimestamp()
          }).catch(function (e) { console.error("Xoá mã khôi phục đã dùng thất bại:", e); })
        );
        if (state.security && state.security.recoveryHashes) {
          state.security.recoveryHashes = state.security.recoveryHashes.filter(function (x) { return x !== usedHash; });
        }
      }
      Promise.all(jobs).then(function () {
        if (via === "recovery") logActivity("đã đăng nhập bằng mã khôi phục", "security");
        else logActivity("đã qua cổng xác minh 2 lớp (2FA)", "security");
        btn.disabled = false;
        btn.textContent = "Xác minh";
        gatePassword = null;
        gateCtx = null;
        finishEnter();
      });
    }
    function fail(msg) {
      btn.disabled = false;
      btn.textContent = "Xác minh";
      gateFail(msg);
    }

    var secretReady;
    if (gateCtx.secretBytes) {
      secretReady = Promise.resolve(gateCtx.secretBytes);
    } else {
      secretReady = tfaDecryptSecret(pw, sec.directorTotpEnc).then(function (secretText) {
        var bytes = base32Decode(secretText);
        gateCtx.secretBytes = bytes;
        return bytes;
      }).catch(function (e) {
        console.error("Mở khoá bí mật 2FA thất bại (sai mật khẩu hoặc dữ liệu đã đổi):", e);
        return null;
      });
    }
    secretReady.then(function (secretBytes) {
      var isSix = /^\d{6}$/.test(code);
      var totpJob = (secretBytes && isSix) ? totpVerify(secretBytes, code) : Promise.resolve(false);
      return totpJob.then(function (ok) {
        if (ok) { succeed("totp", null); return; }
        return tryRecovery().then(function (h) {
          if (h) { succeed("recovery", h); return; }
          if (isSix && !secretBytes) {
            fail("Không mở được khoá bảo mật bằng mật khẩu này. Nếu bạn vừa đổi mật khẩu, hãy dùng mã khôi phục để qua cổng rồi tắt và bật lại 2FA trong Cài đặt.");
          } else {
            fail("Mã không đúng. Kiểm tra lại mã trong ứng dụng xác thực, hoặc dùng một mã khôi phục chưa dùng.");
          }
        });
      });
    }).catch(function (e) {
      console.error("Xác minh cổng 2FA thất bại:", e);
      fail("Xác minh thất bại. Vui lòng thử lại.");
    });
  }

  /* ---------- Thẻ "Bảo mật tài khoản Giám đốc" trong Cài đặt ---------- */
  function renderSecurityCard() {
    var card = $("securityCard");
    if (!card) return;
    if (!isDirectorAccount()) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    var sec = state.security || {};
    var enabled = !!sec.directorTotpEnc;
    $("secStatus").textContent = enabled ? "Đã bật — xác minh 2 lớp đang hoạt động" : "Chưa bật";
    var rec = $("secRecoveryInfo");
    if (enabled) {
      var n = (sec.recoveryHashes || []).length;
      rec.textContent = "Mã khôi phục chưa dùng: " + n + "/10. Khi hết mã khôi phục, hãy tắt rồi bật lại 2FA để cấp bộ mã mới.";
      rec.classList.remove("hidden");
    } else {
      rec.classList.add("hidden");
    }
    $("secEnableBtn").classList.toggle("hidden", enabled);
    $("secDisableWrap").classList.toggle("hidden", !enabled);
  }
  function secCardNote(msg, isError) {
    var okBox = $("secCardMsg"), errBox = $("secCardError");
    okBox.classList.add("hidden");
    errBox.classList.add("hidden");
    if (!msg) return;
    if (isError) { errBox.textContent = msg; errBox.classList.remove("hidden"); }
    else { okBox.textContent = msg; okBox.classList.remove("hidden"); }
  }

  function onSecDisable() {
    if (!isDirectorAccount() || !db) return;
    secCardNote("");
    var pw = $("secDisablePw").value;
    var code = $("secDisableCode").value.trim();
    if (!pw) { secCardNote("Hãy nhập mật khẩu hiện tại.", true); return; }
    if (!code) { secCardNote("Hãy nhập mã xác thực.", true); return; }
    var btn = $("secDisableBtn");
    btn.disabled = true;
    btn.textContent = "Đang kiểm tra...";
    function done() { btn.disabled = false; btn.textContent = "Tắt xác minh 2 lớp"; }
    var cred = firebase.auth.EmailAuthProvider.credential(state.user.email, pw);
    state.user.reauthenticateWithCredential(cred).then(function () {
      return loadSecurityDoc();
    }).then(function (sec) {
      if (!sec || !sec.directorTotpEnc) {
        secCardNote("Xác minh 2 lớp chưa được bật.", true);
        done();
        return null;
      }
      var verify = tfaDecryptSecret(pw, sec.directorTotpEnc).then(function (secretText) {
        return totpVerify(base32Decode(secretText), code);
      }).catch(function (e) {
        console.error("Tắt 2FA: mở khoá bí mật thất bại, thử bằng mã khôi phục:", e);
        return false;
      });
      return verify.then(function (ok) {
        if (ok) return true;
        return hashRecovery(code).then(function (h) {
          return (sec.recoveryHashes || []).indexOf(h) !== -1;
        });
      }).then(function (ok2) {
        if (!ok2) {
          secCardNote("Mật khẩu hoặc mã xác thực không đúng. Tắt 2FA bị huỷ.", true);
          done();
          return null;
        }
        var fv = firebase.firestore.FieldValue;
        return db.collection("settings").doc("security").update({
          directorTotpEnc: fv.delete(),
          recoveryHashes: fv.delete(),
          updatedAt: serverTimestamp()
        }).then(function () {
          state.security = {};
          $("secDisablePw").value = "";
          $("secDisableCode").value = "";
          renderSecurityCard();
          secCardNote("Đã tắt xác minh 2 lớp. Bí mật xác thực và mã khôi phục đã được xoá.");
          logActivity("đã tắt xác minh 2 lớp (2FA)", "security");
          done();
        });
      });
    }).catch(function (e) {
      console.error("Tắt 2FA thất bại:", e);
      if (e && (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential")) {
        secCardNote("Mật khẩu hiện tại không đúng.", true);
      } else {
        secCardNote("Tắt 2FA thất bại. Vui lòng thử lại.", true);
      }
      done();
    });
  }

  /* ---------- Trình bật 2FA (modal 4 bước) ---------- */
  function drawQr(canvas, text) {
    var qr = qrGenerate(text);
    var n = qr.size;
    var scale = Math.max(2, Math.floor(canvas.width / (n + 8)));
    var off = Math.floor((canvas.width - scale * n) / 2);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#1A1D21";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (qr.modules[r][c]) ctx.fillRect(off + c * scale, off + r * scale, scale, scale);
    }
  }
  function tfGoStep(n) {
    [1, 2, 3, 4].forEach(function (k) {
      $("tfStep" + k).classList.toggle("hidden", k !== n);
      var chip = document.querySelector('[data-tfdot="' + k + '"]');
      if (chip) {
        chip.classList.toggle("active", k === n);
        chip.classList.toggle("done", k < n);
      }
    });
  }
  function tfError(step, msg) {
    var box = $("tfError" + step);
    if (!box) return;
    if (msg) { box.textContent = msg; box.classList.remove("hidden"); }
    else box.classList.add("hidden");
  }
  function openTwofaModal() {
    if (!isDirectorAccount()) return;
    if (!subtleCrypto) {
      secCardNote("Trình duyệt không hỗ trợ WebCrypto (cần HTTPS). Hãy mở trang qua địa chỉ https rồi thử lại.", true);
      console.error("openTwofaModal: crypto.subtle không khả dụng (thiếu secure context?)");
      return;
    }
    tfSetup = null;
    ["tfCurPw", "tfNewPw", "tfNewPw2", "tfCode"].forEach(function (id) { $(id).value = ""; });
    [1, 2, 3, 4].forEach(function (k) { tfError(k, ""); });
    $("tfSavedChk").checked = false;
    $("tfFinish").disabled = true;
    tfGoStep(1);
    $("twofaModal").classList.remove("hidden");
  }
  function closeTwofaModal() {
    $("twofaModal").classList.add("hidden");
    tfSetup = null; /* xoá bí mật tạm khỏi bộ nhớ khi đóng trình */
  }
  function onTfStep1() {
    tfError(1, "");
    var cur = $("tfCurPw").value;
    var np = $("tfNewPw").value;
    var np2 = $("tfNewPw2").value;
    if (!cur) { tfError(1, "Hãy nhập mật khẩu hiện tại."); return; }
    if (!np || np.length < 10) { tfError(1, "Mật khẩu mới phải có ít nhất 10 ký tự."); return; }
    if (!/[A-Za-z]/.test(np) || !/[0-9]/.test(np)) { tfError(1, "Mật khẩu mới phải gồm cả chữ và số."); return; }
    if (np !== np2) { tfError(1, "Hai ô mật khẩu mới chưa khớp nhau."); return; }
    var btn = $("tfNext1");
    btn.disabled = true;
    btn.textContent = "Đang đổi mật khẩu...";
    var cred = firebase.auth.EmailAuthProvider.credential(state.user.email, cur);
    state.user.reauthenticateWithCredential(cred).then(function () {
      return state.user.updatePassword(np);
    }).then(function () {
      gatePassword = np; /* khoá mã hoá 2FA dùng mật khẩu MỚI vừa đặt */
      var secretBytes = subtleCrypto.getRandomValues(new Uint8Array(20));
      tfSetup = {
        secretB32: base32Encode(secretBytes),
        secretBytes: secretBytes,
        codes: null,
        hashes: null
      };
      $("tfSecretText").textContent = tfSetup.secretB32.replace(/(.{4})/g, "$1 ").trim();
      try {
        drawQr($("tfQr"), otpauthUrl(tfSetup.secretB32, state.user.email));
      } catch (e) {
        console.error("Vẽ mã QR 2FA thất bại:", e);
        tfError(2, "Không vẽ được mã QR — hãy nhập tay mã bí mật bên dưới vào ứng dụng xác thực.");
      }
      btn.disabled = false;
      btn.textContent = "Đổi mật khẩu & tiếp tục";
      tfGoStep(2);
    }).catch(function (e) {
      console.error("Bật 2FA bước 1 (đổi mật khẩu) thất bại:", e);
      btn.disabled = false;
      btn.textContent = "Đổi mật khẩu & tiếp tục";
      if (e && (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential")) {
        tfError(1, "Mật khẩu hiện tại không đúng.");
      } else if (e && e.code === "auth/weak-password") {
        tfError(1, "Mật khẩu mới quá yếu theo chính sách của Firebase. Hãy chọn mật khẩu dài và phức tạp hơn.");
      } else {
        tfError(1, "Đổi mật khẩu thất bại. Vui lòng thử lại.");
      }
    });
  }
  function onTfStep3() {
    tfError(3, "");
    if (!tfSetup) { tfError(3, "Phiên thiết lập đã hết. Hãy đóng và mở lại trình bật 2FA."); return; }
    var code = $("tfCode").value.trim();
    var btn = $("tfNext3");
    btn.disabled = true;
    btn.textContent = "Đang xác nhận...";
    totpVerify(tfSetup.secretBytes, code).then(function (ok) {
      btn.disabled = false;
      btn.textContent = "Xác nhận mã";
      if (!ok) {
        tfError(3, "Mã chưa đúng. Kiểm tra lại mã 6 số trong ứng dụng (mã đổi mỗi 30 giây) rồi thử lại.");
        return;
      }
      var codes = [];
      for (var i = 0; i < 10; i++) codes.push(genRecoveryCode());
      tfSetup.codes = codes;
      $("tfCodes").innerHTML = codes.map(function (cd) {
        return '<div class="tf-code mono">' + esc(cd) + "</div>";
      }).join("");
      $("tfSavedChk").checked = false;
      $("tfFinish").disabled = true;
      tfGoStep(4);
    }).catch(function (e) {
      console.error("Bật 2FA bước 3 (xác nhận mã) thất bại:", e);
      btn.disabled = false;
      btn.textContent = "Xác nhận mã";
      tfError(3, "Xác nhận thất bại. Vui lòng thử lại.");
    });
  }
  function onTfFinish() {
    tfError(4, "");
    if (!tfSetup || !tfSetup.codes) { tfError(4, "Phiên thiết lập đã hết. Hãy đóng và mở lại trình bật 2FA."); return; }
    if (!$("tfSavedChk").checked) { tfError(4, "Hãy tích xác nhận đã lưu mã khôi phục trước khi hoàn tất."); return; }
    var btn = $("tfFinish");
    btn.disabled = true;
    btn.textContent = "Đang mã hoá & lưu...";
    var hashesJob = Promise.all(tfSetup.codes.map(function (cd) { return hashRecovery(cd); }));
    hashesJob.then(function (hashes) {
      tfSetup.hashes = hashes;
      return tfaEncryptSecret(gatePassword, tfSetup.secretB32);
    }).then(function (enc) {
      return db.collection("settings").doc("security").set({
        directorTotpEnc: enc,
        recoveryHashes: tfSetup.hashes,
        updatedAt: serverTimestamp()
      }, { merge: true }).then(function () { return enc; });
    }).then(function (enc) {
      state.security = {
        directorTotpEnc: enc,
        recoveryHashes: tfSetup.hashes
      };
      logActivity("đã bật xác minh 2 lớp (2FA)", "security");
      closeTwofaModal();
      renderSecurityCard();
      secCardNote("Đã bật xác minh 2 lớp. Từ lần đăng nhập tới, Giám đốc sẽ phải nhập thêm mã xác thực (trên thiết bị này có thể chọn ghi nhớ 7 ngày ở cổng xác minh).");
    }).catch(function (e) {
      console.error("Bật 2FA bước 4 (lưu settings/security) thất bại:", e);
      btn.disabled = false;
      btn.textContent = "Hoàn tất bật 2FA";
      tfError(4, "Lưu cấu hình bảo mật thất bại. Kiểm tra mạng rồi thử lại — mã khôi phục ở trên vẫn còn hiệu lực cho lần thử này.");
    });
  }

  /* ---------- Ủy quyền sự kiện bấm (toàn cục) ---------- */
  function toggleCollapse(map, id) { map[id] = !map[id]; }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || typeof t.closest !== "function") return;
    if (!t.closest(".bell-wrap")) closeBell();

    var bd = t.closest("[data-bdot]");
    if (bd) { scrollBoardTo(Number(bd.getAttribute("data-bdot"))); return; }
    var rm = t.closest("[data-rmfile]");
    if (rm) {
      state.pendingFiles.splice(Number(rm.getAttribute("data-rmfile")), 1);
      renderAttachList();
      return;
    }
    var co = t.closest("[data-collapse-org]");
    if (co) { toggleCollapse(state.collapsedOrg, co.getAttribute("data-collapse-org")); renderOrgTree(); return; }
    var ct = t.closest("[data-collapse-tv]");
    if (ct) { toggleCollapse(state.collapsedTv, ct.getAttribute("data-collapse-tv")); renderEmpTree(); return; }
    var pin = t.closest("[data-pin]");
    if (pin) { setPinned(pin.getAttribute("data-pin"), pin.getAttribute("data-state") !== "1"); return; }
    var unpin = t.closest("[data-unpin]");
    if (unpin) { setPinned(unpin.getAttribute("data-unpin"), false); return; }
    var dl = t.closest("[data-dl]");
    if (dl) { downloadFile(dl.getAttribute("data-dl"), dl); return; }
    var ap = t.closest("[data-approve]");
    if (ap) {
      var ta = findTask(ap.getAttribute("data-approve"));
      if (ta) decideOne(ta, "Duyệt");
      if (ap.blur) ap.blur();
      return;
    }
    var rt = t.closest("[data-return]");
    if (rt) {
      var tr = findTask(rt.getAttribute("data-return"));
      if (tr) decideOne(tr, "Trả lại");
      if (rt.blur) rt.blur();
      return;
    }
    var ack = t.closest("[data-ack]");
    if (ack) {
      var ak = findTask(ack.getAttribute("data-ack"));
      if (ak) acknowledgeTask(ak);
      return;
    }
    var gm = t.closest("[data-goto-msg]");
    if (gm) { closeBell(); jumpToMessage(gm.getAttribute("data-goto-msg")); return; }
    var go = t.closest("[data-goto]");
    if (go) { closeBell(); switchTab(go.getAttribute("data-goto")); return; }
    var to = t.closest("[data-taskopen]");
    if (to) { openTask(to.getAttribute("data-taskopen")); return; }
    var ed = t.closest("[data-emp-edit]");
    if (ed) { startEditEmployee(ed.getAttribute("data-emp-edit")); return; }
    var su = t.closest("[data-emp-suspend]");
    if (su) { toggleSuspend(su.getAttribute("data-emp-suspend")); return; }
    var rc = t.closest("[data-emp-reset]");
    if (rc) { resetAccessCode(rc.getAttribute("data-emp-reset")); return; }
    var pr = t.closest("[data-profile]");
    if (pr) { openProfile(pr.getAttribute("data-profile")); return; }
  });

  /* ================= PHASE 4 — Giao diện PRO (guide mục 6+7) =================
     Mọi số liệu lấy từ state đã subscribe sẵn (messages, tasks, employees,
     presence). Chỗ chưa có nguồn live thì hiển thị "chưa có dữ liệu", không
     bịa số. Không thêm collection, không đổi schema tin/việc hiện có, trừ
     2 trường cờ của guide (needsReply, priority "khẩn") chỉ ghi khi người
     gửi tick chọn ở ô soạn tin. */

  /* ---------- Presence (do set_work ghi; web chưa từng subscribe trước Phase 4) ---------- */
  function presOf(id) { return (state.presence && state.presence[id]) || null; }
  function presProgressPct(pr) {
    if (!pr || pr.progress == null) return null;
    var m = String(pr.progress).match(/(\d{1,3})\s*%/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    if (isNaN(n) || n < 0 || n > 100) return null;
    return n;
  }
  /* Trạng thái 3D/sức khoẻ từ presence. Guide mục 1: lastSeen quá 3 phút là ngoại tuyến.
     Lưu ý: trường status do set_work ghi luôn là "Đang làm" nên không dùng để suy trạng thái. */
  function presStateKind(pr) {
    if (!pr) return { kind: "nodata", label: "chưa có dữ liệu" };
    if (pr.blocker) return { kind: "blocked", label: "Kẹt: " + pr.blocker };
    var ms = tsMillis(pr.lastSeen);
    if (!ms || Date.now() - ms > 3 * 60 * 1000) return { kind: "offline", label: "Ngoại tuyến" };
    if (pr.currentWork) return { kind: "working", label: pr.currentWork };
    return { kind: "idle", label: "Chờ việc" };
  }
  function presAgeText(pr) {
    var ms = pr ? tsMillis(pr.lastSeen) : null;
    if (!ms) return "chưa có dữ liệu";
    return fmtRel(pr.lastSeen) + " trước";
  }

  /* ---------- Avatar hiển thị (employees/{id}.avatar = {color, hair, img}; CHỈ HIỂN THỊ) ---------- */
  function isValidAvatarImg(s) {
    return typeof s === "string" && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(s);
  }
  function avatarColors(e) {
    var shirt = (e && e.avatar && typeof e.avatar.color === "string" && e.avatar.color.charAt(0) === "#")
      ? e.avatar.color : ((e && e.color) || "#4f46e5");
    var hair = (e && e.avatar && typeof e.avatar.hair === "string" && /^#[0-9a-fA-F]{6}$/.test(e.avatar.hair))
      ? e.avatar.hair : "#3b2a1a";
    return { shirt: shirt, hair: hair };
  }

  /* ---------- Tin đã xử lý (lưu ở máy này, không ghi lên server) ---------- */
  function loadHandledMap() {
    try {
      var arr = JSON.parse(localStorage.getItem("enteesee-handled-msgs") || "[]");
      var map = {};
      arr.forEach(function (id) { map[id] = true; });
      state.handledMap = map;
    } catch (e) { state.handledMap = {}; }
  }
  function saveHandledMap() {
    try { localStorage.setItem("enteesee-handled-msgs", JSON.stringify(Object.keys(state.handledMap))); } catch (e) {}
  }
  function isHandledMsg(id) { return !!(state.handledMap && state.handledMap[id]); }
  function toggleHandledMsg(id) {
    if (!state.handledMap) state.handledMap = {};
    if (state.handledMap[id]) delete state.handledMap[id]; else state.handledMap[id] = true;
    saveHandledMap();
    renderMessages();
  }
  function handledActionHtml(m) {
    var me = state.me;
    var mentionsMe = me && m.mentions && m.mentions.indexOf(me.id) >= 0;
    var triage = mentionsMe || m.kind === "Giao việc" || m.kind === "Thông báo";
    if (!triage) return "";
    if (isHandledMsg(m.id)) {
      return '<div class="msg-actions"><span class="chip">Đã xử lý</span>' +
        '<button class="link-btn" type="button" data-handled-toggle="' + esc(m.id) + '">Bỏ đánh dấu</button></div>';
    }
    return '<div class="msg-actions"><button class="link-btn" type="button" data-handled-toggle="' +
      esc(m.id) + '">✓ Đánh dấu đã xử lý</button></div>';
  }

  /* ---------- Thống kê nhân sự ---------- */
  function avgAckMsFor(empId) {
    var delays = [];
    state.tasks.forEach(function (t) {
      if (t.assigneeId !== empId) return;
      var created = tsMillis(t.createdAt);
      if (!created) return;
      var evs = (t.history || []).filter(function (h) { return h.from === "Chờ nhận" && h.to === "Đang làm"; });
      if (!evs.length) return;
      var at = null, i;
      for (i = 0; i < evs.length; i++) { var mm = tsMillis(evs[i].at); if (mm && (at === null || mm < at)) at = mm; }
      if (at !== null && at >= created) delays.push(at - created);
    });
    if (!delays.length) return null;
    var sum = 0, i;
    for (i = 0; i < delays.length; i++) sum += delays[i];
    return Math.round(sum / delays.length);
  }
  function empJobRoles(empId) {
    var roles = [];
    state.tasks.forEach(function (t) {
      if (t.assigneeId === empId && t.role && roles.indexOf(t.role) === -1) roles.push(t.role);
    });
    return roles;
  }

  /* ---------- Tổng quan: thẻ nổi bật + số việc theo trạng thái ---------- */
  function setTaskFilterUI(f) {
    state.taskFilter = f;
    document.querySelectorAll("#taskFilters .filter-btn").forEach(function (x) {
      x.classList.toggle("active", x.getAttribute("data-filter") === f);
    });
    renderTasks();
  }
  function renderHighlightCards() {
    var box = $("highlightCards");
    if (!box) return;
    var review = state.tasks.filter(function (t) { return t.status === "Chờ duyệt"; }).length;
    var overdue = state.tasks.filter(isOverdue).length;
    box.innerHTML =
      '<button class="highlight-card' + (review ? " warn" : "") + '" type="button" data-highlight-goto="duyet">' +
        '<span>Cần duyệt</span><span class="hc-num">' + review + " ›</span></button>" +
      '<button class="highlight-card' + (overdue ? " warn" : "") + '" type="button" data-highlight-goto="overdue">' +
        '<span>Việc quá hạn</span><span class="hc-num">' + overdue + " ›</span></button>";
  }
  function renderTaskStatusCounts() {
    var box = $("taskStatusCounts");
    if (!box) return;
    var html = '<span class="chip count">Tổng: ' + state.tasks.length + "</span>";
    TASK_STATUSES.forEach(function (st) {
      var n = state.tasks.filter(function (t) { return t.status === st; }).length;
      html += '<span class="chip">' + esc(st) + ": " + n + "</span>";
    });
    box.innerHTML = html;
  }

  /* ---------- Sức khoẻ hệ thống (presence.lastSeen; quota không có nguồn live) ---------- */
  function renderHealth() {
    var box = $("healthList"), note = $("healthNote");
    if (!box) return;
    var staff = state.employees.filter(function (e) { return e.level !== "Giám đốc" && !e.suspended; });
    if (!staff.length) {
      box.innerHTML = '<p class="hint">Chưa có nhân viên nào.</p>';
    } else {
      box.innerHTML = staff.map(function (e) {
        var pr = presOf(e.id);
        var st = presStateKind(pr);
        var dotCls = st.kind === "working" ? "dot on" : (st.kind === "blocked" ? "dot late" : "dot off");
        return '<div class="health-row">' + avatarHtml(e, "sm") +
          '<div style="flex:1;min-width:0"><div><b>' + esc(e.name || "") + "</b> · " + esc(st.label) + "</div>" +
          '<div class="hint">presence: ' + (pr ? esc(presAgeText(pr)) : "chưa có dữ liệu") +
          (pr && pr.currentWork ? " · " + esc(pr.currentWork) : "") + "</div></div>" +
          '<span class="' + dotCls + '"></span></div>';
      }).join("");
    }
    if (note) {
      var err = state.lastStreamError
        ? "Lỗi stream gần nhất trong phiên này: " + esc(state.lastStreamError.code || "không rõ mã") +
          (state.lastStreamError.code === "resource-exhausted" ? " (lỗi 429 — hết quota đọc)" : "") + ". "
        : "Chưa ghi nhận lỗi stream trong phiên này. ";
      note.textContent = err + "Quota Firestore hôm nay: chưa có dữ liệu (không đọc được từ web client; số liệu quota ghi trong decisions theo Pha 0).";
    }
  }

  /* ---------- Cột phải desktop ---------- */
  function renderRightRail() {
    var ap = $("railApproval"), al = $("railAlerts"), cl = $("railChatList");
    if (!ap && !al && !cl) return;
    if (ap) {
      var list = state.tasks.filter(function (t) { return t.status === "Chờ duyệt"; });
      ap.innerHTML = "<p class=\"hint\">Hàng chờ: <b>" + list.length + "</b> mục.</p>" +
        (list.length
          ? list.slice(0, 5).map(function (t) {
              return '<div class="rail-item" data-rail-goto="duyet"><div style="flex:1;min-width:0"><b>' +
                esc(t.title || "") + "</b><div class=\"hint\">Phụ trách: " + esc(empName(t.assigneeId)) + "</div></div></div>";
            }).join("")
          : '<p class="hint">Không có mục chờ duyệt.</p>');
    }
    if (al) {
      var html = "";
      var ao = canManage() ? ackOverdueTasks() : state.tasks.filter(function (t) {
        return state.me && t.assigneeId === state.me.id && t.status === "Chờ nhận";
      });
      if (ao.length) {
        html += '<p class="hint">' + (canManage() ? "Quá hạn xác nhận" : "Việc của tôi chưa nhận") +
          ": <b>" + ao.length + "</b></p>" +
          ao.slice(0, 5).map(function (t) {
            return '<div class="rail-item" data-rail-task="' + esc(t.id) + '"><div style="flex:1;min-width:0"><b>' +
              esc(t.title || "") + "</b><div class=\"hint\">Phụ trách: " + esc(empName(t.assigneeId)) + "</div></div></div>";
          }).join("");
      }
      var blocked = state.employees.filter(function (e) { var pr = presOf(e.id); return pr && pr.blocker; });
      if (blocked.length) {
        html += '<p class="hint">Đang kẹt: <b>' + blocked.length + "</b></p>" +
          blocked.map(function (e) {
            return '<div class="rail-item"><div style="flex:1;min-width:0"><b>' + esc(e.name || "") +
              '</b><div class="hint">' + esc(presOf(e.id).blocker) + "</div></div></div>";
          }).join("");
      }
      html += '<p class="hint">Quota hôm nay: chưa có dữ liệu.</p>';
      if (!html) html = '<p class="hint">Không có cảnh báo.</p>';
      al.innerHTML = html;
    }
    if (cl) {
      var last = state.messages.slice(-3);
      cl.innerHTML = last.length
        ? last.map(function (m) {
            return '<div class="rail-item" data-rail-msg="' + esc(m.id) + '"><div style="flex:1;min-width:0"><b>' +
              esc(m.senderName || "") + '</b><div class="hint">' +
              esc(String(m.content || "").slice(0, 60)) + "</div></div></div>";
          }).join("")
        : '<p class="hint">Chưa có tin nhắn nào.</p>';
    }
  }
  function onRailChat(ev) {
    ev.preventDefault();
    if (!db || !state.me) return;
    var input = $("railChatInput");
    var content = input.value.trim();
    if (!content) return;
    db.collection("messages").add({
      senderId: state.me.id, senderName: state.me.name, senderTitle: state.me.title,
      content: content, kind: "Trao đổi", mentions: computeMentions(content, state.employees),
      createdAt: serverTimestamp(), attachments: [], pinned: false
    }).then(function () { input.value = ""; }).catch(function (e) { console.warn("rail chat:", e); });
  }

  /* ---------- Phòng chat: kênh / luồng / lọc kind / cần trả lời / khẩn ---------- */
  function rebuildSelectPreserve(sel, items) {
    if (!sel) return;
    var cur = sel.value;
    var html = items.map(function (it) {
      return '<option value="' + esc(it.value) + '">' + esc(it.label) + "</option>";
    }).join("");
    sel.innerHTML = html;
    var ok = items.some(function (it) { return it.value === cur; });
    if (ok) sel.value = cur;
  }
  function renderChatFilters() {
    var ch = $("chatChannelSel");
    if (ch) {
      var items = [{ value: "all", label: "Phòng chung" }];
      state.employees.forEach(function (e) {
        if (!e.suspended) items.push({ value: "dm:" + e.id, label: "DM: " + (e.name || "") });
      });
      rebuildSelectPreserve(ch, items);
      ch.value = state.chatChannel;
    }
    var th = $("chatThreadSel");
    if (th) {
      var seen = {}, items2 = [{ value: "", label: "Mọi luồng việc" }];
      state.messages.forEach(function (m) {
        if (m.linkedTaskTitle && !seen[m.linkedTaskTitle]) { seen[m.linkedTaskTitle] = true; items2.push({ value: m.linkedTaskTitle, label: "Việc: " + m.linkedTaskTitle }); }
      });
      rebuildSelectPreserve(th, items2);
      th.value = state.chatThread;
    }
    var kd = $("chatKindSel");
    if (kd) {
      var items3 = [{ value: "", label: "Mọi loại tin" }];
      MSG_KINDS.forEach(function (k) { items3.push({ value: k, label: k }); });
      rebuildSelectPreserve(kd, items3);
      kd.value = state.chatKind;
    }
    var n = $("chatNeedsOnly"); if (n) n.checked = state.chatNeedsOnly;
    var u = $("chatUrgentOnly"); if (u) u.checked = state.chatUrgentOnly;
    var uh = $("chatUnhandledOnly"); if (uh) uh.checked = state.chatUnhandledOnly;
  }
  function chatFilteredMessages() {
    var list = state.messages;
    if (state.chatChannel && state.chatChannel !== "all" && state.chatChannel.indexOf("dm:") === 0) {
      var pid = state.chatChannel.slice(3), me = state.me ? state.me.id : null;
      list = list.filter(function (m) {
        var mentions = m.mentions || [];
        return (m.senderId === me && mentions.indexOf(pid) >= 0) ||
          (m.senderId === pid && mentions.indexOf(me) >= 0);
      });
    }
    if (state.chatThread) list = list.filter(function (m) { return m.linkedTaskTitle === state.chatThread; });
    if (state.chatKind) list = list.filter(function (m) { return m.kind === state.chatKind; });
    if (state.chatNeedsOnly) list = list.filter(function (m) { return m.needsReply === true; });
    if (state.chatUrgentOnly) list = list.filter(function (m) { return m.priority === "khẩn"; });
    if (state.chatUnhandledOnly) list = list.filter(function (m) { return !isHandledMsg(m.id); });
    return list;
  }
  function updateChatFilterInfo(shown) {
    var info = $("chatFilterInfo");
    if (!info) return;
    var active = state.chatChannel !== "all" || !!state.chatThread || !!state.chatKind ||
      state.chatNeedsOnly || state.chatUrgentOnly || state.chatUnhandledOnly;
    info.textContent = active ? ("Đang hiển thị " + shown + " / " + state.messages.length + " tin (lọc).") : "";
  }

  /* ---------- Việc: Kanban chip cột + kéo thả + cây cha-con ---------- */
  function renderKanbanChips() {
    var box = $("kanbanCols");
    if (!box) return;
    var html = '<button class="kchip' + (state.kanbanCol === "all" ? " active" : "") + '" type="button" data-kcol="all">Tất cả các cột</button>';
    TASK_STATUSES.forEach(function (st) {
      var n = state.tasks.filter(function (t) { return t.status === st; }).length;
      html += '<button class="kchip' + (state.kanbanCol === st ? " active" : "") + '" type="button" data-kcol="' +
        esc(st) + '">' + esc(st) + " (" + n + ")</button>";
    });
    box.innerHTML = html;
  }
  function applyKanbanColFilter() {
    var board = $("taskBoard");
    if (!board) return;
    if (state.kanbanCol === "all") {
      board.querySelectorAll(".board-col").forEach(function (c) { c.classList.remove("hidden"); });
      return;
    }
    board.querySelectorAll(".board-col").forEach(function (c) {
      c.classList.toggle("hidden", c.getAttribute("data-col") !== state.kanbanCol);
    });
  }
  function setKanbanCol(col) {
    state.kanbanCol = col;
    renderKanbanChips();
    applyKanbanColFilter();
  }
  function setTaskView(view) {
    state.taskView = view;
    var b = $("taskViewBoardBtn"), t = $("taskViewTreeBtn");
    if (b) b.classList.toggle("primary", view === "board");
    if (t) t.classList.toggle("primary", view === "tree");
    renderTasks();
  }
  function renderTaskTree() {
    var box = $("taskTree");
    if (!box) return;
    var list = visibleTasks();
    var ids = {};
    list.forEach(function (t) { ids[t.id] = true; });
    var hasLink = list.some(function (t) { return t.parentTaskId; });
    if (!hasLink) {
      box.innerHTML = "<p class=\"hint\">Chưa có việc cha-con nào. Việc chia nhỏ cần ghi parentTaskId (theo guide mục 5) thì cây mới hiện ở đây.</p>";
      return;
    }
    var kids = {};
    list.forEach(function (t) {
      var p = t.parentTaskId;
      if (p && ids[p]) {
        if (!kids[p]) kids[p] = [];
        kids[p].push(t);
      }
    });
    var roots = list.filter(function (t) { return !t.parentTaskId || !ids[t.parentTaskId]; });
    function nodeHtml(t, depth, seen) {
      var h = '<div class="tree-node"><div><b>' + esc(t.title || "") + "</b> " +
        '<span class="' + statusChipClass(t.status) + '">' + esc(statusText(t.status)) + "</span> " +
        '<span class="hint">Phụ trách: ' + esc(empName(t.assigneeId)) + "</span> " +
        '<button class="link-btn" type="button" data-taskopen="' + esc(t.id) + '">Mở việc</button></div>';
      var ch = kids[t.id] || [];
      if (ch.length && depth < 5 && !seen[t.id]) {
        var next = {};
        Object.keys(seen).forEach(function (k) { next[k] = true; });
        next[t.id] = true;
        h += '<div class="tree-kids">' + ch.map(function (c) { return nodeHtml(c, depth + 1, next); }).join("") + "</div>";
      }
      return h + "</div>";
    }
    box.innerHTML = roots.map(function (t) { return nodeHtml(t, 0, {}); }).join("") ||
      "<p class=\"hint\">Không có việc nào khớp bộ lọc.</p>";
  }
  function renderTaskAdvFilters() {
    var as = $("taskAssigneeFilter");
    if (as) {
      var items = [{ value: "", label: "Mọi người phụ trách" }];
      state.employees.forEach(function (e) {
        if (!e.suspended) items.push({ value: e.id, label: e.name || "" });
      });
      rebuildSelectPreserve(as, items);
      as.value = state.taskAssigneeFilter;
    }
    var rs = $("taskRoleFilter");
    if (rs) {
      var seen = {}, items2 = [{ value: "", label: "Mọi vai trò job" }];
      state.tasks.forEach(function (t) {
        if (t.role && !seen[t.role]) { seen[t.role] = true; items2.push({ value: t.role, label: t.role }); }
      });
      rebuildSelectPreserve(rs, items2);
      rs.value = state.taskRoleFilter;
    }
  }
  function wireKanbanDrag(board) {
    if (!board) return;
    board.querySelectorAll(".board-col").forEach(function (col) {
      col.addEventListener("dragover", function (ev) { ev.preventDefault(); col.classList.add("drop-target"); });
      col.addEventListener("dragleave", function () { col.classList.remove("drop-target"); });
      col.addEventListener("drop", function (ev) {
        ev.preventDefault();
        col.classList.remove("drop-target");
        var id = ev.dataTransfer.getData("text/plain");
        var status = col.getAttribute("data-col");
        if (!id || !status) return;
        var t = findTask(id);
        if (!t || t.status === status) return;
        setTaskStatus(t, status, { historyNote: "Kéo thả Kanban" });
      });
    });
    board.querySelectorAll(".task-card").forEach(function (card) {
      card.addEventListener("dragstart", function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest("select,textarea,input,button,a")) {
          ev.preventDefault();
          return;
        }
        ev.dataTransfer.setData("text/plain", card.getAttribute("data-task-id") || "");
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", function () { card.classList.remove("dragging"); });
    });
  }

  /* ---------- Nhật ký quyết định: mẫu tin + pane tìm kiếm ---------- */
  function decisionItemHtml(d) {
    /* Tương thích ngược với bản ghi v1 (chưa có evidence/verification). */
    var ver = d.verification || (d.action === "Duyệt" || d.action === "Trả lại" ? "đã xác nhận" : "agent báo cáo");
    var verBy = d.verifiedBy || (ver === "đã xác nhận" ? (d.actorName || "") : "");
    return '<div class="activity-item"><span class="a-actor">' + esc(d.actorName || "") + "</span>" +
      "<span>" + esc(decisionActionText(d.action)) + " việc “" + esc(d.targetTitle || "") + "”" +
      (d.assigneeName ? " (phụ trách: " + esc(d.assigneeName) + ")" : "") +
      " — lý do: " + esc(d.reason ? d.reason : "không ghi lý do") +
      " — bằng chứng: " + esc(d.evidence ? d.evidence : "không kèm bằng chứng") +
      " — xác minh: " + esc(ver) + (verBy ? " bởi " + esc(verBy) : "") +
      (d.approvalId ? " · kèm hồ sơ phê duyệt" : "") + "</span>" +
      '<span class="a-time">' + esc(relText(d.createdAt)) + "</span></div>";
  }
  function foldStr(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
  }
  function renderDecisionsLog() {
    var box = $("decisionsListLog"), st = $("logStatus");
    if (!box) return;
    var q = foldStr(($("logSearchInput") ? $("logSearchInput").value : "").trim());
    var list = state.decisions;
    if (q) {
      list = list.filter(function (d) {
        var hay = foldStr([d.action, d.targetTitle, d.assigneeName, d.reason, d.evidence, d.actorName].join(" "));
        return hay.indexOf(q) >= 0;
      });
    }
    if (!state.decisionsLoaded) {
      box.innerHTML = '<p class="hint">Chưa tải nhật ký. Bấm “Tải nhật ký”.</p>';
    } else if (!list.length) {
      box.innerHTML = '<p class="hint">' + (q ? "Không khớp tìm kiếm." : "Chưa có quyết định nào được ghi nhận.") + "</p>";
    } else {
      box.innerHTML = list.map(decisionItemHtml).join("");
    }
    if (st) {
      st.textContent = state.decisionsLoaded
        ? ("Đã tải " + state.decisions.length + " quyết định mới nhất." + (q ? " Khớp tìm kiếm: " + list.length + "." : ""))
        : "";
    }
  }
  function exportDecisionsLog() {
    var st = $("logStatus");
    if (!state.decisionsLoaded || !state.decisions.length) {
      if (st) st.textContent = "Hãy tải nhật ký trước khi xuất.";
      return;
    }
    var blob = new Blob([JSON.stringify(state.decisions, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nhat-ky-quyet-dinh.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- Nhân sự: lưới thống kê ---------- */
  function renderEmpStatsGrid() {
    var box = $("empStatsGrid");
    if (!box) return;
    var list = state.employees.filter(function (e) { return !e.suspended; });
    if (!list.length) {
      box.innerHTML = '<p class="hint">Chưa có nhân viên nào.</p>';
      return;
    }
    box.innerHTML = list.map(function (e) {
      var my = state.tasks.filter(function (t) { return t.assigneeId === e.id; });
      var open = my.filter(function (t) { return t.status !== "Hoàn thành"; }).length;
      var done = my.filter(function (t) { return t.status === "Hoàn thành"; }).length;
      var avg = avgAckMsFor(e.id);
      var roles = empJobRoles(e.id);
      return '<div class="health-row">' + avatarHtml(e, "sm") +
        '<div style="flex:1;min-width:0"><div><b>' + esc(e.name || "") + "</b> · " + esc(e.title || "") + "</div>" +
        '<div class="hint">Đang mở: <b>' + open + "</b> · Hoàn thành: <b>" + done + "</b> · " +
        "Độ trễ ack trung bình: <b>" + (avg === null ? "chưa có dữ liệu" : esc(ageText(avg))) + "</b>" +
        (roles.length ? " · Vai trò job: " + roles.map(function (r) { return esc(r); }).join(", ") : "") + "</div></div></div>";
    }).join("");
  }

  /* ---------- Tìm kiếm toàn cục (phím /) ---------- */
  function renderSearchResults() {
    var input = $("globalSearch"), panel = $("globalSearchPanel");
    if (!input || !panel) return;
    var q = input.value.trim();
    if (!q) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
    var fq = foldStr(q);
    var html = "";
    function groupHtml(title, items, type) {
      if (!items.length) return "";
      var h = '<div class="search-group">' + title + "</div>";
      h += items.map(function (it) {
        return '<button class="search-item" type="button" data-search-type="' + type + '" data-search-id="' + esc(it.id) + '">' +
          '<span class="s-title">' + esc(it.title) + '</span><span class="s-sub">' + esc(it.sub || "") + "</span></button>";
      }).join("");
      return h;
    }
    var tasks = state.tasks.filter(function (t) {
      return foldStr((t.title || "") + " " + (t.description || "")).indexOf(fq) >= 0;
    }).slice(0, 5).map(function (t) {
      return { id: t.id, title: t.title || "", sub: esc(statusText(t.status)) + " · " + empName(t.assigneeId) };
    });
    var msgs = state.messages.slice().reverse().filter(function (m) {
      return foldStr((m.content || "") + " " + (m.senderName || "")).indexOf(fq) >= 0;
    }).slice(0, 5).map(function (m) {
      return { id: m.id, title: (m.senderName || "") + ": " + String(m.content || "").slice(0, 50), sub: m.kind || "" };
    });
    var emps = state.employees.filter(function (e) {
      return foldStr((e.name || "") + " " + (e.title || "") + " " + (e.role || "")).indexOf(fq) >= 0;
    }).slice(0, 5).map(function (e) {
      return { id: e.id, title: e.name || "", sub: e.title || "" };
    });
    var decs = state.decisionsLoaded ? state.decisions.filter(function (d) {
      return foldStr([d.action, d.targetTitle, d.assigneeName, d.reason, d.actorName].join(" ")).indexOf(fq) >= 0;
    }).slice(0, 3).map(function (d) {
      return { id: d.id, title: (d.action || "") + " việc “" + (d.targetTitle || "") + "”", sub: d.actorName || "" };
    }) : [];
    html += groupHtml("Công việc", tasks, "task");
    html += groupHtml("Tin nhắn", msgs, "msg");
    html += groupHtml("Nhân sự", emps, "emp");
    html += groupHtml("Quyết định (đã tải)", decs, "dec");
    if (!html) html = '<p class="hint" style="padding:10px">Không tìm thấy kết quả.</p>';
    panel.innerHTML = html;
    panel.classList.remove("hidden");
  }
  function closeSearchPanel() {
    var panel = $("globalSearchPanel");
    if (panel) { panel.classList.add("hidden"); panel.innerHTML = ""; }
  }

  /* ---------- Giao diện + thông báo + phân quyền menu 3D ---------- */
  function applyTheme(v) {
    if (v === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    var sel = $("themeSelect");
    if (sel) sel.value = v === "dark" ? "dark" : "light";
  }
  function setTheme(v) {
    try { localStorage.setItem("enteesee-theme", v === "dark" ? "dark" : "light"); } catch (e) {}
    applyTheme(v);
  }
  function applyRoleGating() {
    var show = isDirector();
    document.querySelectorAll('[data-tab="3d"]').forEach(function (b) { b.classList.toggle("hidden", !show); });
    document.querySelectorAll('#moreMenu [data-more-goto="3d"]').forEach(function (b) { b.classList.toggle("hidden", !show); });
  }

  /* ---------- Giao việc nhanh + chat nhanh cột phải ---------- */
  function onQuickTask(ev) {
    ev.preventDefault();
    if (!canManage() || !db) return;
    var errBox = $("quickTaskError");
    errBox.classList.add("hidden");
    var title = $("quickTaskTitle").value.trim();
    var assignee = $("quickTaskAssignee").value;
    if (!title) return;
    if (!assignee) {
      errBox.textContent = "Chưa có nhân viên nào để giao việc. Hãy đăng ký hồ sơ nhân viên trước.";
      errBox.classList.remove("hidden");
      return;
    }
    db.collection("tasks").add({
      title: title, description: "", assigneeId: assignee, assignerId: state.me.id,
      status: "Chờ nhận", priority: "Trung bình", role: "", sensitive: false,
      resultNote: "", dueAt: null, comments: [],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }).then(function () {
      $("quickTaskTitle").value = "";
      logActivity("đã giao việc nhanh “" + title + "” cho " + empName(assignee), "task");
    }).catch(function (e) {
      errBox.textContent = "Tạo công việc thất bại. Vui lòng thử lại.";
      errBox.classList.remove("hidden");
      console.warn("quick task:", e);
    });
  }

  /* ---------- Thông báo nhắc tên (chỉ khi tab ẩn + đã bật trong Cài đặt) ---------- */
  function maybeNotifyMentions(prevIds) {
    try {
      if (!("Notification" in window)) return;
      if (localStorage.getItem("enteesee-notify") !== "1") return;
      if (Notification.permission !== "granted") return;
      if (!document.hidden || !state.me) return;
      state.messages.forEach(function (m) {
        if (prevIds[m.id] || state.notifiedIds[m.id]) return;
        if (m.mentions && m.mentions.indexOf(state.me.id) >= 0) {
          state.notifiedIds[m.id] = true;
          new Notification("Nhắc tên trong phòng họp", {
            body: (m.senderName || "") + ": " + String(m.content || "").slice(0, 100)
          });
        }
      });
    } catch (e) { /* thông báo là tính năng phụ, lỗi thì bỏ qua */ }
  }

  /* ================= PHÒNG 3D (guide mục 8) =================
     - three.js 0.160.0 (UMD) từ cdnjs, nạp lười chỉ khi Chủ tịch mở tab Phòng 3D.
     - Khối đơn giản (hộp, trụ, cầu), không đổ bóng, giới hạn 30fps, tôn trọng
       prefers-reduced-motion (không chạy vòng lặp, chỉ vẽ lại khi dữ liệu đổi).
     - Dữ liệu: state.presence / state.employees / state.tasks / state.messages đã
       subscribe sẵn — phòng 3D không thêm lượt đọc nào. */
  var THREE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js";
  var R3D = {
    built: false, loading: false, mode: "3d", selectedId: null, peopleIds: "",
    seenMsgIds: {}, bubbleTimers: {}, people: [], deskParts: [],
    boardGroup: null, boardMats: null, tileGeo: null, selectionRing: null,
    renderer: null, scene: null, camera: null, raf: 0, lastFrame: 0,
    reduced: !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  };
  function room3dAiStaff() {
    var list = state.employees.filter(function (e) { return e.level !== "Giám đốc" && !e.suspended; });
    list.sort(function (a, b) {
      var ca = a.level === "Phó giám đốc" ? 0 : 1, cb = b.level === "Phó giám đốc" ? 0 : 1;
      return ca - cb;
    });
    return list;
  }
  function makeTextSprite(text) {
    var canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 64;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(17,24,39,0.85)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(8, 8, 240, 48, 12); ctx.fill(); }
    else ctx.fillRect(8, 8, 240, 48);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var t = String(text || "");
    if (t.length > 14) t = t.slice(0, 13) + "…";
    ctx.fillText(t, 128, 32);
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(2.8, 0.7, 1);
    return sprite;
  }
  function makeBubbleSprite() {
    var canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 96;
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(3.2, 1.2, 1);
    function setText(text) {
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, 256, 96);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(4, 4, 248, 88);
      ctx.fillStyle = "#111827";
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      var t = String(text || "");
      if (t.length > 28) t = t.slice(0, 27) + "…";
      ctx.fillText(t, 128, 48);
      tex.needsUpdate = true;
    }
    setText("");
    return { sprite: sprite, setText: setText };
  }
  function makeRoom3dPerson(e) {
    var cols = avatarColors(e);
    var g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.38, 0.95, 12),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(cols.shirt) }));
    body.position.y = 0.95;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 12),
      new THREE.MeshLambertMaterial({ color: 0xF2C9A0 }));
    head.position.y = 1.72;
    var hair = new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 12),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(cols.hair) }));
    hair.scale.set(1, 0.62, 1);
    hair.position.y = 1.86;
    g.add(body, head, hair);
    var name = makeTextSprite(e.name || "");
    name.position.y = 2.45;
    g.add(name);
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40),
      new THREE.MeshBasicMaterial({ color: 0x16A34A, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 2.85;
    ring.visible = false;
    g.add(ring);
    var blocked = new THREE.Mesh(new THREE.OctahedronGeometry(0.32),
      new THREE.MeshBasicMaterial({ color: 0xDC2626 }));
    blocked.position.y = 3.05;
    blocked.visible = false;
    g.add(blocked);
    var bub = makeBubbleSprite();
    bub.sprite.position.y = 3.6;
    bub.sprite.visible = false;
    g.add(bub.sprite);
    g.userData.personId = e.id;
    g.traverse(function (o) { o.userData.personId = e.id; });
    return { id: e.id, group: g, ring: ring, ringPct: -1, blocked: blocked, blockedBaseY: 3.05, bubble: bub };
  }
  function makeRoom3dDesk(x, z) {
    var g = new THREE.Group();
    var slabMat = new THREE.MeshLambertMaterial({ color: 0xC9BFA8 });
    var slab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.78, 1.0), slabMat);
    slab.position.y = 0.39;
    var screenMat = new THREE.MeshBasicMaterial({ color: 0x374151 });
    var screen = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.06), screenMat);
    screen.position.set(0, 1.15, -0.30);
    var chairMat = new THREE.MeshLambertMaterial({ color: 0x94A3B8 });
    var seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.55), chairMat);
    seat.position.set(0, 0.5, 1.15);
    var back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.12), chairMat);
    back.position.set(0, 0.85, 1.42);
    g.add(slab, screen, seat, back);
    g.position.set(x, 0, z);
    return { group: g, slabMat: slabMat, screenMat: screenMat };
  }
  function buildRoom3d() {
    var st = $("room3dStatus");
    try {
      var canvas = $("room3dCanvas");
      var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = false;
      var scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0B1220);
      var camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
      camera.position.set(20, 20, 20);
      camera.lookAt(0, 0.8, 0);
      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      var dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(10, 20, 8);
      scene.add(dir);
      var floor = new THREE.Mesh(new THREE.BoxGeometry(28, 0.5, 18),
        new THREE.MeshLambertMaterial({ color: 0xD9D2C4 }));
      floor.position.set(0, -0.25, 0);
      scene.add(floor);
      var wallMat = new THREE.MeshLambertMaterial({ color: 0xEDEDE8 });
      var backWall = new THREE.Mesh(new THREE.BoxGeometry(28, 4.5, 0.4), wallMat);
      backWall.position.set(0, 2.25, -9.2);
      var leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.5, 18), wallMat);
      leftWall.position.set(-14.2, 2.25, 0);
      var rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.5, 18), wallMat);
      rightWall.position.set(14.2, 2.25, 0);
      var part1 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 6), wallMat);
      part1.position.set(-7, 1.5, -6);
      var part2 = new THREE.Mesh(new THREE.BoxGeometry(7, 3, 0.4), wallMat);
      part2.position.set(-10.5, 1.5, -3);
      scene.add(backWall, leftWall, rightWall, part1, part2);
      var board = new THREE.Mesh(new THREE.BoxGeometry(7, 3, 0.15),
        new THREE.MeshLambertMaterial({ color: 0x1F2937 }));
      board.position.set(4, 2.2, -8.95);
      scene.add(board);
      var tableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.1, 20),
        new THREE.MeshLambertMaterial({ color: 0xB45309 }));
      tableTop.position.set(10, 0.75, 4);
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.72, 10),
        new THREE.MeshLambertMaterial({ color: 0x6B7280 }));
      leg.position.set(10, 0.36, 4);
      var pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.45, 12),
        new THREE.MeshLambertMaterial({ color: 0xB45309 }));
      pot.position.set(12.6, 0.22, 4);
      var leaf = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10),
        new THREE.MeshLambertMaterial({ color: 0x16A34A }));
      leaf.position.set(12.6, 0.95, 4);
      scene.add(tableTop, leg, pot, leaf);
      R3D.renderer = renderer;
      R3D.scene = scene;
      R3D.camera = camera;
      R3D.boardGroup = new THREE.Group();
      scene.add(R3D.boardGroup);
      R3D.deskParts = [];
      [[-3, -6], [2, -6], [6, -6], [10, -6]].forEach(function (d) {
        var desk = makeRoom3dDesk(d[0], d[1]);
        scene.add(desk.group);
        R3D.deskParts.push(desk);
      });
      var directorDesk = makeRoom3dDesk(-11, -6);
      scene.add(directorDesk.group);
      var selRing = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 40),
        new THREE.MeshBasicMaterial({ color: 0xF59E0B, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      selRing.rotation.x = -Math.PI / 2;
      selRing.visible = false;
      scene.add(selRing);
      R3D.selectionRing = selRing;
      R3D.built = true;
      R3D.peopleIds = "";
      state.messages.forEach(function (m) { R3D.seenMsgIds[m.id] = true; });
      resizeRoom3d();
      refreshRoom3dAll();
      if (st) st.textContent = "";
      if (R3D.mode === "3d") start3dLoop(); else renderRoom3dOnce();
    } catch (e) {
      if (st) st.textContent = "Không khởi tạo được phòng 3D: " + e.message;
      console.warn("room3d:", e);
    }
  }
  function syncRoom3dPeople() {
    var staff = room3dAiStaff().slice(0, 4);
    var ids = staff.map(function (s) { return s.id; }).join(",");
    if (R3D.peopleIds === ids) return;
    R3D.people.forEach(function (p) { R3D.scene.remove(p.group); });
    R3D.people = staff.map(function (e) {
      var p = makeRoom3dPerson(e);
      R3D.scene.add(p.group);
      return p;
    });
    R3D.peopleIds = ids;
  }
  function refreshRoom3dPeople() {
    if (!R3D.built) return;
    syncRoom3dPeople();
    var desks = [{ x: -3, z: -6 }, { x: 2, z: -6 }, { x: 6, z: -6 }, { x: 10, z: -6 }];
    var rests = [{ x: 9, z: 4 }, { x: 11, z: 4 }, { x: 10, z: 5.6 }, { x: 8.6, z: 5.6 }];
    R3D.people.forEach(function (p, i) {
      var pr = presOf(p.id);
      var st = presStateKind(pr);
      var dp = R3D.deskParts[i];
      if (st.kind === "nodata" || st.kind === "offline") {
        p.group.visible = false;
        if (dp) { dp.screenMat.color.set(0x374151); dp.slabMat.color.set(0x6B7280); }
      } else {
        p.group.visible = true;
        if (dp) { dp.screenMat.color.set(0x38BDF8); dp.slabMat.color.set(0xC9BFA8); }
        var pos = (st.kind === "working" || st.kind === "blocked")
          ? { x: desks[i].x, z: desks[i].z + 1.15 }
          : rests[i % rests.length];
        p.group.position.set(pos.x, 0, pos.z);
      }
      var pct = presProgressPct(pr);
      if (st.kind === "working" && pct !== null) {
        p.ring.visible = true;
        if (p.ringPct !== pct) {
          p.ring.geometry.dispose();
          p.ring.geometry = new THREE.RingGeometry(0.55, 0.72, 40, 1, 0, pct / 100 * Math.PI * 2);
          p.ringPct = pct;
        }
      } else {
        p.ring.visible = false;
        p.ringPct = -1;
      }
      p.blocked.visible = (st.kind === "blocked");
    });
    var j;
    for (j = R3D.people.length; j < R3D.deskParts.length; j++) {
      R3D.deskParts[j].screenMat.color.set(0x374151);
      R3D.deskParts[j].slabMat.color.set(0x6B7280);
    }
    renderRoom3dLegend();
    if (R3D.mode === "list") renderRoom3dList();
    if (R3D.selectedId) selectRoom3dPerson(R3D.selectedId);
    if (R3D.reduced) renderRoom3dOnce();
  }
  function refreshRoom3dBoard() {
    if (!R3D.built || !R3D.boardGroup) return;
    while (R3D.boardGroup.children.length) R3D.boardGroup.remove(R3D.boardGroup.children[0]);
    if (!R3D.boardMats) {
      R3D.boardMats = {
        "Chờ nhận": new THREE.MeshBasicMaterial({ color: 0x9CA3AF }),
        "Đã nhận": new THREE.MeshBasicMaterial({ color: 0x38BDF8 }),
        "Đang làm": new THREE.MeshBasicMaterial({ color: 0xF59E0B }),
        "Chờ duyệt": new THREE.MeshBasicMaterial({ color: 0xFB923C })
      };
      R3D.tileGeo = new THREE.BoxGeometry(0.7, 0.4, 0.06);
    }
    var open = state.tasks.filter(function (t) { return t.status !== "Hoàn thành"; }).slice(0, 24);
    open.forEach(function (t, i) {
      var col = i % 8, row = Math.floor(i / 8);
      var tile = new THREE.Mesh(R3D.tileGeo, R3D.boardMats[t.status] || R3D.boardMats["Chờ nhận"]);
      tile.position.set(1.0 + col * 0.8, 3.3 - row * 0.9, -8.82);
      R3D.boardGroup.add(tile);
    });
    if (R3D.reduced) renderRoom3dOnce();
  }
  function refreshRoom3dBubbles(prevIds) {
    if (!R3D.built) return;
    if (state.currentTab !== "3d") {
      state.messages.forEach(function (m) { R3D.seenMsgIds[m.id] = true; });
      return;
    }
    state.messages.forEach(function (m) {
      if (prevIds[m.id] || R3D.seenMsgIds[m.id]) return;
      R3D.seenMsgIds[m.id] = true;
      var p = null, i;
      for (i = 0; i < R3D.people.length; i++) if (R3D.people[i].id === m.senderId) p = R3D.people[i];
      if (p) showRoom3dBubble(p, String(m.content || "").slice(0, 60));
    });
  }
  function showRoom3dBubble(p, text) {
    p.bubble.setText(text);
    p.bubble.sprite.visible = true;
    if (R3D.bubbleTimers[p.id]) clearTimeout(R3D.bubbleTimers[p.id]);
    R3D.bubbleTimers[p.id] = setTimeout(function () { p.bubble.sprite.visible = false; }, 6000);
  }
  function room3dStateDot(kind) {
    if (kind === "working") return '<span class="dot on"></span>';
    if (kind === "blocked") return '<span class="dot late"></span>';
    return '<span class="dot off"></span>';
  }
  function room3dPanelHtml(e, pr, st, task) {
    var pct = presProgressPct(pr);
    return '<div style="display:flex;gap:10px;align-items:center">' + avatarHtml(e, "sm") +
      '<div><b>' + esc(e.name || "") + "</b> · " + esc(e.title || "") + "</div></div>" +
      '<p class="hint">Trạng thái: ' + esc(st.label) + "</p>" +
      '<p>Đang làm: ' + esc((pr && pr.currentWork) || e.currentWork || "—") + "</p>" +
      '<p>Việc: ' + esc(task ? (task.title || "") : (pr && pr.taskId ? pr.taskId : "—")) + "</p>" +
      '<p>Tiến độ: ' + (pct !== null ? pct + "%" : "chưa có dữ liệu") + "</p>" +
      '<p class="hint">Cập nhật lần cuối: ' + esc(presAgeText(pr)) + "</p>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn small" type="button" data-room3d-action="msg" data-room3d-person="' + esc(e.id) + '">Nhắn</button>' +
      (canManage() ? '<button class="btn small" type="button" data-room3d-action="assign" data-room3d-person="' + esc(e.id) + '">Giao việc</button>' : "") +
      "</div>";
  }
  function selectRoom3dPerson(id) {
    R3D.selectedId = id;
    var panel = $("room3dPanel");
    if (!panel) return;
    var e = id ? empById(id) : null;
    if (!e) {
      panel.innerHTML = '<p class="hint">Bấm vào một nhân vật trong phòng để xem chi tiết.</p>';
      if (R3D.selectionRing) R3D.selectionRing.visible = false;
      return;
    }
    var pr = presOf(id);
    var st = presStateKind(pr);
    var task = pr && pr.taskId ? findTask(pr.taskId) : null;
    panel.innerHTML = room3dPanelHtml(e, pr, st, task);
    var p = null, i;
    for (i = 0; i < R3D.people.length; i++) if (R3D.people[i].id === id) p = R3D.people[i];
    if (p && R3D.selectionRing) {
      R3D.selectionRing.visible = true;
      R3D.selectionRing.position.set(p.group.position.x, 0.07, p.group.position.z);
    } else if (R3D.selectionRing) R3D.selectionRing.visible = false;
  }
  function renderRoom3dLegend() {
    var box = $("room3dLegend");
    if (!box) return;
    var staff = room3dAiStaff();
    if (!staff.length) {
      box.innerHTML = '<p class="hint">Chưa có nhân viên nào.</p>';
      return;
    }
    box.innerHTML = staff.map(function (e, i) {
      var pr = presOf(e.id);
      var st = presStateKind(pr);
      return '<div class="health-row">' + avatarHtml(e, "sm") +
        '<div style="flex:1;min-width:0"><b>' + esc(e.name || "") + "</b> · " + room3dStateDot(st.kind) + " " + esc(st.label) +
        '<div class="hint">' + esc((pr && pr.currentWork) || e.currentWork || "—") +
        (i >= 4 ? " · chưa có bàn trong phòng 3D" : "") + "</div></div></div>";
    }).join("");
  }
  function renderRoom3dList() {
    var box = $("room3dList");
    if (!box) return;
    var staff = room3dAiStaff();
    if (!staff.length) {
      box.innerHTML = '<p class="hint">Chưa có nhân viên nào.</p>';
      return;
    }
    box.innerHTML = staff.map(function (e) {
      var pr = presOf(e.id);
      var st = presStateKind(pr);
      var task = pr && pr.taskId ? findTask(pr.taskId) : null;
      return '<div class="card" style="margin-bottom:10px">' + room3dPanelHtml(e, pr, st, task) + "</div>";
    }).join("");
  }
  function refreshRoom3dAll() {
    refreshRoom3dPeople();
    refreshRoom3dBoard();
  }
  function resizeRoom3d() {
    if (!R3D.built) return;
    var wrap = $("room3dCanvasWrap");
    var w = wrap ? wrap.clientWidth : 0;
    var h = wrap ? wrap.clientHeight : 0;
    if (w < 10 || h < 10) { w = 800; h = 420; }
    R3D.renderer.setSize(w, h, false);
    var aspect = w / h;
    var halfH = Math.max(10, 14 / aspect);
    var cam = R3D.camera;
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.updateProjectionMatrix();
  }
  function renderRoom3dOnce() {
    if (R3D.built) R3D.renderer.render(R3D.scene, R3D.camera);
  }
  function room3dLoop(ts) {
    if (!R3D.built || R3D.mode !== "3d" || state.currentTab !== "3d") { R3D.raf = 0; return; }
    if (ts - R3D.lastFrame >= 33) {
      R3D.lastFrame = ts;
      var t = ts / 1000, i;
      for (i = 0; i < R3D.people.length; i++) {
        var p = R3D.people[i];
        if (p.blocked.visible) p.blocked.position.y = p.blockedBaseY + Math.sin(t * 2.2) * 0.12;
      }
      R3D.renderer.render(R3D.scene, R3D.camera);
    }
    R3D.raf = requestAnimationFrame(room3dLoop);
  }
  function start3dLoop() {
    if (!R3D.built) return;
    if (R3D.reduced) { renderRoom3dOnce(); return; }
    if (state.currentTab !== "3d" || R3D.mode !== "3d") return;
    if (R3D.raf) return;
    R3D.lastFrame = 0;
    R3D.raf = requestAnimationFrame(room3dLoop);
  }
  function stop3dLoop() {
    if (R3D.raf) cancelAnimationFrame(R3D.raf);
    R3D.raf = 0;
  }
  function setRoom3dMode(mode) {
    R3D.mode = mode;
    var wrap = $("room3dCanvasWrap"), list = $("room3dList"), btn = $("room3dModeBtn");
    if (wrap) wrap.classList.toggle("hidden", mode !== "3d");
    if (list) list.classList.toggle("hidden", mode !== "list");
    if (btn) btn.textContent = mode === "3d" ? "Chế độ danh sách" : "Chế độ 3D";
    if (mode === "list") { stop3dLoop(); renderRoom3dList(); }
    else { resizeRoom3d(); start3dLoop(); }
  }
  function init3d() {
    var gate = $("room3dGate"), wrap = $("room3dWrap");
    if (!isDirector()) {
      if (gate) gate.classList.remove("hidden");
      if (wrap) wrap.classList.add("hidden");
      return;
    }
    if (gate) gate.classList.add("hidden");
    if (wrap) wrap.classList.remove("hidden");
    if (R3D.built) {
      refreshRoom3dAll();
      if (R3D.mode === "3d") start3dLoop();
      return;
    }
    var st = $("room3dStatus");
    if (typeof THREE !== "undefined") { buildRoom3d(); return; }
    if (R3D.loading) {
      if (st) st.textContent = "Đang tải three.js…";
      return;
    }
    R3D.loading = true;
    if (st) st.textContent = "Đang tải three.js…";
    var script = document.createElement("script");
    script.src = THREE_CDN;
    script.onload = function () {
      R3D.loading = false;
      if (typeof THREE === "undefined") {
        if (st) st.textContent = "Không tải được three.js. Kiểm tra mạng rồi mở lại tab Phòng 3D.";
        return;
      }
      buildRoom3d();
    };
    script.onerror = function () {
      R3D.loading = false;
      if (st) st.textContent = "Không tải được three.js. Kiểm tra mạng rồi mở lại tab Phòng 3D.";
    };
    document.head.appendChild(script);
  }

  /* ---------- Khởi tạo Phase 4 (gọi đầu tiên trong DOMContentLoaded) ---------- */
  function initPhase4() {
    loadHandledMap();
    try { applyTheme(localStorage.getItem("enteesee-theme") || "light"); } catch (e) {}
    var mq = window.matchMedia && window.matchMedia("(max-width: 960px)");
    state.kanbanCol = mq && mq.matches ? TASK_STATUSES[0] : "all";
    function bindSel(id, fn) { var el = $(id); if (el) el.addEventListener("change", fn); }
    function bindChk(id, fn) { var el = $(id); if (el) el.addEventListener("change", fn); }
    bindSel("chatChannelSel", function () { state.chatChannel = $("chatChannelSel").value; renderMessages(); });
    bindSel("chatThreadSel", function () { state.chatThread = $("chatThreadSel").value; renderMessages(); });
    bindSel("chatKindSel", function () { state.chatKind = $("chatKindSel").value; renderMessages(); });
    bindChk("chatNeedsOnly", function () { state.chatNeedsOnly = $("chatNeedsOnly").checked; renderMessages(); });
    bindChk("chatUrgentOnly", function () { state.chatUrgentOnly = $("chatUrgentOnly").checked; renderMessages(); });
    bindChk("chatUnhandledOnly", function () { state.chatUnhandledOnly = $("chatUnhandledOnly").checked; renderMessages(); });
    bindSel("taskAssigneeFilter", function () { state.taskAssigneeFilter = $("taskAssigneeFilter").value; renderTasks(); });
    bindSel("taskPrioFilter", function () { state.taskPrioFilter = $("taskPrioFilter").value; renderTasks(); });
    bindSel("taskRoleFilter", function () { state.taskRoleFilter = $("taskRoleFilter").value; renderTasks(); });
    var vb = $("taskViewBoardBtn");
    if (vb) vb.addEventListener("click", function () { setTaskView("board"); });
    var vt = $("taskViewTreeBtn");
    if (vt) vt.addEventListener("click", function () { setTaskView("tree"); });
    bindSel("themeSelect", function () { setTheme($("themeSelect").value); });
    var nc = $("notifCheck");
    if (nc) {
      try { nc.checked = localStorage.getItem("enteesee-notify") === "1"; } catch (e) {}
      nc.addEventListener("change", function () {
        try { localStorage.setItem("enteesee-notify", nc.checked ? "1" : "0"); } catch (e) {}
        if (nc.checked && "Notification" in window && Notification.permission === "default") {
          try { Notification.requestPermission().catch(function () {}); } catch (e) {}
        }
      });
    }
    var qf = $("quickTaskForm");
    if (qf) qf.addEventListener("submit", onQuickTask);
    var rf = $("railChatForm");
    if (rf) rf.addEventListener("submit", onRailChat);
    var lb = $("logLoadBtn");
    if (lb) lb.addEventListener("click", function () { loadDecisions(); });
    var eb = $("logExportBtn");
    if (eb) eb.addEventListener("click", exportDecisionsLog);
    var ls = $("logSearchInput");
    if (ls) ls.addEventListener("input", function () { renderDecisions(); });
    var mb = $("room3dModeBtn");
    if (mb) mb.addEventListener("click", function () { setRoom3dMode(R3D.mode === "3d" ? "list" : "3d"); });
    var gs = $("globalSearch");
    if (gs) {
      gs.addEventListener("input", renderSearchResults);
      gs.addEventListener("focus", function () { if (gs.value.trim()) renderSearchResults(); });
      gs.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closeSearchPanel(); gs.blur(); } });
    }
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "/") return;
      var ae = document.activeElement;
      if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var s = $("globalSearch");
      if (s) { ev.preventDefault(); s.focus(); }
    });
    document.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".search-wrap")) return;
      closeSearchPanel();
    });
    document.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest(
        "[data-kcol],[data-handled-toggle],[data-highlight-goto],[data-room3d-action],[data-search-item],[data-rail-goto],[data-rail-task],[data-rail-msg]") : null;
      if (!t) return;
      if (t.hasAttribute("data-kcol")) { setKanbanCol(t.getAttribute("data-kcol")); return; }
      if (t.hasAttribute("data-handled-toggle")) { toggleHandledMsg(t.getAttribute("data-handled-toggle")); return; }
      if (t.hasAttribute("data-highlight-goto")) {
        var g = t.getAttribute("data-highlight-goto");
        if (g === "duyet") switchTab("duyet");
        else { setTaskFilterUI("overdue"); switchTab("tasks"); }
        return;
      }
      if (t.hasAttribute("data-room3d-action")) {
        var act = t.getAttribute("data-room3d-action");
        var pid = t.getAttribute("data-room3d-person");
        var e = empById(pid);
        if (!e) return;
        if (act === "msg") {
          switchTab("room");
          var inp = $("messageInput");
          if (inp) {
            inp.value = (inp.value ? inp.value + " " : "") + "@" + (e.name || "") + " ";
            inp.focus();
            try { inp.selectionStart = inp.selectionEnd = inp.value.length; } catch (err) {}
          }
        } else if (act === "assign" && canManage()) {
          switchTab("tasks");
          var as = $("taskAssignee");
          if (as) as.value = pid;
          var tt = $("taskTitle");
          if (tt) { tt.focus(); try { tt.scrollIntoView({ block: "center" }); } catch (err) {} }
        }
        return;
      }
      if (t.hasAttribute("data-search-item")) {
        var type = t.getAttribute("data-search-type"), sid = t.getAttribute("data-search-id");
        closeSearchPanel();
        if (type === "task") openTask(sid);
        else if (type === "msg") { switchTab("room"); jumpToMessage(sid); }
        else if (type === "emp") openProfile(sid);
        else if (type === "dec") { switchTab("log"); if (!state.decisionsLoaded) loadDecisions(); }
        return;
      }
      if (t.hasAttribute("data-rail-goto")) { switchTab(t.getAttribute("data-rail-goto")); return; }
      if (t.hasAttribute("data-rail-task")) { openTask(t.getAttribute("data-rail-task")); return; }
      if (t.hasAttribute("data-rail-msg")) { switchTab("room"); jumpToMessage(t.getAttribute("data-rail-msg")); return; }
    });
    var ml = $("messageList");
    if (ml) {
      var sx = 0, sy = 0;
      ml.addEventListener("touchstart", function (ev) {
        var t0 = ev.touches[0];
        sx = t0.clientX; sy = t0.clientY;
      }, { passive: true });
      ml.addEventListener("touchend", function (ev) {
        var t0 = ev.changedTouches[0];
        var dx = t0.clientX - sx, dy = t0.clientY - sy;
        if (dx > 60 && Math.abs(dy) < 40) {
          var item = ev.target && ev.target.closest ? ev.target.closest(".msg") : null;
          if (!item) return;
          if (ev.target.closest("button,a")) return;
          var mid = item.getAttribute("data-msg-id");
          var m = null, i;
          for (i = 0; i < state.messages.length; i++) if (state.messages[i].id === mid) m = state.messages[i];
          if (!m) return;
          var inp = $("messageInput");
          if (inp) {
            inp.value = (inp.value ? inp.value + " " : "") + "@" + (m.senderName || "") + " ";
            inp.focus();
          }
        }
      });
    }
    var cvs = $("room3dCanvas");
    if (cvs) {
      var downX = 0, downY = 0;
      cvs.addEventListener("pointerdown", function (ev) { downX = ev.clientX; downY = ev.clientY; });
      cvs.addEventListener("pointerup", function (ev) {
        if (Math.abs(ev.clientX - downX) > 6 || Math.abs(ev.clientY - downY) > 6) return;
        if (!R3D.built) return;
        var rect = cvs.getBoundingClientRect();
        var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        var ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        var ray = new THREE.Raycaster();
        ray.setFromCamera({ x: nx, y: ny }, R3D.camera);
        var hits = ray.intersectObjects(R3D.scene.children, true);
        var id = null, i, o;
        for (i = 0; i < hits.length; i++) {
          o = hits[i].object;
          while (o) {
            if (o.userData && o.userData.personId) { id = o.userData.personId; break; }
            o = o.parent;
          }
          if (id) break;
        }
        selectRoom3dPerson(id);
      });
    }
    window.addEventListener("resize", function () {
      if (R3D.built && state.currentTab === "3d" && R3D.mode === "3d") resizeRoom3d();
    });
  }

  /* ---------- Khởi động ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    initPhase4();
    $("loginForm").addEventListener("submit", onLoginSubmit);
    $("logoutBtn").addEventListener("click", doLogout);
    $("noProfileLogout").addEventListener("click", doLogout);
    $("messageForm").addEventListener("submit", onSendMessage);
    var msgInput = $("messageInput");
    msgInput.addEventListener("input", function (ev) {
      updateMentionBox(!!(ev.inputType && ev.inputType.indexOf("delete") === 0));
    });
    msgInput.addEventListener("click", function () { updateMentionBox(false); });
    msgInput.addEventListener("keyup", function (ev) {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End") {
        updateMentionBox(false);
      }
    });
    msgInput.addEventListener("keydown", onMessageKeydown);
    msgInput.addEventListener("blur", function () { setTimeout(closeMentionBox, 150); });
    /* Ô soạn tin tự giãn chiều cao theo nội dung (tối thiểu theo CSS, tối đa 120px);
       gửi xong thì thu về chiều cao mặc định. */
    msgInput.addEventListener("input", function () {
      msgInput.style.height = "auto";
      msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
    });
    $("messageForm").addEventListener("submit", function () {
      setTimeout(function () { msgInput.style.height = ""; }, 0);
    });
    $("mentionBox").addEventListener("mousedown", function (ev) {
      var it = ev.target && typeof ev.target.closest === "function"
        ? ev.target.closest("[data-mention-idx]") : null;
      if (!it) return;
      ev.preventDefault(); /* giữ focus trong ô soạn, chọn trước khi blur kịp đóng hộp */
      pickMention(Number(it.getAttribute("data-mention-idx")));
    });
    $("attachInput").addEventListener("change", onAttachChange);
    $("messageKind").addEventListener("change", function () {
      $("taskAssignWrap").classList.toggle("hidden", $("messageKind").value !== "Giao việc");
    });
    $("taskForm").addEventListener("submit", onCreateTask);
    $("empForm").addEventListener("submit", onEmpSubmit);
    $("empCancelEdit").addEventListener("click", function () {
      resetEmpForm();
      $("empFormError").classList.add("hidden");
      $("empFormSuccess").classList.add("hidden");
    });
    $("intervalSave").addEventListener("click", onSaveInterval);
    var ackSaveBtn = $("ackTimeoutSave");
    if (ackSaveBtn) ackSaveBtn.addEventListener("click", onSaveAckTimeout);
    $("passwordSave").addEventListener("click", onChangePassword);
    /* Bảo mật 2FA của Giám đốc: cổng xác minh + thẻ bảo mật + trình bật 2FA */
    $("gateForm").addEventListener("submit", onGateSubmit);
    $("gateLogout").addEventListener("click", doLogout);
    $("gateRetry").addEventListener("click", function () { location.reload(); });
    $("secEnableBtn").addEventListener("click", openTwofaModal);
    $("secDisableBtn").addEventListener("click", onSecDisable);
    $("tfClose").addEventListener("click", closeTwofaModal);
    $("twofaModal").addEventListener("click", function (ev) {
      if (ev.target === $("twofaModal")) closeTwofaModal();
    });
    $("tfNext1").addEventListener("click", onTfStep1);
    $("tfNext2").addEventListener("click", function () { tfError(3, ""); tfGoStep(3); setTimeout(function () { $("tfCode").focus(); }, 60); });
    $("tfNext3").addEventListener("click", onTfStep3);
    $("tfSavedChk").addEventListener("change", function () {
      $("tfFinish").disabled = !$("tfSavedChk").checked;
    });
    $("tfFinish").addEventListener("click", onTfFinish);
    $("bellBtn").addEventListener("click", toggleBell);
    var decBtn = $("decisionsLoadBtn");
    if (decBtn) decBtn.addEventListener("click", loadDecisions);
    $("profileClose").addEventListener("click", closeProfile);
    $("taskClose").addEventListener("click", closeTask);
    $("profileModal").addEventListener("click", function (ev) {
      if (ev.target === $("profileModal")) closeProfile();
    });
    $("taskModal").addEventListener("click", function (ev) {
      if (ev.target === $("taskModal")) closeTask();
    });
    var tabs = document.querySelectorAll("#tabBar .tab");
    tabs.forEach(function (tb) {
      tb.addEventListener("click", function () { switchTab(tb.getAttribute("data-tab")); });
    });
    var moreItems = document.querySelectorAll("#moreMenu [data-more-goto]");
    moreItems.forEach(function (mi) {
      mi.addEventListener("click", function () { closeMoreMenu(); switchTab(mi.getAttribute("data-more-goto")); });
    });
    var filters = document.querySelectorAll("#taskFilters .filter-btn");
    filters.forEach(function (fb) {
      fb.addEventListener("click", function () {
        state.taskFilter = fb.getAttribute("data-filter") || "all";
        filters.forEach(function (x) { x.classList.toggle("active", x === fb); });
        renderTasks();
      });
    });
    /* Bảng việc trên mobile: vuốt ngang snap từng cột — cập nhật chấm chỉ thị theo vị trí cuộn */
    var boardEl = $("taskBoard");
    if (boardEl) {
      boardEl.addEventListener("scroll", function () {
        var col = boardEl.querySelector(".board-col");
        if (!col) return;
        var w = col.offsetWidth + 10;
        if (!w) return;
        var idx = Math.max(0, Math.min(3, Math.round(boardEl.scrollLeft / w)));
        if (idx !== state.boardIdx) {
          state.boardIdx = idx;
          var dots = document.querySelectorAll("#boardDots .bdot");
          dots.forEach(function (d, i) { d.classList.toggle("active", i === idx); });
        }
      }, { passive: true });
    }

    if (!initFirebase()) {
      $("loginBtn").disabled = true;
      return;
    }

    auth.onAuthStateChanged(function (user) {
      if (!user) {
        stopListeners();
        stopCheckin();
        stopClock();
        stop3dLoop();
        showLogin();
        return;
      }
      state.user = user;
      loadMyProfile(user).then(function (ok) {
        if (ok) {
          enterAppAfterSecurity(user);
        } else {
          showNoProfile(user.email);
        }
      }).catch(function (e) {
        console.warn("load profile:", e);
        showNoProfile(user.email);
      });
    });
  });
})();
