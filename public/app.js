/* Pivot Medical Centre: browser app. All data and every permission check live on the server. */
(function () {
  "use strict";
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var ymd = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var kes = function (n) { return "KES " + Number(n).toLocaleString("en-KE"); };
  var WARDS = { General: 12, Maternity: 6, ICU: 4, Pediatrics: 8 };
  var LABELS = { dashboard: "Dashboard", patients: "Patients", appointments: "Appointments", doctors: "Doctors", billing: "Billing", staff: "Staff", account: "Account" };
  var A_STAFF = ["admin", "doctor", "receptionist"];
  var ROLES = {
    admin: { label: "Administrator", views: ["dashboard", "patients", "appointments", "doctors", "billing", "staff"] },
    doctor: { label: "Doctor", views: ["dashboard", "patients", "appointments", "doctors"] },
    receptionist: { label: "Receptionist", views: ["dashboard", "patients", "appointments", "doctors"] },
    accounts: { label: "Accounts", views: ["billing"] }
  };
  /* These only decide which buttons are shown. The server enforces the same rules on every request. */
  var PERM = {
    checkin: A_STAFF, cancel: A_STAFF, complete: ["admin", "doctor"], admit: A_STAFF, discharge: ["admin", "doctor"],
    duty: ["admin"], pay: ["admin", "accounts"],
    resetpw: ["admin"], cancelreset: ["admin"], removeuser: ["admin"], keepuser: ["admin"], confirmremove: ["admin"]
  };
  var FORM_PERM = { patients: ["admin", "receptionist"], appointments: A_STAFF, billing: ["admin", "accounts"], staff: ["admin"] };
  var emptyData = function () { return { wards: WARDS, doctors: [], patients: [], appts: [], invoices: [], users: [], log: [] }; };
  var S = emptyData();
  var me = null, idleT;

  var ui = { view: "dashboard", form: false, q: "", pf: "All", ad: ymd(new Date()), af: "All", bf: "All" };
  var $ = function (sel) { return document.querySelector(sel); };
  var doc = function (id) { return S.doctors.filter(function (d) { return d.id === id; })[0]; };
  var pat = function (id) { return S.patients.filter(function (p) { return p.id === id; })[0]; };
  var occ = function (w) { return S.patients.filter(function (p) { return p.status === "Admitted" && p.ward === w; }).length; };
  function nextBed(w) {
    var used = S.patients.filter(function (p) { return p.status === "Admitted" && p.ward === w; }).map(function (p) { return p.bed; });
    for (var i = 1; i <= WARDS[w]; i++) if (used.indexOf(i) < 0) return i;
    return 0;
  }
  var today = function () { return ymd(new Date()); };
  var isOverdue = function (inv) { return !inv.paid && inv.due < today(); };
  var daysSince = function (s) { return Math.max(0, Math.round((new Date(today()) - new Date(s)) / 864e5)); };
  var fmtDay = function (s) { return new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };

  var toastTimer;
  function toast(msg, bad) {
    var el = $("#toastmsg");
    el.textContent = msg; el.className = "show" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ""; }, 2600);
  }
  function pill(text, kind) { return '<span class="pill ' + (kind || "") + '">' + esc(text) + "</span>"; }
  var patKind = { Admitted: "accent", Outpatient: "", Discharged: "" };
  var apptKind = { Scheduled: "", "Checked in": "accent", Completed: "ok", Cancelled: "crit" };

  function patientOptions(sel) {
    return S.patients.map(function (p) { return '<option value="' + p.id + '"' + (p.id === sel ? " selected" : "") + ">" + esc(p.name) + " (" + p.id + ")</option>"; }).join("");
  }
  function doctorOptions(sel) {
    return S.doctors.map(function (d) { return '<option value="' + d.id + '"' + (d.id === sel ? " selected" : "") + ">" + esc(d.name) + " · " + esc(d.dept) + "</option>"; }).join("");
  }
  function wardOptions() {
    return Object.keys(WARDS).map(function (w) { var free = WARDS[w] - occ(w); return '<option value="' + w + '"' + (free ? "" : " disabled") + ">" + w + " (" + free + " free)</option>"; }).join("");
  }

  /* ---------- Rows ---------- */
  function apptActions(a) {
    if (a.status === "Scheduled") return '<button class="btn sm" data-act="checkin" data-id="' + a.id + '" type="button">Check in</button><button class="btn sm danger" data-act="cancel" data-id="' + a.id + '" type="button">Cancel</button>';
    if (a.status === "Checked in") return '<button class="btn sm primary" data-act="complete" data-id="' + a.id + '" type="button">Complete</button>';
    return "";
  }
  function patientRows() {
    var q = ui.q.toLowerCase();
    var list = S.patients.filter(function (p) {
      return (ui.pf === "All" || p.status === ui.pf) && (!q || (p.name + " " + p.id + " " + p.dx + " " + p.phone).toLowerCase().indexOf(q) >= 0);
    });
    $("#count") && ($("#count").textContent = list.length + " of " + S.patients.length + " patients");
    if (!list.length) return '<tr><td colspan="7" class="empty">No patients match. Clear the search or add a new patient.</td></tr>';
    return list.map(function (p) {
      var d = doc(p.doc);
      var acts = p.status === "Admitted"
        ? '<button class="btn sm" data-act="discharge" data-id="' + p.id + '" type="button">Discharge</button>'
        : '<select class="sm" aria-label="Ward for ' + esc(p.name) + '">' + wardOptions() + '</select><button class="btn sm primary" data-act="admit" data-id="' + p.id + '" type="button">Admit</button>';
      return '<tr><td class="id">' + p.id + '</td><td><b>' + esc(p.name) + '</b><span class="sub">' + p.age + " yrs · " + p.sex + " · " + esc(p.phone) + "</span></td><td>" + pill(p.status, patKind[p.status]) + "</td><td>" + (p.ward ? esc(p.ward) + ' <span class="sub">Bed ' + p.bed + "</span>" : '<span class="sub">None</span>') + "</td><td>" + esc(d ? d.name : "") + "</td><td>" + esc(p.dx) + '</td><td><div class="acts">' + acts + "</div></td></tr>";
    }).join("");
  }
  function apptRows() {
    var list = S.appts.filter(function (a) { return (!ui.ad || a.date === ui.ad) && (ui.af === "All" || a.status === ui.af); })
      .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    $("#count") && ($("#count").textContent = list.length + (list.length === 1 ? " appointment" : " appointments"));
    if (!list.length) return '<tr><td colspan="6" class="empty">No appointments for this filter. Pick another date or book one.</td></tr>';
    return list.map(function (a) {
      var p = pat(a.pid), d = doc(a.did);
      return '<tr><td class="id">' + fmtDay(a.date) + '<span class="sub">' + a.time + "</span></td><td><b>" + esc(p ? p.name : "") + '</b><span class="sub">' + a.id + "</span></td><td>" + esc(d ? d.name : "") + '<span class="sub">' + esc(d ? d.dept : "") + "</span></td><td>" + esc(a.reason) + "</td><td>" + pill(a.status, apptKind[a.status]) + '</td><td><div class="acts">' + apptActions(a) + "</div></td></tr>";
    }).join("");
  }
  function invStatus(inv) { return inv.paid ? ["Paid", "ok"] : isOverdue(inv) ? ["Overdue", "crit"] : ["Unpaid", "warn"]; }
  function billRows() {
    var list = S.invoices.filter(function (i) { return ui.bf === "All" || invStatus(i)[0] === ui.bf; }).sort(function (a, b) { return b.id.localeCompare(a.id); });
    $("#count") && ($("#count").textContent = list.length + (list.length === 1 ? " invoice" : " invoices"));
    if (!list.length) return '<tr><td colspan="6" class="empty">No invoices with this status.</td></tr>';
    return list.map(function (i) {
      var p = pat(i.pid), st = invStatus(i);
      return '<tr><td class="id">' + i.id + "</td><td><b>" + esc(p ? p.name : "") + '</b><span class="sub">' + esc(i.desc) + '</span></td><td class="id">' + fmtDay(i.due) + '</td><td class="num">' + kes(i.amount) + "</td><td>" + pill(st[0], st[1]) + "</td><td>" + (i.paid ? "" : '<button class="btn sm primary" data-act="pay" data-id="' + i.id + '" type="button">Mark paid</button>') + "</td></tr>";
    }).join("");
  }

  /* ---------- Views ---------- */
  function head(title, sub, actionHtml) {
    return '<div class="head"><div><div class="eyebrow">' + new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + "</div><h1>" + title + "</h1>" + (sub ? "<p>" + sub + "</p>" : "") + "</div>" + (actionHtml || "") + "</div>";
  }
  function dashboard() {
    var admitted = S.patients.filter(function (p) { return p.status === "Admitted"; });
    var totalBeds = 0, usedBeds = 0;
    Object.keys(WARDS).forEach(function (w) { totalBeds += WARDS[w]; usedBeds += occ(w); });
    var todays = S.appts.filter(function (a) { return a.date === today() && a.status !== "Cancelled"; }).sort(function (a, b) { return a.time.localeCompare(b.time); });
    var waiting = todays.filter(function (a) { return a.status === "Scheduled" || a.status === "Checked in"; }).length;
    var due = S.invoices.filter(function (i) { return !i.paid; });
    var dueSum = due.reduce(function (s, i) { return s + i.amount; }, 0);
    var over = due.filter(isOverdue).length;
    var h = hour();
    var wardsHtml = Object.keys(WARDS).map(function (w) {
      var n = occ(w), pct = Math.round(n / WARDS[w] * 100);
      return '<div class="ward"><span>' + w + '</span><div class="bar" role="img" aria-label="' + w + " " + pct + ' percent full"><i class="' + (pct >= 100 ? "full" : pct >= 80 ? "hi" : "") + '" style="width:' + pct + '%"></i></div><span class="cnt">' + n + "/" + WARDS[w] + "</span></div>";
    }).join("");
    var queue = todays.length ? '<ul class="queue">' + todays.map(function (a) {
      var p = pat(a.pid), d = doc(a.did);
      return '<li><span class="t">' + a.time + '</span><div class="who"><b>' + esc(p ? p.name : "") + "</b><span>" + esc(d ? d.name : "") + " · " + esc(a.reason) + '</span></div><div class="act">' + pill(a.status, apptKind[a.status]) + apptActions(a) + "</div></li>";
    }).join("") + "</ul>" : '<p class="empty">No appointments today.</p>';
    var adm = admitted.sort(function (a, b) { return a.since.localeCompare(b.since); }).map(function (p) {
      var d = doc(p.doc);
      return "<tr><td><b>" + esc(p.name) + '</b><span class="sub">' + esc(p.dx) + "</span></td><td>" + esc(p.ward) + ' <span class="sub">Bed ' + p.bed + "</span></td><td>" + esc(d ? d.name : "") + '</td><td class="num">' + daysSince(p.since) + " d</td></tr>";
    }).join("");
    return head(h + ", " + esc(me.name), "Census and today's schedule for Pivot Medical Centre.") +
      '<div class="stats">' +
      '<div class="stat"><div class="eyebrow">Admitted now</div><div class="v">' + admitted.length + '</div><div class="s">across ' + Object.keys(WARDS).length + " wards</div></div>" +
      '<div class="stat"><div class="eyebrow">Appointments today</div><div class="v">' + todays.length + '</div><div class="s">' + waiting + " still to be seen</div></div>" +
      '<div class="stat"><div class="eyebrow">Bed occupancy</div><div class="v">' + Math.round(usedBeds / totalBeds * 100) + '%</div><div class="s">' + usedBeds + " of " + totalBeds + " beds in use</div></div>" +
      (canView("billing") ? '<div class="stat' + (over ? " alert" : "") + '"><div class="eyebrow">Outstanding bills</div><div class="v">' + kes(dueSum) + '</div><div class="s">' + due.length + " unpaid, " + over + " overdue</div></div>" : "") + "</div>" +
      '<div class="grid2"><div class="card"><h2>Ward occupancy</h2>' + wardsHtml + '</div><div class="card"><h2>Today\'s queue <small>' + fmtDay(today()) + "</small></h2>" + queue + "</div></div>" +
      '<div class="card" style="margin-top:16px"><h2>Admitted patients <small>longest stay first</small></h2><div class="tablewrap" style="border:0"><table style="min-width:560px"><thead><tr><th>Patient</th><th>Ward</th><th>Doctor</th><th class="num">Stay</th></tr></thead><tbody>' + (adm || '<tr><td colspan="4" class="empty">Nobody is admitted.</td></tr>') + "</tbody></table></div></div>";
  }
  function hour() { var h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }

  function patients() {
    var form = ui.form ? '<form class="panel" data-form="patient" novalidate><h2>Register patient</h2><div class="form">' +
      '<label>Full name<input class="field" id="f-name" required autocomplete="off"></label>' +
      '<label>Age<input class="field" id="f-age" type="number" min="0" max="120" required></label>' +
      '<label>Sex<select class="field" id="f-sex"><option value="F">Female</option><option value="M">Male</option></select></label>' +
      '<label>Phone<input class="field" id="f-phone" inputmode="tel" autocomplete="off"></label>' +
      '<label>Status<select class="field" id="f-status"><option>Outpatient</option><option>Admitted</option></select></label>' +
      '<label>Ward<select class="field" id="f-ward" disabled>' + wardOptions() + "</select></label>" +
      '<label>Attending doctor<select class="field" id="f-doc">' + doctorOptions() + "</select></label>" +
      '<label>Diagnosis or reason<input class="field" id="f-dx" autocomplete="off"></label>' +
      '<div class="full row"><button class="btn primary" type="submit">Save patient</button><button class="btn" data-act="toggleform" type="button">Cancel</button></div><div class="full err" id="err"></div></div></form>' : "";
    return head("Patients", '<span id="count"></span>', '<button class="btn primary" data-act="toggleform" type="button">' + (ui.form ? "Close form" : "Add patient") + "</button>") + form +
      '<div class="toolbar"><input class="field grow" id="q" type="search" placeholder="Search by name, ID, phone or diagnosis" value="' + esc(ui.q) + '" aria-label="Search patients">' +
      '<select class="field" id="pf" style="width:auto" aria-label="Filter by status">' + ["All", "Admitted", "Outpatient", "Discharged"].map(function (s) { return "<option" + (s === ui.pf ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div>" +
      '<div class="tablewrap"><table><thead><tr><th>ID</th><th>Patient</th><th>Status</th><th>Ward</th><th>Doctor</th><th>Diagnosis</th><th>Actions</th></tr></thead><tbody id="rows">' + patientRows() + "</tbody></table></div>";
  }
  function appointments() {
    var form = ui.form ? '<form class="panel" data-form="appt" novalidate><h2>Book appointment</h2><div class="form">' +
      '<label>Patient<select class="field" id="f-pid">' + patientOptions() + "</select></label>" +
      '<label>Doctor<select class="field" id="f-did">' + doctorOptions() + "</select></label>" +
      '<label>Date<input class="field" id="f-date" type="date" min="' + today() + '" value="' + today() + '" required></label>' +
      '<label>Time<input class="field" id="f-time" type="time" value="09:00" step="900" required></label>' +
      '<label class="full">Reason<input class="field" id="f-reason" autocomplete="off" required></label>' +
      '<div class="full row"><button class="btn primary" type="submit">Book appointment</button><button class="btn" data-act="toggleform" type="button">Cancel</button></div><div class="full err" id="err"></div></div></form>' : "";
    return head("Appointments", '<span id="count"></span>', '<button class="btn primary" data-act="toggleform" type="button">' + (ui.form ? "Close form" : "Book appointment") + "</button>") + form +
      '<div class="toolbar"><label class="eyebrow" for="ad">Date</label><input class="field" id="ad" type="date" value="' + esc(ui.ad) + '" style="width:auto">' +
      '<button class="btn" data-act="alldates" type="button">All dates</button>' +
      '<select class="field" id="af" style="width:auto" aria-label="Filter by status">' + ["All", "Scheduled", "Checked in", "Completed", "Cancelled"].map(function (s) { return "<option" + (s === ui.af ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div>" +
      '<div class="tablewrap"><table><thead><tr><th>When</th><th>Patient</th><th>Doctor</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead><tbody id="rows">' + apptRows() + "</tbody></table></div>";
  }
  function doctors() {
    var cards = S.doctors.map(function (d) {
      var todayN = S.appts.filter(function (a) { return a.did === d.id && a.date === today() && a.status !== "Cancelled"; }).length;
      var inward = S.patients.filter(function (p) { return p.doc === d.id && p.status === "Admitted"; }).length;
      return '<article class="doc"><div><h3>' + esc(d.name) + '</h3><div class="dept">' + esc(d.dept) + "</div></div><dl>" +
        "<dt>Location</dt><dd>" + esc(d.room) + "</dd><dt>Consultation fee</dt><dd>" + kes(d.fee) + "</dd><dt>Appointments today</dt><dd>" + todayN + "</dd><dt>Patients in ward</dt><dd>" + inward + "</dd></dl>" +
        '<div class="foot">' + pill(d.duty ? "On duty" : "Off duty", d.duty ? "ok" : "") + '<button class="btn sm" data-act="duty" data-id="' + d.id + '" type="button">' + (d.duty ? "Mark off duty" : "Mark on duty") + "</button></div></article>";
    }).join("");
    var on = S.doctors.filter(function (d) { return d.duty; }).length;
    return head("Doctors", on + " of " + S.doctors.length + " on duty today.") + '<div class="docs">' + cards + "</div>";
  }
  function billing() {
    var billed = S.invoices.reduce(function (s, i) { return s + i.amount; }, 0);
    var paid = S.invoices.filter(function (i) { return i.paid; }).reduce(function (s, i) { return s + i.amount; }, 0);
    var form = ui.form ? '<form class="panel" data-form="invoice" novalidate><h2>New invoice</h2><div class="form">' +
      '<label>Patient<select class="field" id="f-pid">' + patientOptions() + "</select></label>" +
      '<label>Description<input class="field" id="f-desc" autocomplete="off" required></label>' +
      '<label>Amount (KES)<input class="field" id="f-amt" type="number" min="1" step="50" required></label>' +
      '<label>Due date<input class="field" id="f-due" type="date" value="' + addDays(14) + '" required></label>' +
      '<div class="full row"><button class="btn primary" type="submit">Create invoice</button><button class="btn" data-act="toggleform" type="button">Cancel</button></div><div class="full err" id="err"></div></div></form>' : "";
    return head("Billing", '<span id="count"></span>', '<button class="btn primary" data-act="toggleform" type="button">' + (ui.form ? "Close form" : "New invoice") + "</button>") + form +
      '<div class="stats"><div class="stat"><div class="eyebrow">Billed</div><div class="v">' + kes(billed) + '</div></div><div class="stat"><div class="eyebrow">Collected</div><div class="v">' + kes(paid) + '</div></div><div class="stat' + (billed - paid ? " alert" : "") + '"><div class="eyebrow">Outstanding</div><div class="v">' + kes(billed - paid) + "</div></div></div>" +
      '<div class="toolbar"><select class="field" id="bf" style="width:auto" aria-label="Filter by status">' + ["All", "Unpaid", "Overdue", "Paid"].map(function (s) { return "<option" + (s === ui.bf ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div>" +
      '<div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Patient</th><th>Due</th><th class="num">Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody id="rows">' + billRows() + "</tbody></table></div>";
  }
  /* ---------- Talking to the server ---------- */
  function api(method, url, body, background) {
    var opt = { method: method, credentials: "same-origin", headers: { "X-Requested-With": "pivot" } };
    if (background) opt.headers["X-Background"] = "1";
    if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(url, opt).catch(function () { throw new Error("Cannot reach the server. Check your connection."); }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok) return d;
        var e = new Error(d.error || "Something went wrong. Try again.");
        e.status = r.status; e.code = d.code;
        throw e;
      });
    });
  }
  function endSession(msg) {
    me = null; clearTimeout(idleT);
    S = emptyData(); ui.form = false; ui.reset = ""; ui.rm = "";
    $("#view").innerHTML = "";
    showLogin(msg);
  }
  function handleErr(e) {
    if (e.status === 401) { if (me) endSession("Your session has ended. Sign in again."); return; }
    if (e.code === "temp" && me) { me.temp = true; route(); return; }
    toast(e.message, true);
  }
  function refresh(background) {
    return api("GET", "/api/data", undefined, background).then(function (d) {
      S = d;
      if (d.wards) WARDS = d.wards;
      route();
    });
  }
  function run(promise, msg) {
    promise.then(function (d) {
      return refresh().then(function () { toast((d && d.message) || msg); });
    }).catch(handleErr);
  }

  /* ---------- Sign-in and permissions ---------- */
  function allowedViews() { return ROLES[me.role].views.concat(["account"]); }
  function canView(v) { return ROLES[me.role].views.indexOf(v) >= 0; }
  function can(act) { return !PERM[act] || PERM[act].indexOf(me.role) >= 0; }
  function applyPerms() {
    document.querySelectorAll("#view [data-act]").forEach(function (b) {
      var act = b.getAttribute("data-act");
      var ok = act === "toggleform" ? (FORM_PERM[ui.view] || []).indexOf(me.role) >= 0 : can(act);
      if (!ok) {
        if (act === "admit") { var s = b.parentNode.querySelector("select"); if (s) s.remove(); }
        b.remove();
      }
    });
  }
  function renderSideFoot() {
    $("#sidefoot").innerHTML = "<div><b>" + esc(me.name) + "</b><br>" + ROLES[me.role].label + '</div><a href="#account">Change password</a>' +
      '<button class="btn sm" data-act="logout" type="button">Sign out</button>';
  }
  function showLogin(msg) {
    $("#app").hidden = true; $("#login").hidden = false;
    $("#loginmsg").textContent = msg || ""; $("#loginerr").textContent = "";
    $("#l-pass").value = "";
    try { $("#l-user").focus(); } catch (e) {}
  }
  function doLogin() {
    var out = $("#loginerr"), name = $("#l-user").value.trim(), pw = $("#l-pass").value;
    $("#loginmsg").textContent = "";
    if (!name || !pw) { out.textContent = "Enter your username and password."; return; }
    $("#l-btn").disabled = true;
    api("POST", "/api/login", { username: name, password: pw }).then(function (d) {
      $("#l-btn").disabled = false;
      me = d.user; out.textContent = ""; $("#l-pass").value = "";
      startApp();
    }).catch(function (e) { $("#l-btn").disabled = false; out.textContent = e.message; });
  }
  function startApp() {
    $("#login").hidden = true; $("#app").hidden = false;
    armIdle();
    (me.temp ? Promise.resolve(route()) : refresh()).catch(handleErr);
    window.scrollTo(0, 0);
  }
  function logout(msg) {
    api("POST", "/api/logout").catch(function () {});
    endSession(msg);
  }
  function armIdle() {
    clearTimeout(idleT);
    if (me) idleT = setTimeout(function () { logout("You were signed out after 10 minutes of inactivity."); }, 600000);
  }
  ["click", "keydown", "touchstart"].forEach(function (ev) { document.addEventListener(ev, function () { if (me) armIdle(); }, true); });
  /* Pick up changes made by other staff, but never while someone is typing. */
  setInterval(function () {
    if (!me || me.temp || document.hidden || ui.form || ui.reset) return;
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    refresh(true).catch(handleErr);
  }, 30000);
  function boot() {
    api("GET", "/api/me").then(function (d) { me = d.user; startApp(); }).catch(function () { showLogin(""); });
  }

  function staff() {
    var roleOpts = Object.keys(ROLES).map(function (r) { return '<option value="' + r + '">' + ROLES[r].label + "</option>"; }).join("");
    var form = ui.form ? '<form class="panel" data-form="user" novalidate><h2>Add staff account</h2><div class="form">' +
      '<label>Full name<input class="field" id="f-uname" autocomplete="off"></label>' +
      '<label>Username<input class="field" id="f-user" autocomplete="off" autocapitalize="none"></label>' +
      '<label>Role<select class="field" id="f-role">' + roleOpts + "</select></label>" +
      '<label>Temporary password<input class="field" id="f-pass" type="password" autocomplete="new-password"></label>' +
      '<div class="full row"><button class="btn primary" type="submit">Create account</button><button class="btn" data-act="toggleform" type="button">Cancel</button></div><div class="full err" id="err"></div></div></form>' : "";
    var rp = ui.reset ? '<form class="panel" data-form="resetpw" novalidate><h2>Reset password for ' + esc(ui.reset) + '</h2><div class="form">' +
      '<label>New temporary password<input class="field" id="f-pass" type="password" autocomplete="new-password"></label>' +
      '<div class="row"><button class="btn primary" type="submit">Save password</button><button class="btn" data-act="cancelreset" type="button">Cancel</button></div><div class="full err" id="err"></div></div></form>' : "";
    var rows = S.users.map(function (u) {
      var self = u.username === me.username, uid = esc(u.username);
      var acts = '<button class="btn sm" data-act="resetpw" data-id="' + uid + '" type="button">Reset password</button>';
      if (!self) acts += ui.rm === u.username
        ? '<button class="btn sm danger" data-act="confirmremove" data-id="' + uid + '" type="button">Confirm remove</button><button class="btn sm" data-act="keepuser" type="button">Keep</button>'
        : '<button class="btn sm danger" data-act="removeuser" data-id="' + uid + '" type="button">Remove</button>';
      return "<tr><td><b>" + esc(u.name) + '</b><span class="sub">' + uid + (self ? " (you)" : "") + "</span></td><td>" + pill(ROLES[u.role].label, u.role === "admin" ? "accent" : "") + "</td><td>" +
        (u.temp ? pill("Temporary password", "warn") : pill("Active", "ok")) + '</td><td class="id">' + (u.last ? new Date(u.last).toLocaleString("en-GB") : "Never") + '</td><td><div class="acts">' + acts + "</div></td></tr>";
    }).join("");
    var logRows = (S.log || []).slice(0, 40).map(function (l) {
      return '<tr><td class="id">' + new Date(l.t).toLocaleString("en-GB") + '</td><td class="id">' + esc(l.u) + "</td><td>" + esc(l.m) + "</td></tr>";
    }).join("") || '<tr><td colspan="3" class="empty">No activity yet.</td></tr>';
    return head("Staff accounts", S.users.length + " accounts", '<button class="btn primary" data-act="toggleform" type="button">' + (ui.form ? "Close form" : "Add staff") + "</button>") + form + rp +
      '<div class="tablewrap"><table><thead><tr><th>Staff member</th><th>Role</th><th>Password</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<div class="card" style="margin-top:16px"><h2>Activity log <small>latest 40 events</small></h2><div class="tablewrap" style="border:0"><table style="min-width:520px"><thead><tr><th>Time</th><th>User</th><th>Event</th></tr></thead><tbody>' + logRows + "</tbody></table></div></div>";
  }
  function account() {
    return head("Account", esc(me.name) + " · " + ROLES[me.role].label) +
      (me.temp ? '<p class="err" style="font-size:14px">You are using a temporary password. Set a new one to continue.</p>' : "") +
      '<form class="panel" data-form="account" novalidate style="max-width:460px"><h2>Change password</h2><div class="form" style="grid-template-columns:1fr">' +
      '<label>Current password<input class="field" id="a-cur" type="password" autocomplete="current-password"></label>' +
      '<label>New password<input class="field" id="a-new" type="password" autocomplete="new-password"></label>' +
      '<label>Confirm new password<input class="field" id="a-new2" type="password" autocomplete="new-password"></label>' +
      '<p class="note">At least 10 characters, with a letter and a number.</p>' +
      '<div class="row"><button class="btn primary" type="submit">Save password</button></div><div class="err" id="err"></div></div></form>';
  }

  var RENDER = { dashboard: dashboard, patients: patients, appointments: appointments, doctors: doctors, billing: billing, staff: staff, account: account };

  function render() {
    $("#nav").innerHTML = ROLES[me.role].views.map(function (v) {
      var n = v === "patients" ? S.patients.length : v === "appointments" ? S.appts.filter(function (a) { return a.date === today() && a.status !== "Cancelled"; }).length : v === "billing" ? S.invoices.filter(function (i) { return !i.paid; }).length : "";
      return '<a href="#' + v + '"' + (v === ui.view ? ' aria-current="page"' : "") + ">" + LABELS[v] + '<span class="n">' + n + "</span></a>";
    }).join("");
    $("#view").innerHTML = RENDER[ui.view]();
    if ($("#rows")) refreshRows(); /* fills the "12 patients" style count under the heading */
    applyPerms(); renderSideFoot();
    document.title = "Pivot Medical Centre";
  }
  function refreshRows() {
    var f = ui.view === "patients" ? patientRows : ui.view === "appointments" ? apptRows : billRows;
    $("#rows").innerHTML = f(); applyPerms();
  }
  function route() {
    var v = location.hash.slice(1);
    if (allowedViews().indexOf(v) < 0) v = ROLES[me.role].views[0];
    if (me.temp) v = "account";
    if (v !== ui.view) { ui.form = false; ui.reset = ""; ui.rm = ""; }
    ui.view = v;
    render();
  }

  /* ---------- Clicks and forms ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b || !me) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    var enc = encodeURIComponent(id || "");
    if (PERM[act] && PERM[act].indexOf(me.role) < 0) return;
    if (act === "toggleform" && (FORM_PERM[ui.view] || []).indexOf(me.role) < 0) return;
    if (act === "toggleform") { ui.form = !ui.form; ui.reset = ""; render(); }
    else if (act === "logout") { logout("You have signed out."); }
    else if (act === "alldates") { ui.ad = ""; render(); }
    else if (act === "resetpw") { ui.reset = id; ui.rm = ""; ui.form = false; render(); }
    else if (act === "cancelreset") { ui.reset = ""; render(); }
    else if (act === "removeuser") { ui.rm = id; render(); }
    else if (act === "keepuser") { ui.rm = ""; render(); }
    else if (act === "confirmremove") { ui.rm = ""; run(api("DELETE", "/api/users/" + enc), "Removed account"); }
    else if (act === "checkin" || act === "complete" || act === "cancel") { run(api("POST", "/api/appointments/" + enc + "/" + act), "Done"); }
    else if (act === "duty") { var d = doc(id); run(api("POST", "/api/doctors/" + enc + "/duty", { duty: !d.duty }), "Updated"); }
    else if (act === "pay") { run(api("POST", "/api/invoices/" + enc + "/pay"), "Invoice marked paid"); }
    else if (act === "discharge") { run(api("POST", "/api/patients/" + enc + "/discharge"), "Patient discharged"); }
    else if (act === "admit") {
      var sel = b.parentNode.querySelector("select");
      run(api("POST", "/api/patients/" + enc + "/admit", { ward: sel ? sel.value : "" }), "Patient admitted");
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target.id === "q") { ui.q = e.target.value; refreshRows(); }
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "pf") { ui.pf = t.value; refreshRows(); }
    else if (t.id === "af") { ui.af = t.value; refreshRows(); }
    else if (t.id === "ad") { ui.ad = t.value; refreshRows(); }
    else if (t.id === "bf") { ui.bf = t.value; refreshRows(); }
    else if (t.id === "f-status") { $("#f-ward").disabled = t.value !== "Admitted"; }
  });
  document.addEventListener("submit", function (e) {
    var f = e.target.getAttribute("data-form");
    if (!f) return;
    e.preventDefault();
    if (f === "login") { doLogin(); return; }
    if (!me) return;
    var err = function (m) { var el = $("#err"); if (el) el.textContent = m; };
    var val = function (id) { return $("#" + id).value.trim(); };
    var raw = function (id) { return $("#" + id).value; };
    var btn = e.target.querySelector("button[type=submit]");
    /* Sends the request, refreshes the data, and shows the server's message or its error under the form. */
    var send = function (promise, msg, after) {
      if (btn) btn.disabled = true;
      promise.then(function (d) {
        if (after) after();
        return refresh().then(function () { toast((d && d.message) || msg); });
      }).catch(function (x) {
        if (btn) btn.disabled = false;
        if (x.status === 401 || x.code === "temp") handleErr(x); else err(x.message);
      });
    };
    err("");
    if (f === "patient") {
      if (!val("f-name")) return err("Enter the patient's full name.");
      send(api("POST", "/api/patients", { name: val("f-name"), age: val("f-age"), sex: val("f-sex"), phone: val("f-phone"), status: val("f-status"), ward: val("f-ward"), doctor: val("f-doc"), dx: val("f-dx") }), "Patient registered", function () { ui.form = false; });
    } else if (f === "appt") {
      if (!val("f-reason")) return err("Enter the reason for the visit.");
      if (!val("f-date") || !val("f-time")) return err("Choose a date and time.");
      send(api("POST", "/api/appointments", { patient: val("f-pid"), doctor: val("f-did"), date: val("f-date"), time: val("f-time"), reason: val("f-reason") }), "Appointment booked", function () { ui.ad = val("f-date"); ui.form = false; });
    } else if (f === "invoice") {
      if (!val("f-desc")) return err("Describe what the invoice covers.");
      send(api("POST", "/api/invoices", { patient: val("f-pid"), desc: val("f-desc"), amount: val("f-amt"), due: val("f-due") }), "Invoice created", function () { ui.form = false; });
    } else if (f === "user") {
      send(api("POST", "/api/users", { name: val("f-uname"), username: val("f-user"), role: val("f-role"), password: raw("f-pass") }), "Account created", function () { ui.form = false; });
    } else if (f === "resetpw") {
      var target = ui.reset;
      send(api("POST", "/api/users/" + encodeURIComponent(target) + "/password", { password: raw("f-pass") }), "Password reset", function () { ui.reset = ""; });
    } else if (f === "account") {
      var cur = raw("a-cur"), n1 = raw("a-new"), n2 = raw("a-new2");
      if (!cur) return err("Enter your current password.");
      if (n1 !== n2) return err("The new passwords do not match.");
      if (btn) btn.disabled = true;
      api("POST", "/api/account/password", { current: cur, next: n1 }).then(function () {
        me.temp = false;
        location.hash = "#" + ROLES[me.role].views[0];
        return refresh().then(function () { toast("Password changed"); });
      }).catch(function (x) {
        if (btn) btn.disabled = false;
        if (x.status === 401) handleErr(x); else err(x.message);
      });
    }
  });
  window.addEventListener("hashchange", function () { if (me) route(); });
  boot();
})();
