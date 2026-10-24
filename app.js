/* Công ty Enteesee — logic ứng dụng (Firebase Auth + Firestore, bản compat)
   Đính kèm tệp: lưu trong Firestore collection `files` dạng mảnh base64 (không dùng Storage). */
(function () {
  "use strict";

  var DIRECTOR_EMAIL = window.DIRECTOR_EMAIL || "";
  var cfg = window.FIREBASE_CONFIG || {};
  var CONFIGURED = !!cfg.apiKey && cfg.apiKey !== "CHUA_CO";

  var TASK_STATUSES = ["Chờ nhận", "Đang làm", "Chờ duyệt", "Hoàn thành"];
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
    var color = (e && e.color) || "#4f46e5";
    var name = e ? (e.name || "") : "?";
    var pair = pastelFor(color);
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
        state.messages = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderMessages();
        renderPinned();
        if (state.currentTab === "room") markRoomRead(); else { refreshUnreadBadge(); renderBell(); }
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
        renderTaskModalIfOpen();
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
        renderSelfStatus();
      }, function (e) { console.warn("employees listener:", e); })
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
  var TABS = ["overview", "org", "room", "tasks", "employees", "settings"];
  function switchTab(name) {
    state.currentTab = name;
    var tabs = document.querySelectorAll("#tabBar .tab");
    tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
    TABS.forEach(function (k) {
      $("tab-" + k).classList.toggle("hidden", k !== name);
    });
    if (name === "room") {
      markRoomRead();
      scrollMessagesBottom();
    } else {
      closeMentionBox();
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
    if (!state.messages.length) {
      box.innerHTML = '<p class="hint" style="text-align:center">Chưa có tin nhắn nào. Hãy gửi tin đầu tiên.</p>';
      return;
    }
    box.innerHTML = state.messages.map(function (m) {
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
            (m.pinned ? '<span class="chip" style="background:#ede9fe;color:#5b21b6">Đã ghim</span>' : "") +
            '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span>" +
          "</div>" +
          (m.content ? '<div class="content">' + formatContentHtml(m.content, m.mentions, state.employees, state.me ? state.me.id : null) + "</div>" : "") +
          attachmentsHtml(m) +
          (m.linkedTaskTitle ? '<span class="linked-task">Đã tạo việc: ' + esc(m.linkedTaskTitle) + "</span>" : "") +
          pinRow +
        "</div>" +
      "</div>";
    }).join("");
    hydrateImages();
    scrollMessagesBottom();
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
    return list;
  }
  function commentCount(t) { return (t.comments || []).length; }

  function renderAssigneeOptions() {
    var opts = state.employees.filter(function (e) { return !e.suspended; }).map(function (e) {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.title ? " — " + esc(e.title) : "") + "</option>";
    }).join("");
    ["taskAssignee", "msgTaskAssignee"].forEach(function (id) {
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
     với đổi trạng thái thường, nhưng vẫn ghi lịch sử + activity. */
  function acknowledgeTask(t) {
    if (!db || !state.me || !t || state.me.id !== t.assigneeId) return;
    var ev = {
      actorId: state.me.id,
      actorName: state.me.name,
      from: "Chờ nhận",
      to: "Đang làm",
      note: "Đã xác nhận nhận việc",
      at: firebase.firestore.Timestamp.now()
    };
    db.collection("tasks").doc(t.id).update({
      status: "Đang làm", updatedAt: serverTimestamp(),
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
      html += '<div class="board-col"><h3>' + esc(statusText(status)) +
        ' <span class="chip count">' + col.length + "</span></h3>";
      if (!col.length) html += '<p class="col-empty">Không có việc nào.</p>';
      col.forEach(function (t) {
        var opts = TASK_STATUSES.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === t.status ? " selected" : "") + ">" + esc(statusText(s)) + "</option>";
        }).join("");
        var needsAck = !!(state.me && state.me.id === t.assigneeId && t.status === "Chờ nhận");
        html += '<div class="task-card' + (isOverdue(t) ? " overdue" : "") + '" data-task-id="' + esc(t.id) + '">' +
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
    if (!state.employees.length) {
      grid.innerHTML = '<p class="hint">Chưa có hồ sơ nhân viên nào.</p>';
    } else {
      grid.innerHTML = state.employees.map(function (e) {
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
          '<div class="e-work">Đang làm: ' + esc(e.currentWork || "—") + "</div>" +
          '<div class="e-foot"><span>Việc đang mở: <b>' + openTasksOf(e.id) + "</b></span>" +
            "<span>" + esc(p.label) + (p.sub ? " · " + esc(p.sub) : "") + "</span></div>" +
        "</div>";
      }).join("");
    }
    renderPresence();
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
        '<div class="pstrip-work">' + esc(e.currentWork || "—") + "</div>" +
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
      return;
    }
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
    box.innerHTML = state.decisions.map(function (d) {
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
    }).join("");
    if (st) st.textContent = "Đã tải " + state.decisions.length + " quyết định mới nhất.";
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
    openTasks.forEach(function (t) { if (t.role && jobRoles.indexOf(t.role) === -1) jobRoles.push(t.role); });
    var reviewCount = myTasks.filter(function (t) { return t.status === "Chờ duyệt"; }).length;
    var unackedCount = myTasks.filter(function (t) { return t.status === "Chờ nhận"; }).length;
    var ackOverdueCount = myTasks.filter(isAckOverdue).length;
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

  /* ---------- Khởi động ---------- */
  document.addEventListener("DOMContentLoaded", function () {
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
