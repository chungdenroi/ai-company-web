/* Công Ty AI — logic ứng dụng (Firebase Auth + Firestore, bản compat) */
(function () {
  "use strict";

  var DIRECTOR_EMAIL = window.DIRECTOR_EMAIL || "";
  var cfg = window.FIREBASE_CONFIG || {};
  var CONFIGURED = !!cfg.apiKey && cfg.apiKey !== "CHUA_CO";

  var TASK_STATUSES = ["Chờ nhận", "Đang làm", "Chờ duyệt", "Hoàn thành"];
  var MSG_KINDS = ["Trao đổi", "Giao việc", "Cập nhật tiến độ", "Báo cáo kết quả"];

  var state = {
    user: null,          // firebase.User
    me: null,            // {id, name, title, level, role, ...} — hồ sơ nhân viên của người đang đăng nhập
    employees: [],       // [{id, ...data}]
    messages: [],        // [{id, ...data}]
    tasks: [],           // [{id, ...data}]
    checkIntervalMinutes: 10,
    checkinTimer: null,
    currentTab: "room",
    unsub: []            // các hàm hủy listener Firestore
  };

  var auth = null, db = null;
  var serverTimestamp = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtTime(ts) {
    if (!ts) return "";
    var d = null;
    if (typeof ts.toDate === "function") d = ts.toDate();
    else if (ts.seconds) d = new Date(ts.seconds * 1000);
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleString("vi-VN", { hour12: false });
  }

  function tsMillis(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    return null;
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
  function mySenderId() { return state.me ? state.me.id : ""; }

  function refreshUnreadBadge() {
    var badge = $("unreadBadge");
    if (!badge || !state.me) return;
    var last = getLastReadAt();
    var count = 0;
    state.messages.forEach(function (m) {
      var t = tsMillis(m.createdAt);
      if (t === null) t = Date.now(); // tin đang chờ serverTimestamp: coi như mới
      if (t > last && m.senderId !== mySenderId()) count++;
    });
    if (state.currentTab === "room") count = 0;
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
    if (auth) auth.signOut();
  }

  /* ---------- Hồ sơ người dùng ---------- */
  function loadMyProfile(user) {
    var email = (user.email || "").toLowerCase();
    return db.collection("employees").where("loginEmail", "==", user.email).limit(1).get()
      .then(function (snap) {
        if (!snap.empty) {
          var doc = snap.docs[0];
          var d = doc.data();
          state.me = {
            id: doc.id, name: d.name || "", title: d.title || "", level: d.level || "",
            role: d.role || "", realDoc: true
          };
          return true;
        }
        if (email === String(DIRECTOR_EMAIL).toLowerCase()) {
          // Giám đốc: dùng hồ sơ mặc định nếu chưa có bản ghi employees
          state.me = {
            id: "director", name: "Chung", title: "Giám đốc", level: "Giám đốc",
            role: "Điều hành chung", realDoc: false
          };
          return true;
        }
        return false;
      });
  }

  function isDirector() {
    return !!state.me && state.me.level === "Giám đốc";
  }
  function canCreateTask() {
    return !!state.me && (state.me.level === "Giám đốc" || state.me.level === "Phó giám đốc");
  }

  /* ---------- Vào / ra ứng dụng ---------- */
  function enterApp() {
    $("loginView").classList.add("hidden");
    $("noProfileView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    $("currentUserLabel").textContent = state.me.name + " — " + state.me.title;
    $("taskForm").classList.toggle("hidden", !canCreateTask());
    var canEdit = isDirector();
    $("intervalInput").disabled = !canEdit;
    $("intervalSave").disabled = !canEdit;
    startListeners();
    startCheckin();
  }

  function showLogin() {
    state.user = null;
    state.me = null;
    state.messages = []; state.tasks = []; state.employees = [];
    $("appView").classList.add("hidden");
    $("noProfileView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
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
        if (state.currentTab === "room") markRoomRead(); else refreshUnreadBadge();
      }, function (e) { console.warn("messages listener:", e); })
    );
    state.unsub.push(
      db.collection("tasks").orderBy("createdAt", "desc").onSnapshot(function (snap) {
        state.tasks = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderTasks();
      }, function (e) { console.warn("tasks listener:", e); })
    );
    state.unsub.push(
      db.collection("employees").onSnapshot(function (snap) {
        state.employees = snap.docs.map(function (d) {
          var o = d.data(); o.id = d.id; return o;
        });
        renderEmployees();
        renderAssigneeOptions();
      }, function (e) { console.warn("employees listener:", e); })
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
        if (changed && state.user) startCheckin();
      }, function (e) { console.warn("settings listener:", e); })
    );
  }

  function stopListeners() {
    state.unsub.forEach(function (u) { try { u(); } catch (e) {} });
    state.unsub = [];
  }

  /* ---------- Check-in tự động ---------- */
  function doCheckin() {
    if (!state.me || !state.me.realDoc || !db) return;
    db.collection("employees").doc(state.me.id).update({
      lastCheckAt: serverTimestamp(),
      status: "Đang hoạt động"
    }).catch(function (e) { console.warn("check-in:", e); });
  }
  function startCheckin() {
    stopCheckin();
    doCheckin();
    var ms = Math.max(1, state.checkIntervalMinutes || 10) * 60 * 1000;
    state.checkinTimer = setInterval(doCheckin, ms);
  }
  function stopCheckin() {
    if (state.checkinTimer) { clearInterval(state.checkinTimer); state.checkinTimer = null; }
  }

  /* ---------- Tabs ---------- */
  function switchTab(name) {
    state.currentTab = name;
    var tabs = document.querySelectorAll("#tabBar .tab");
    tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === name); });
    ["room", "tasks", "employees", "settings"].forEach(function (k) {
      $("tab-" + k).classList.toggle("hidden", k !== name);
    });
    if (name === "room") {
      markRoomRead();
      scrollMessagesBottom();
    }
  }

  /* ---------- Phòng họp ---------- */
  function kindClass(kind) {
    if (kind === "Giao việc") return "kind k-task";
    if (kind === "Cập nhật tiến độ") return "kind k-progress";
    if (kind === "Báo cáo kết quả") return "kind k-report";
    return "kind";
  }

  function renderMessages() {
    var box = $("messageList");
    if (!box) return;
    if (!state.messages.length) {
      box.innerHTML = '<p class="hint" style="text-align:center;color:var(--muted)">Chưa có tin nhắn nào. Hãy gửi tin đầu tiên.</p>';
      return;
    }
    box.innerHTML = state.messages.map(function (m) {
      var isTask = m.kind === "Giao việc";
      return '<div class="msg' + (isTask ? " is-task" : "") + '">' +
        '<div class="meta">' +
          '<span class="sender">' + esc(m.senderName || "") + '</span>' +
          (m.senderTitle ? '<span class="title">' + esc(m.senderTitle) + '</span>' : "") +
          '<span class="' + kindClass(m.kind) + '">' + esc(m.kind || "Trao đổi") + '</span>' +
          '<span class="time">' + esc(fmtTime(m.createdAt)) + '</span>' +
        '</div>' +
        '<div class="content">' + esc(m.content || "") + '</div>' +
      '</div>';
    }).join("");
    scrollMessagesBottom();
  }

  function scrollMessagesBottom() {
    if (state.currentTab !== "room") return;
    var box = $("messageList");
    if (box) {
      requestAnimationFrame(function () { window.scrollTo(0, document.body.scrollHeight); });
    }
  }

  function onSendMessage(ev) {
    ev.preventDefault();
    if (!state.me || !db) return;
    var input = $("messageInput");
    var content = input.value.trim();
    if (!content) return;
    var kind = $("messageKind").value;
    if (MSG_KINDS.indexOf(kind) < 0) kind = "Trao đổi";
    input.value = "";
    db.collection("messages").add({
      senderId: state.me.id,
      senderName: state.me.name,
      senderTitle: state.me.title,
      content: content,
      kind: kind,
      createdAt: serverTimestamp()
    }).catch(function (e) {
      console.warn("send message:", e);
      input.value = content;
    });
  }

  /* ---------- Công việc ---------- */
  function empName(id) {
    for (var i = 0; i < state.employees.length; i++) {
      if (state.employees[i].id === id) return state.employees[i].name;
    }
    if (state.me && state.me.id === id) return state.me.name;
    if (id === "director") return "Chung";
    return "(chưa rõ)";
  }

  function prioClass(p) {
    if (p === "Cao") return "prio p-Cao";
    if (p === "Thấp") return "prio p-Thap";
    return "prio p-TrungBinh";
  }

  function renderAssigneeOptions() {
    var sel = $("taskAssignee");
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = state.employees.map(function (e) {
      return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.title ? " — " + esc(e.title) : "") + '</option>';
    }).join("");
    if (current) sel.value = current;
  }

  function renderTasks() {
    var board = $("taskBoard");
    if (!board) return;
    var html = "";
    TASK_STATUSES.forEach(function (status) {
      var list = state.tasks.filter(function (t) { return t.status === status; });
      html += '<div class="task-group"><h3>' + esc(status) + ' <span class="count">(' + list.length + ')</span></h3>';
      if (!list.length) {
        html += '<p class="hint">Không có việc nào.</p>';
      }
      list.forEach(function (t) {
        var opts = TASK_STATUSES.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === t.status ? " selected" : "") + '>' + esc(s) + '</option>';
        }).join("");
        html += '<div class="task-card" data-task-id="' + esc(t.id) + '">' +
          '<div class="t-head"><span class="t-title">' + esc(t.title || "") + '</span>' +
          '<span class="' + prioClass(t.priority) + '">' + esc(t.priority || "Trung bình") + '</span></div>' +
          (t.description ? '<div class="t-desc">' + esc(t.description) + '</div>' : "") +
          '<div class="t-meta">Phụ trách: <b>' + esc(empName(t.assigneeId)) + '</b> · Giao bởi: ' + esc(empName(t.assignerId)) +
          (t.updatedAt ? ' · Cập nhật: ' + esc(fmtTime(t.updatedAt)) : "") + '</div>' +
          '<div class="row"><span>Trạng thái:</span>' +
          '<select class="task-status">' + opts + '</select></div>' +
          '<textarea class="task-note" rows="2" placeholder="Ghi chú kết quả...">' + esc(t.resultNote || "") + '</textarea>' +
          '<div class="row"><button class="btn ghost small task-note-save" type="button">Lưu ghi chú kết quả</button></div>' +
        '</div>';
      });
      html += '</div>';
    });
    board.innerHTML = html;

    // Gắn sự kiện cho từng thẻ việc
    board.querySelectorAll(".task-card").forEach(function (card) {
      var id = card.getAttribute("data-task-id");
      var sel = card.querySelector(".task-status");
      sel.addEventListener("change", function () {
        db.collection("tasks").doc(id).update({
          status: sel.value, updatedAt: serverTimestamp()
        }).catch(function (e) { console.warn("update task status:", e); });
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
  }

  function onCreateTask(ev) {
    ev.preventDefault();
    if (!canCreateTask() || !db) return;
    var errBox = $("taskError");
    errBox.classList.add("hidden");
    var title = $("taskTitle").value.trim();
    var assignee = $("taskAssignee").value;
    if (!title) return;
    if (!assignee) {
      errBox.textContent = "Chưa có nhân viên nào để giao việc. Hãy thêm hồ sơ nhân viên trước.";
      errBox.classList.remove("hidden");
      return;
    }
    var now = serverTimestamp();
    db.collection("tasks").add({
      title: title,
      description: $("taskDesc").value.trim(),
      assigneeId: assignee,
      assignerId: state.me.id,
      status: "Chờ nhận",
      priority: $("taskPriority").value,
      resultNote: "",
      createdAt: now,
      updatedAt: now
    }).then(function () {
      $("taskTitle").value = "";
      $("taskDesc").value = "";
    }).catch(function (e) {
      errBox.textContent = "Tạo công việc thất bại. Vui lòng thử lại.";
      errBox.classList.remove("hidden");
      console.warn("create task:", e);
    });
  }

  /* ---------- Nhân viên ---------- */
  function initial(name) {
    var s = String(name || "?").trim();
    return s ? s.charAt(0).toUpperCase() : "?";
  }

  function renderEmployees() {
    renderOrgTree();
    var box = $("employeeList");
    if (!box) return;
    if (!state.employees.length) {
      box.innerHTML = '<p class="hint">Chưa có hồ sơ nhân viên nào.</p>';
      return;
    }
    box.innerHTML = state.employees.map(function (e) {
      var color = e.color || "#4f46e5";
      var online = e.status === "Đang hoạt động";
      return '<div class="emp-card">' +
        '<div class="e-head">' +
          '<span class="avatar" style="background:' + esc(color) + '">' + esc(initial(e.name)) + '</span>' +
          '<div><div class="e-name">' + esc(e.name || "") + '</div>' +
          '<div class="e-title">' + esc(e.title || "") + '</div></div>' +
          '<span class="dot' + (online ? " on" : "") + '" style="margin-left:auto"></span>' +
        '</div>' +
        '<dl>' +
          '<dt>Cấp bậc</dt><dd>' + esc(e.level || "") + '</dd>' +
          '<dt>Vai trò</dt><dd>' + esc(e.role || "") + '</dd>' +
          '<dt>Trạng thái</dt><dd>' + esc(e.status || "") + '</dd>' +
          '<dt>Đang làm</dt><dd>' + esc(e.currentWork || "—") + '</dd>' +
          (e.lastCheckAt ? '<dt>Kiểm tra phòng gần nhất</dt><dd>' + esc(fmtTime(e.lastCheckAt)) + '</dd>' : "") +
        '</dl>' +
      '</div>';
    }).join("");
  }

  function renderOrgTree() {
    var box = $("orgTree");
    if (!box) return;
    if (!state.employees.length) {
      box.innerHTML = '<p class="hint">Chưa có dữ liệu tổ chức.</p>';
      return;
    }
    var byId = {};
    state.employees.forEach(function (e) { byId[e.id] = e; });
    var children = {};
    var roots = [];
    state.employees.forEach(function (e) {
      var m = e.managerId;
      if (m && byId[m]) {
        if (!children[m]) children[m] = [];
        children[m].push(e);
      } else {
        roots.push(e);
      }
    });
    function nodeHtml(e) {
      var html = '<li><span class="tree-node">' +
        '<span class="dot' + (e.status === "Đang hoạt động" ? " on" : "") + '"></span>' +
        '<span class="n-name">' + esc(e.name || "") + '</span>' +
        (e.title ? '<span class="n-title">' + esc(e.title) + '</span>' : "") +
        (e.level ? '<span class="lvl">' + esc(e.level) + '</span>' : "") +
        '</span>';
      var kids = children[e.id] || [];
      if (kids.length) {
        html += '<ul class="tree">' + kids.map(nodeHtml).join("") + '</ul>';
      }
      return html + '</li>';
    }
    box.innerHTML = '<ul class="tree root">' + roots.map(nodeHtml).join("") + '</ul>';
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
        msg.textContent = "Đã lưu: nhân viên kiểm tra phòng họp mỗi " + n + " phút.";
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

  /* ---------- Khởi động ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    $("loginForm").addEventListener("submit", onLoginSubmit);
    $("logoutBtn").addEventListener("click", doLogout);
    $("noProfileLogout").addEventListener("click", doLogout);
    $("messageForm").addEventListener("submit", onSendMessage);
    $("taskForm").addEventListener("submit", onCreateTask);
    $("intervalSave").addEventListener("click", onSaveInterval);
    $("passwordSave").addEventListener("click", onChangePassword);
    var tabs = document.querySelectorAll("#tabBar .tab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); });
    });

    if (!initFirebase()) {
      $("loginBtn").disabled = true;
      return;
    }

    auth.onAuthStateChanged(function (user) {
      if (!user) {
        stopListeners();
        stopCheckin();
        showLogin();
        return;
      }
      state.user = user;
      loadMyProfile(user).then(function (ok) {
        if (ok) enterApp();
        else showNoProfile(user.email);
      }).catch(function (e) {
        console.warn("load profile:", e);
        showNoProfile(user.email);
      });
    });
  });
})();
