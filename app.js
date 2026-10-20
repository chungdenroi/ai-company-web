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
    checkIntervalMinutes: 10,
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
  function avatarHtml(e, sizeCls) {
    var color = (e && e.color) || "#4f46e5";
    var name = e ? (e.name || "") : "?";
    return '<span class="avatar ' + (sizeCls || "") + '" style="background:' + esc(color) + '">' + esc(initial(name)) + '</span>';
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

  /* Trạng thái kiểm tra phòng họp: luật áp dụng cho TẤT CẢ nhân viên.
     - provisioning "pending": Chờ mở trình duyệt
     - chưa từng có lastCheckAt: Chưa từng vào phòng họp
     - quá chu kỳ: Quá hạn kiểm tra. Đúng chu kỳ: Kiểm tra đúng hạn */
  function checkInfo(e) {
    if (e.provisioning === "pending") {
      return { kind: "wait", text: "Chờ mở trình duyệt", cls: "chip check-wait" };
    }
    var iv = state.checkIntervalMinutes || 10;
    var last = tsMillis(e.lastCheckAt);
    if (!last) {
      return { kind: "never", text: "Chưa từng vào phòng họp", cls: "chip check-wait" };
    }
    if ((Date.now() - last) > iv * 60000) {
      return { kind: "late", text: "Quá hạn kiểm tra", cls: "chip check-late" };
    }
    return { kind: "ok", text: "Kiểm tra đúng hạn", cls: "chip check-ok" };
  }
  function checkChipHtml(e) {
    if (e.suspended) return "";
    var ci = checkInfo(e);
    return '<span class="' + ci.cls + '">' + ci.text + '</span>';
  }

  /* Hiện diện: MỘT hàm suy trạng thái duy nhất từ lastCheckAt, dùng ở mọi nơi
     (header, dải hiện diện, thẻ nhân viên, cây tổ chức, hồ sơ chi tiết).
     Trực tuyến nếu lần kiểm tra gần nhất trong vòng chu kỳ + 2 phút ân hạn —
     ân hạn này tránh chấm trạng thái nhấp nháy giữa hai lần check-in liên tiếp. */
  function presenceOf(e) {
    var iv = state.checkIntervalMinutes || 10;
    if (e.suspended) {
      return { state: "suspended", online: false, dot: "dot off", label: "Tạm ngưng", sub: "" };
    }
    if (e.provisioning === "pending") {
      return { state: "pending", online: false, dot: "dot off", label: "Chờ mở trình duyệt", sub: "Chưa kích hoạt tài khoản" };
    }
    var last = tsMillis(e.lastCheckAt);
    if (!last) {
      return { state: "never", online: false, dot: "dot off", label: "Chưa từng vào phòng họp", sub: "" };
    }
    var age = Date.now() - last;
    if (age <= (iv + 2) * 60000) {
      return { state: "online", online: true, dot: "dot on", label: "Đang trực tuyến", sub: "Kiểm tra lúc " + fmtClock(e.lastCheckAt) };
    }
    return { state: "recent", online: false, dot: "dot late", label: "Hoạt động " + fmtRel(e.lastCheckAt) + " trước", sub: fmtTime(e.lastCheckAt) };
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
    auth.signInWithEmailAndPassword(email, pw)
      .catch(function (err) {
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
    $("noProfileView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("currentUserLabel").textContent = state.me.name + " — " + state.me.title;
    $("taskForm").classList.toggle("hidden", !canManage());
    $("empFormCard").classList.toggle("hidden", !isDirector());
    var canEdit = isDirector();
    $("intervalInput").disabled = !canEdit;
    $("intervalSave").disabled = !canEdit;
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
    var lastMs = mine ? tsMillis(mine.lastCheckAt) : null;
    if (!lastMs && state.lastCheckinAt) lastMs = state.lastCheckinAt;
    var label;
    if (lastMs) label = "Đang trực tuyến · kiểm tra lúc " + fmtClock(lastMs);
    else if (state.me.realDoc) label = "Đang trực tuyến · đang điểm danh…";
    else label = "Đang trực tuyến";
    chip.innerHTML = '<span class="dot on"></span>' + esc(label);
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
    state.messages = []; state.tasks = []; state.employees = []; state.activities = [];
    state.pendingFiles = [];
    $("appView").classList.add("hidden");
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
        renderApproval();
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
        var v = doc.exists ? doc.data().checkIntervalMinutes : null;
        var n = parseInt(v, 10);
        var next = (!isNaN(n) && n > 0) ? n : 10;
        var changed = next !== state.checkIntervalMinutes;
        state.checkIntervalMinutes = next;
        var input = $("intervalInput");
        if (document.activeElement !== input) input.value = String(next);
        if (changed && state.user) {
          startCheckin();
          renderOverview();
          renderEmployeesTab();
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
    }
  }

  /* ---------- Chuông thông báo ---------- */
  function canApprove() { return canManage(); }
  function bellData() {
    var unread = unreadCount();
    var mine = [];
    var review = [];
    if (state.me) {
      mine = state.tasks.filter(function (t) {
        return t.assigneeId === state.me.id && t.status === "Chờ nhận";
      });
      if (canApprove()) {
        review = state.tasks.filter(function (t) { return t.status === "Chờ duyệt"; });
      }
    }
    return { unread: unread, mine: mine, review: review, total: unread + mine.length + review.length };
  }
  function renderBell() {
    var badge = $("bellBadge");
    if (!badge || !state.me) return;
    var b = bellData();
    badge.textContent = String(b.total);
    badge.classList.toggle("hidden", b.total === 0);
    if (!$("bellPanel").classList.contains("hidden")) renderBellList(b);
  }
  function renderBellList(b) {
    var box = $("bellList");
    if (!box) return;
    var html = "";
    if (b.unread > 0) {
      html += '<div class="bell-item" data-goto="room"><span class="dot late" style="margin-top:6px"></span>' +
        '<div class="b-text"><b>' + b.unread + ' tin phòng họp chưa đọc</b>' +
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
        '<div class="pin-content">' + esc(m.content || "") +
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
      var cls = "msg" + (m.kind === "Giao việc" ? " is-task" : "") + (m.kind === "Thông báo" ? " is-notice" : "");
      var pinRow = "";
      if (m.kind === "Thông báo" && canManage()) {
        pinRow = '<div class="pin-row"><button class="btn ghost small" type="button" data-pin="' + esc(m.id) +
          '" data-state="' + (m.pinned ? "1" : "0") + '">' + (m.pinned ? "Bỏ ghim thông báo" : "Ghim thông báo") + "</button></div>";
      }
      return '<div class="' + cls + '">' +
        avatarHtml(colorEmp, "sm") +
        '<div class="msg-body">' +
          '<div class="meta">' +
            '<span class="sender">' + esc(m.senderName || "") + "</span>" +
            (m.senderTitle ? '<span class="title">' + esc(m.senderTitle) + "</span>" : "") +
            '<span class="' + kindClass(m.kind) + '">' + esc(m.kind || "Trao đổi") + "</span>" +
            (m.pinned ? '<span class="chip" style="background:#ede9fe;color:#5b21b6">Đã ghim</span>' : "") +
            '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span>" +
          "</div>" +
          (m.content ? '<div class="content">' + esc(m.content) + "</div>" : "") +
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
  function isOverdue(t) {
    if (!t || t.status === "Hoàn thành") return false;
    var ms = tsMillis(t.dueAt);
    return !!ms && ms < Date.now();
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

  function setTaskStatus(t, newStatus) {
    if (!db || !t) return Promise.resolve();
    return db.collection("tasks").doc(t.id).update({
      status: newStatus, updatedAt: serverTimestamp()
    }).then(function () {
      if (newStatus === "Hoàn thành") {
        logActivity("đã hoàn thành việc “" + (t.title || "") + "”", "task");
      } else {
        logActivity("đã chuyển việc “" + (t.title || "") + "” sang trạng thái " + newStatus, "task");
      }
    }).catch(function (e) { console.warn("update task status:", e); });
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
      html += '<div class="board-col"><h3>' + esc(status) +
        ' <span class="chip count">' + col.length + "</span></h3>";
      if (!col.length) html += '<p class="col-empty">Không có việc nào.</p>';
      col.forEach(function (t) {
        var opts = TASK_STATUSES.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === t.status ? " selected" : "") + ">" + esc(s) + "</option>";
        }).join("");
        html += '<div class="task-card' + (isOverdue(t) ? " overdue" : "") + '" data-task-id="' + esc(t.id) + '">' +
          '<div class="t-title">' + esc(t.title || "") + "</div>" +
          (t.description ? '<div class="t-desc">' + esc(t.description) + "</div>" : "") +
          '<div class="t-tags"><span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + "</span>" +
            dueChipHtml(t) +
            '<button class="chip" type="button" data-taskopen="' + esc(t.id) + '" style="cursor:pointer">Bình luận: ' + commentCount(t) + "</button></div>" +
          '<div class="t-meta">Phụ trách: <b>' + esc(empName(t.assigneeId)) + "</b> · Giao bởi: " + esc(empName(t.assignerId)) +
          (t.updatedAt ? " · Cập nhật: " + esc(fmtTime(t.updatedAt)) : "") + "</div>" +
          '<div class="row"><span>Trạng thái:</span><select class="task-status">' + opts + "</select></div>" +
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
      sel.addEventListener("change", function () {
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
      resultNote: "",
      dueAt: due,
      comments: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }).then(function () {
      $("taskTitle").value = "";
      $("taskDesc").value = "";
      $("taskDue").value = "";
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
    if (ae && (ae.id === "tmCommentInput" || ae.id === "tmNote")) return;
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
      return '<option value="' + esc(s) + '"' + (s === t.status ? " selected" : "") + ">" + esc(s) + "</option>";
    }).join("");
    var commentsHtml = comments.length ? comments.map(function (c) {
      return '<div class="comment-item"><div class="c-head"><b>' + esc(c.authorName || "") + "</b> · " +
        esc(fmtTime(c.createdAt)) + '</div><div class="c-body">' + esc(c.content || "") + "</div></div>";
    }).join("") : '<p class="hint">Chưa có bình luận nào.</p>';

    box.innerHTML =
      '<div class="profile-head"><div><div class="p-name" style="font-size:1.2rem">' + esc(t.title || "") + "</div>" +
      '<div class="p-chips"><span class="' + statusChipClass(t.status) + '">' + esc(t.status) + "</span>" +
      '<span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + "</span>" + dueChipHtml(t) + "</div></div></div>" +
      "<dl>" +
        "<dt>Phụ trách</dt><dd>" + esc(empName(t.assigneeId)) + "</dd>" +
        "<dt>Người giao</dt><dd>" + esc(empName(t.assignerId)) + "</dd>" +
        "<dt>Hạn hoàn thành</dt><dd>" + (t.dueAt ? esc(fmtDate(t.dueAt)) : "Chưa đặt") + "</dd>" +
        "<dt>Tạo lúc</dt><dd>" + esc(fmtTime(t.createdAt)) + "</dd>" +
        "<dt>Cập nhật</dt><dd>" + esc(fmtTime(t.updatedAt)) + "</dd>" +
      "</dl>" +
      (t.description ? "<h3>Mô tả</h3><div style='white-space:pre-wrap;word-break:break-word'>" + esc(t.description) + "</div>" : "") +
      "<h3>Cập nhật việc</h3>" +
      '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
        '<div style="flex:1;min-width:150px"><label for="tmStatus" style="margin-top:0">Trạng thái</label><select id="tmStatus">' + statusOpts + "</select></div>" +
        '<div style="flex:1;min-width:150px"><label for="tmDue" style="margin-top:0">Hạn hoàn thành</label><input type="date" id="tmDue" value="' + esc(timestampToDateInput(t.dueAt)) + '"></div>' +
      "</div>" +
      '<label for="tmNote">Ghi chú kết quả</label>' +
      '<textarea id="tmNote" rows="2" placeholder="Ghi chú kết quả...">' + esc(t.resultNote || "") + "</textarea>" +
      '<div style="margin-top:10px"><button class="btn primary small" type="button" id="tmSave">Lưu thay đổi</button> ' +
      '<span id="tmMsg" class="ok-text hidden">Đã lưu.</span></div>' +
      "<h3>Bình luận (" + comments.length + ")</h3>" +
      '<div id="tmComments">' + commentsHtml + "</div>" +
      '<div class="comment-form"><textarea id="tmCommentInput" rows="2" placeholder="Viết bình luận..."></textarea>' +
      '<button class="btn primary" type="button" id="tmCommentBtn">Gửi</button></div>';

    $("tmSave").addEventListener("click", function () {
      var newStatus = $("tmStatus").value;
      var patch = {
        resultNote: $("tmNote").value,
        dueAt: dateInputToTimestamp($("tmDue").value),
        updatedAt: serverTimestamp()
      };
      var statusChanged = newStatus !== t.status;
      if (statusChanged) patch.status = newStatus;
      db.collection("tasks").doc(t.id).update(patch).then(function () {
        var msg = $("tmMsg");
        if (msg) { msg.classList.remove("hidden"); setTimeout(function () { msg.classList.add("hidden"); }, 2000); }
        if (statusChanged) {
          if (newStatus === "Hoàn thành") logActivity("đã hoàn thành việc “" + (t.title || "") + "”", "task");
          else logActivity("đã chuyển việc “" + (t.title || "") + "” sang trạng thái " + newStatus, "task");
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
      return (tsMillis(b.lastCheckAt) || 0) - (tsMillis(a.lastCheckAt) || 0);
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

  function renderApproval() {
    var sec = $("approvalSection"), box = $("approvalList");
    if (!sec || !box) return;
    if (!canApprove()) {
      sec.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    var list = state.tasks.filter(function (t) { return t.status === "Chờ duyệt"; });
    sec.classList.toggle("hidden", !list.length);
    box.innerHTML = list.map(function (t) {
      return '<div class="approval-item"><div class="ap-title">' + esc(t.title || "") +
        '<div class="ap-meta">Phụ trách: ' + esc(empName(t.assigneeId)) + " · Giao bởi: " + esc(empName(t.assignerId)) + "</div></div>" +
        '<button class="btn primary small" type="button" data-approve="' + esc(t.id) + '">Duyệt — Hoàn thành</button>' +
        '<button class="btn ghost small" type="button" data-return="' + esc(t.id) + '">Trả lại — Đang làm</button></div>';
    }).join("");
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
          "<dt>Mã truy cập</dt><dd class=\"mono\">" + esc(e.accessCode || "—") + "</dd>" +
          "<dt>Kiểm tra phòng gần nhất</dt><dd>" + (e.lastCheckAt ? esc(fmtTime(e.lastCheckAt)) + " (" + esc(fmtRel(e.lastCheckAt)) + " trước)" : "Chưa từng vào phòng họp") + "</dd>" +
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
    var p = presenceOf(e);

    var subsHtml = subs.length
      ? '<div class="sub-list">' + subs.map(function (s) {
          return '<button class="sub-item" type="button" data-profile="' + esc(s.id) + '">' +
            avatarHtml(s, "sm") + esc(s.name || "") + "</button>";
        }).join("") + "</div>"
      : '<p class="hint">Không có cấp dưới.</p>';

    var tasksHtml = myTasks.length
      ? myTasks.map(function (t) {
          return '<div class="mini-task"><span class="mt-title">' + esc(t.title || "") + "</span>" +
            '<span class="' + statusChipClass(t.status) + '">' + esc(t.status) + "</span>" +
            '<span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + "</span>" +
            '<button class="link-btn" type="button" data-taskopen="' + esc(t.id) + '" style="margin-left:auto">Mở việc</button></div>';
        }).join("")
      : '<p class="hint">Chưa được giao việc nào.</p>';

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
        "<dt>Hiện diện</dt><dd>" + esc(p.label) + (p.sub ? " · " + esc(p.sub) : "") + "</dd>" +
        "<dt>Trạng thái</dt><dd>" + esc(e.status || "—") + (e.suspended ? " (đang tạm ngưng)" : "") + "</dd>" +
        "<dt>Đang làm</dt><dd>" + esc(e.currentWork || "—") + "</dd>" +
        "<dt>Cấp trên</dt><dd>" + (mgr
          ? '<button class="link-btn" type="button" data-profile="' + esc(mgr.id) + '">' + esc(mgr.name) + "</button>"
          : "— Cấp cao nhất") + "</dd>" +
        "<dt>Kiểm tra phòng gần nhất</dt><dd>" + (e.lastCheckAt
          ? esc(fmtTime(e.lastCheckAt)) + " (" + esc(fmtRel(e.lastCheckAt)) + " trước)"
          : "Chưa từng vào phòng họp") + "</dd>" +
        "<dt>Trạng thái kiểm tra</dt><dd>" + (e.suspended ? "Đang tạm ngưng" : esc(checkInfo(e).text)) + "</dd>" +
        "<dt>Kích hoạt</dt><dd>" + (e.provisioning === "pending" ? "Chờ mở trình duyệt (provisioning: pending)" : "Đã kích hoạt") + "</dd>" +
        "<dt>Tài khoản Muse</dt><dd>" + esc(e.accountLabel || "—") + "</dd>" +
        "<dt>Hồ sơ trình duyệt</dt><dd>" + esc(e.browserProfile || "—") + "</dd>" +
        "<dt>Email đăng nhập</dt><dd>" + esc(e.loginEmail || "—") + "</dd>" +
        "<dt>Mã truy cập</dt><dd class=\"mono\">" + esc(e.accessCode || "—") + "</dd>" +
      "</dl>" +
      '<div class="profile-stats">' +
        '<div class="ps"><b>' + open + "</b><span>Việc đang mở</span></div>" +
        '<div class="ps"><b>' + done + "</b><span>Việc hoàn thành</span></div>" +
        '<div class="ps"><b>' + given + "</b><span>Việc đã giao</span></div>" +
        '<div class="ps"><b>' + sent + "</b><span>Tin đã gửi</span></div>" +
      "</div>" +
      "<h3>Cấp dưới (" + subs.length + ")</h3>" + subsHtml +
      "<h3>Công việc được giao (" + myTasks.length + ")</h3>" + tasksHtml;
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
      if (ta) setTaskStatus(ta, "Hoàn thành");
      return;
    }
    var rt = t.closest("[data-return]");
    if (rt) {
      var tr = findTask(rt.getAttribute("data-return"));
      if (tr) setTaskStatus(tr, "Đang làm");
      return;
    }
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
    $("passwordSave").addEventListener("click", onChangePassword);
    $("bellBtn").addEventListener("click", toggleBell);
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
          enterApp();
          switchTab("overview");
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
