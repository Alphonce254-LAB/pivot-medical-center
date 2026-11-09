"use strict";
// Pivot Medical Centre: web server and API.
require("./env");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { query, tx, init, close, WARDS } = require("./db");
const auth = require("./auth");
const { firstRun } = require("./seed");

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // 127.0.0.1 = this computer only. Use 0.0.0.0 to allow other devices.
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || 0; // number of reverse proxies in front of this server
const IDLE_MS = 15 * 60 * 1000; // sign out after 15 minutes without activity
const ABSOLUTE_MS = 8 * 60 * 60 * 1000; // and after 8 hours in any case
const COOKIE = PROD ? "__Host-pivot_sid" : "pivot_sid";
const PUBLIC_DIR = path.join(__dirname, "public");
const ROLES = ["admin", "doctor", "receptionist", "accounts"];
const STAFF = ["admin", "doctor", "receptionist"];
const BED_LOCK = 7100; // PostgreSQL advisory lock: one bed assignment at a time

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (m) => new HttpError(400, m);

/* ---------- Input checks ---------- */
function str(v, min, max, label) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw bad("Check " + label + ".");
  v = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (v.length < min) throw bad("Enter " + label + ".");
  if (v.length > max) throw bad(label.charAt(0).toUpperCase() + label.slice(1) + " is too long (maximum " + max + " characters).");
  return v;
}
function int(v, min, max, label) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(label.charAt(0).toUpperCase() + label.slice(1) + " must be a whole number from " + min + " to " + max + ".");
  return n;
}
const pad = (n) => String(n).padStart(2, "0");
const todayStrOf = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const todayStr = () => todayStrOf(new Date());
function date(v, label) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad("Choose " + label + ".");
  const d = new Date(v + "T00:00:00");
  if (Number.isNaN(d.getTime()) || todayStrOf(d) !== v) throw bad("Choose " + label + ".");
  return v;
}
function time(v) {
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad("Choose a time.");
  return v;
}
function recordId(prefix, v) {
  const m = new RegExp("^" + prefix + "-(\\d{1,9})$").exec(String(v));
  if (!m) throw new HttpError(404, "Record not found.");
  return Number(m[1]);
}
const isUnique = (e) => e && e.code === "23505";

/* ---------- Shapes sent to the browser ---------- */
const toPatient = (r) => ({ id: "P-" + r.id, name: r.name, age: r.age, sex: r.sex, phone: r.phone, status: r.status, ward: r.ward, bed: r.bed, doc: r.doctor_id, dx: r.dx, since: r.since });
const toAppt = (r) => ({ id: "A-" + r.id, pid: "P-" + r.patient_id, did: r.doctor_id, date: r.date, time: r.time, reason: r.reason, status: r.status });
const toInvoice = (r) => ({ id: "INV-" + r.id, pid: "P-" + r.patient_id, desc: r.descr, amount: r.amount, due: r.due, paid: !!r.paid });
const toDoctor = (r) => ({ id: r.id, name: r.name, dept: r.dept, room: r.room, fee: r.fee, duty: !!r.duty });
const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, temp: !!u.temp });

/* ---------- Sessions, throttling, audit ---------- */
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function getCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; } }
  }
  return null;
}
function cookieHeader(value, maxAgeSeconds) {
  return COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAgeSeconds + (PROD ? "; Secure" : "");
}
function clientIp(req) {
  const remote = req.socket.remoteAddress || "unknown";
  if (!TRUST_PROXY) return remote;
  const list = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list[list.length - TRUST_PROXY] || remote;
}
// Writes one line to the activity log. A failure is reported on the server console but does not undo the action.
async function audit(ctx, msg, who) {
  try {
    await query("INSERT INTO audit(t,username,ip,msg) VALUES ($1,$2,$3,$4)", [Date.now(), String(who || (ctx.user && ctx.user.username) || "-").slice(0, 40), ctx.ip, String(msg).slice(0, 300)]);
  } catch (e) {
    console.error("Could not write to the activity log:", e.message);
  }
}

const fails = new Map();
function lockWait(key) { const e = fails.get(key); return e && e.until > Date.now() ? e.until - Date.now() : 0; }
function noteFail(key, limit) {
  const now = Date.now();
  const e = fails.get(key) || { n: 0, until: 0, locks: 0 };
  if (e.until > now) return;
  e.n++;
  if (e.n >= limit) { e.until = now + Math.min(60000 * 2 ** e.locks, 15 * 60000); e.locks++; e.n = 0; }
  fails.set(key, e);
}
const hits = new Map();
function tooManyRequests(ip) {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now - e.start > 60000) { hits.set(ip, { start: now, n: 1 }); return false; }
  return ++e.n > 600;
}
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of fails) if (e.until < now - 3600000 && e.n === 0) fails.delete(k);
  for (const [k, e] of hits) if (now - e.start > 60000) hits.delete(k);
  query("DELETE FROM sessions WHERE last_seen < $1 OR created < $2", [now - IDLE_MS, now - ABSOLUTE_MS]).catch((e) => console.error("Session cleanup failed:", e.message));
}, 5 * 60000);
sweeper.unref();

async function loadSession(req) {
  const token = getCookie(req, COOKIE);
  if (!token || token.length > 100) return {};
  const h = sha(token);
  const s = (await query("SELECT * FROM sessions WHERE id_hash = $1", [h])).rows[0];
  if (!s) return {};
  const now = Date.now();
  if (now - s.last_seen > IDLE_MS || now - s.created > ABSOLUTE_MS) { await query("DELETE FROM sessions WHERE id_hash = $1", [h]); return {}; }
  const user = (await query("SELECT username,name,role,temp FROM users WHERE username = $1", [s.username])).rows[0];
  if (!user) { await query("DELETE FROM sessions WHERE id_hash = $1", [h]); return {}; }
  // Background refreshes do not count as activity, so an idle screen still signs out.
  if (req.headers["x-background"] !== "1") await query("UPDATE sessions SET last_seen = $1 WHERE id_hash = $2", [now, h]);
  return { user, sid: h };
}

/* ---------- Routes ---------- */
const routes = [];
function route(method, pattern, guard, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, guard, handler });
}
const open = () => {};
const signedIn = (ctx) => { if (!ctx.user) throw new HttpError(401, "Sign in to continue."); };
const allow = (...roles) => (ctx) => {
  signedIn(ctx);
  if (ctx.user.temp) throw new HttpError(403, "Set a new password before continuing.", "temp");
  if (roles.length && !roles.includes(ctx.user.role)) throw new HttpError(403, "Your role cannot do this.");
};

route("GET", "/api/me", signedIn, (ctx) => ({ user: publicUser(ctx.user) }));

route("POST", "/api/login", open, async (ctx) => {
  const username = str(ctx.body.username, 0, 40, "your username").toLowerCase();
  const password = typeof ctx.body.password === "string" ? ctx.body.password.slice(0, 200) : "";
  const keyUser = "u:" + username, keyIp = "ip:" + ctx.ip;
  const wait = Math.max(lockWait(keyUser), lockWait(keyIp));
  if (wait > 0) throw new HttpError(429, "Too many failed attempts. Try again in " + Math.ceil(wait / 1000) + " seconds.");
  const user = username ? (await query("SELECT * FROM users WHERE username = $1", [username])).rows[0] : null;
  const ok = await auth.verifyPassword(password, user ? user.pwhash : auth.DUMMY_HASH);
  if (!user || !ok) {
    noteFail(keyUser, 5); noteFail(keyIp, 25);
    await audit(ctx, "Failed sign-in", username || "(blank)");
    const left = Math.max(lockWait(keyUser), lockWait(keyIp));
    throw new HttpError(401, left > 0 ? "Too many failed attempts. Wait " + Math.ceil(left / 1000) + " seconds." : "Username or password is incorrect.");
  }
  fails.delete(keyUser);
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  await query("INSERT INTO sessions(id_hash,username,created,last_seen) VALUES ($1,$2,$3,$4)", [sha(token), user.username, now, now]);
  await query("UPDATE users SET last_login = $1 WHERE username = $2", [now, user.username]);
  ctx.user = user;
  await audit(ctx, "Signed in");
  ctx.res.setHeader("Set-Cookie", cookieHeader(token, ABSOLUTE_MS / 1000));
  return { user: publicUser(user) };
});

route("POST", "/api/logout", signedIn, async (ctx) => {
  await query("DELETE FROM sessions WHERE id_hash = $1", [ctx.sid]);
  await audit(ctx, "Signed out");
  ctx.res.setHeader("Set-Cookie", cookieHeader("", 0));
  return { ok: true };
});

route("POST", "/api/account/password", signedIn, async (ctx) => {
  const current = typeof ctx.body.current === "string" ? ctx.body.current : "";
  const next = ctx.body.next;
  const row = (await query("SELECT pwhash FROM users WHERE username = $1", [ctx.user.username])).rows[0];
  if (!(await auth.verifyPassword(current, row.pwhash))) throw bad("Current password is incorrect.");
  const problem = auth.passwordProblem(next, ctx.user.username);
  if (problem) throw bad(problem);
  if (next === current) throw bad("Choose a password different from the current one.");
  await query("UPDATE users SET pwhash = $1, temp = FALSE WHERE username = $2", [await auth.hashPassword(next), ctx.user.username]);
  await query("DELETE FROM sessions WHERE username = $1 AND id_hash <> $2", [ctx.user.username, ctx.sid]);
  await audit(ctx, "Changed own password");
  return { ok: true };
});

route("GET", "/api/data", allow(), async (ctx) => {
  const role = ctx.user.role;
  const out = { wards: WARDS, doctors: [], patients: [], appts: [], invoices: [], users: [], log: [] };
  if (role === "accounts") {
    out.patients = (await query("SELECT id,name FROM patients ORDER BY id")).rows.map((r) => ({ id: "P-" + r.id, name: r.name }));
  } else {
    const [doctors, patients, appts] = await Promise.all([
      query("SELECT * FROM doctors ORDER BY id"),
      query("SELECT * FROM patients ORDER BY id DESC"),
      query("SELECT * FROM appointments ORDER BY date, time")
    ]);
    out.doctors = doctors.rows.map(toDoctor);
    out.patients = patients.rows.map(toPatient);
    out.appts = appts.rows.map(toAppt);
  }
  if (role === "admin" || role === "accounts") out.invoices = (await query("SELECT * FROM invoices ORDER BY id DESC")).rows.map(toInvoice);
  if (role === "admin") {
    const [users, log] = await Promise.all([
      query("SELECT username,name,role,temp,last_login FROM users ORDER BY created"),
      query("SELECT t,username,msg FROM audit ORDER BY id DESC LIMIT 40")
    ]);
    out.users = users.rows.map((u) => ({ username: u.username, name: u.name, role: u.role, temp: !!u.temp, last: u.last_login }));
    out.log = log.rows.map((l) => ({ t: l.t, u: l.username, m: l.msg }));
  }
  return out;
});

/* Patients */
async function nextBed(c, ward) {
  const used = (await c.query("SELECT bed FROM patients WHERE status = 'Admitted' AND ward = $1", [ward])).rows.map((r) => r.bed);
  for (let i = 1; i <= WARDS[ward]; i++) if (!used.includes(i)) return i;
  return 0;
}
async function needDoctor(id) {
  if (typeof id !== "string" || !(await query("SELECT 1 FROM doctors WHERE id = $1", [id])).rows.length) throw bad("Choose a doctor.");
  return id;
}
route("POST", "/api/patients", allow("admin", "receptionist"), async (ctx) => {
  const b = ctx.body;
  const name = str(b.name, 1, 80, "the patient's full name");
  const age = int(b.age, 0, 120, "age");
  if (b.sex !== "F" && b.sex !== "M") throw bad("Choose the patient's sex.");
  const phone = str(b.phone, 0, 30, "the phone number");
  if (b.status !== "Admitted" && b.status !== "Outpatient") throw bad("Choose Admitted or Outpatient.");
  const doctor = await needDoctor(b.doctor);
  const dx = str(b.dx, 0, 160, "the diagnosis") || "Not recorded";
  const id = await tx(async (c) => {
    let ward = "", bed = 0;
    if (b.status === "Admitted") {
      await c.query("SELECT pg_advisory_xact_lock($1)", [BED_LOCK]);
      ward = String(b.ward || "");
      if (!WARDS[ward]) throw bad("Choose a ward.");
      bed = await nextBed(c, ward);
      if (!bed) throw new HttpError(409, ward + " has no free beds. Choose another ward.");
    }
    const r = await c.query("INSERT INTO patients(name,age,sex,phone,status,ward,bed,doctor_id,dx,since) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id", [name, age, b.sex, phone, b.status, ward, bed, doctor, dx, todayStr()]);
    return r.rows[0].id;
  });
  await audit(ctx, "Registered patient P-" + id);
  return { message: "Registered P-" + id };
});

route("POST", "/api/patients/:id/admit", allow(...STAFF), async (ctx) => {
  const id = recordId("P", ctx.params.id);
  const ward = String(ctx.body.ward || "");
  if (!WARDS[ward]) throw bad("Choose a ward.");
  const bedNo = await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [BED_LOCK]);
    const p = (await c.query("SELECT status FROM patients WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!p) throw new HttpError(404, "Patient not found.");
    if (p.status === "Admitted") throw new HttpError(409, "This patient is already admitted.");
    const bed = await nextBed(c, ward);
    if (!bed) throw new HttpError(409, ward + " is full. Choose another ward.");
    await c.query("UPDATE patients SET status = 'Admitted', ward = $1, bed = $2, since = $3 WHERE id = $4", [ward, bed, todayStr(), id]);
    return bed;
  });
  await audit(ctx, "Admitted P-" + id + " to " + ward + ", bed " + bedNo);
  return { message: "Admitted to " + ward + ", bed " + bedNo };
});

route("POST", "/api/patients/:id/discharge", allow("admin", "doctor"), async (ctx) => {
  const id = recordId("P", ctx.params.id);
  const r = await query("UPDATE patients SET status = 'Discharged', ward = '', bed = 0 WHERE id = $1 AND status = 'Admitted'", [id]);
  if (!r.rowCount) throw new HttpError(409, "This patient is not admitted.");
  await audit(ctx, "Discharged P-" + id);
  return { message: "Patient discharged" };
});

/* Appointments */
route("POST", "/api/appointments", allow(...STAFF), async (ctx) => {
  const b = ctx.body;
  const pid = recordId("P", b.patient);
  if (!(await query("SELECT 1 FROM patients WHERE id = $1", [pid])).rows.length) throw bad("Choose a patient.");
  const doctor = await needDoctor(b.doctor);
  const d = date(b.date, "a date");
  if (d < todayStr()) throw bad("Choose today or a later date.");
  const t = time(b.time);
  const reason = str(b.reason, 1, 160, "the reason for the visit");
  let id;
  try {
    id = (await query("INSERT INTO appointments(patient_id,doctor_id,date,time,reason,status) VALUES ($1,$2,$3,$4,$5,'Scheduled') RETURNING id", [pid, doctor, d, t, reason])).rows[0].id;
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, "That doctor already has an appointment at this time. Pick another slot.");
    throw e;
  }
  await audit(ctx, "Booked A-" + id + " for P-" + pid);
  return { message: "Booked A-" + id };
});
const APPT_ACTIONS = {
  checkin: { from: ["Scheduled"], to: "Checked in", roles: STAFF, message: "Patient checked in" },
  complete: { from: ["Checked in"], to: "Completed", roles: ["admin", "doctor"], message: "Appointment completed" },
  cancel: { from: ["Scheduled", "Checked in"], to: "Cancelled", roles: STAFF, message: "Appointment cancelled" }
};
for (const [action, a] of Object.entries(APPT_ACTIONS)) {
  route("POST", "/api/appointments/:id/" + action, allow(...a.roles), async (ctx) => {
    const id = recordId("A", ctx.params.id);
    // One statement checks the current status and changes it, so two people cannot clash.
    const r = await query("UPDATE appointments SET status = $1 WHERE id = $2 AND status = ANY($3::text[])", [a.to, id, a.from]);
    if (!r.rowCount) {
      const row = (await query("SELECT status FROM appointments WHERE id = $1", [id])).rows[0];
      if (!row) throw new HttpError(404, "Appointment not found.");
      throw new HttpError(409, "This appointment is " + row.status.toLowerCase() + " and cannot be changed that way.");
    }
    await audit(ctx, a.message + " (A-" + id + ")");
    return { message: a.message };
  });
}

/* Doctors */
route("POST", "/api/doctors/:id/duty", allow("admin"), async (ctx) => {
  if (typeof ctx.body.duty !== "boolean") throw bad("Choose on duty or off duty.");
  const r = await query("UPDATE doctors SET duty = $1 WHERE id = $2", [ctx.body.duty, ctx.params.id]);
  if (!r.rowCount) throw new HttpError(404, "Doctor not found.");
  await audit(ctx, "Marked doctor " + ctx.params.id.slice(0, 10) + (ctx.body.duty ? " on duty" : " off duty"));
  return { message: ctx.body.duty ? "Doctor is on duty" : "Doctor is off duty" };
});

/* Billing */
route("POST", "/api/invoices", allow("admin", "accounts"), async (ctx) => {
  const b = ctx.body;
  const pid = recordId("P", b.patient);
  if (!(await query("SELECT 1 FROM patients WHERE id = $1", [pid])).rows.length) throw bad("Choose a patient.");
  const descr = str(b.desc, 1, 160, "what the invoice covers");
  const amount = int(b.amount, 1, 100000000, "the amount");
  const due = date(b.due, "a due date");
  const id = (await query("INSERT INTO invoices(patient_id,descr,amount,due,paid) VALUES ($1,$2,$3,$4,FALSE) RETURNING id", [pid, descr, amount, due])).rows[0].id;
  await audit(ctx, "Created INV-" + id + " for P-" + pid + " (KES " + amount + ")");
  return { message: "Created INV-" + id };
});
route("POST", "/api/invoices/:id/pay", allow("admin", "accounts"), async (ctx) => {
  const id = recordId("INV", ctx.params.id);
  const r = await query("UPDATE invoices SET paid = TRUE WHERE id = $1 AND paid = FALSE", [id]);
  if (!r.rowCount) throw new HttpError(409, "This invoice is already paid or does not exist.");
  await audit(ctx, "Marked INV-" + id + " paid");
  return { message: "Invoice marked paid" };
});

/* Staff accounts */
route("POST", "/api/users", allow("admin"), async (ctx) => {
  const b = ctx.body;
  const name = str(b.name, 1, 60, "the staff member's full name");
  const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) throw bad("Username must be 3 to 20 letters, numbers, dots, dashes or underscores.");
  if (!ROLES.includes(b.role)) throw bad("Choose a role.");
  const problem = auth.passwordProblem(b.password, username);
  if (problem) throw bad(problem);
  const hash = await auth.hashPassword(b.password);
  try {
    await query("INSERT INTO users(username,name,role,pwhash,temp,created) VALUES ($1,$2,$3,$4,TRUE,$5)", [username, name, b.role, hash, Date.now()]);
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, "That username is already taken.");
    throw e;
  }
  await audit(ctx, "Created account " + username + " (" + b.role + ")");
  return { message: "Created account " + username };
});
route("POST", "/api/users/:username/password", allow("admin"), async (ctx) => {
  const username = String(ctx.params.username).toLowerCase();
  if (!(await query("SELECT 1 FROM users WHERE username = $1", [username])).rows.length) throw new HttpError(404, "Account not found.");
  const problem = auth.passwordProblem(ctx.body.password, username);
  if (problem) throw bad(problem);
  await query("UPDATE users SET pwhash = $1, temp = TRUE WHERE username = $2", [await auth.hashPassword(ctx.body.password), username]);
  await query("DELETE FROM sessions WHERE username = $1 AND id_hash <> $2", [username, ctx.sid]);
  await audit(ctx, "Reset password for " + username);
  return { message: "Reset password for " + username };
});
route("DELETE", "/api/users/:username", allow("admin"), async (ctx) => {
  const username = String(ctx.params.username).toLowerCase();
  if (username === ctx.user.username) throw bad("You cannot remove your own account.");
  const r = await query("DELETE FROM users WHERE username = $1", [username]);
  if (!r.rowCount) throw new HttpError(404, "Account not found.");
  await audit(ctx, "Removed account " + username);
  return { message: "Removed account " + username };
});

/* ---------- HTTP plumbing ---------- */
function secureHeaders(res) {
  const csp = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"];
  if (PROD) csp.push("upgrade-insecure-requests");
  res.setHeader("Content-Security-Policy", csp.join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 50000) { reject(new HttpError(413, "Request is too large.")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function handleApi(req, res, url) {
  res.setHeader("Cache-Control", "no-store");
  const ip = clientIp(req);
  if (tooManyRequests(ip)) throw new HttpError(429, "Too many requests. Slow down and try again.");
  const method = req.method;
  let body = {};
  if (method !== "GET") {
    // Blocks requests forged from other websites: they cannot add this header or share this origin.
    if (req.headers["x-requested-with"] !== "pivot") throw new HttpError(403, "Request blocked.");
    if (req.headers.origin) {
      let ok = false;
      try { ok = new URL(req.headers.origin).host === req.headers.host; } catch (e) { ok = false; }
      if (!ok) throw new HttpError(403, "Request blocked.");
    }
    const raw = await readBody(req);
    if (raw) {
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw bad("Send JSON.");
      try { body = JSON.parse(raw); } catch (e) { throw bad("The request could not be read."); }
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("The request could not be read.");
    }
  }
  let match = null, pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method === method) { match = { r, m }; break; }
  }
  if (!match) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed." : "Not found.");
  const params = {};
  match.r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(match.m[i + 1]); } catch (e) { params[k] = ""; } });
  const ctx = { req, res, ip, body, params, ...(await loadSession(req)) };
  match.r.guard(ctx);
  sendJson(res, 200, await match.r.handler(ctx));
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { throw new HttpError(400, "Bad request."); }
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "Not found.");
  let data;
  try { data = fs.readFileSync(file); } catch (e) { throw new HttpError(404, "Not found."); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": data.length, "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : data);
}
function sendError(res, e) {
  let status = 500, message = "Something went wrong on the server. Try again.", code;
  if (e instanceof HttpError) { status = e.status; message = e.message; code = e.code; }
  else if (e && typeof e.code === "string" && /^23/.test(e.code)) { status = 409; message = "That conflicts with existing data."; } // PostgreSQL constraint errors
  else console.error(e);
  if (res.headersSent) { res.end(); return; }
  sendJson(res, status, { error: message, code });
}

const server = http.createServer(async (req, res) => {
  secureHeaders(res);
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    serveStatic(req, res, url);
  } catch (e) {
    sendError(res, e);
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;

async function main() {
  try {
    await init();
  } catch (e) {
    console.error("\nCould not set up the PostgreSQL database: " + e.message);
    console.error("Check that PostgreSQL is running and that DATABASE_URL in your .env file is correct. See README.md.\n");
    process.exit(1);
  }
  const created = await firstRun();
  if (created) {
    console.log("\n=== First run: sign-in details (shown once, write them down) ===");
    for (const a of created) console.log("  " + a.username.padEnd(12) + a.password.padEnd(18) + a.role);
    console.log("Each person must choose a new password at their first sign-in.\n");
  }
  server.listen(PORT, HOST, () => {
    console.log("Pivot Medical Centre is running at http://" + (HOST === "0.0.0.0" ? "localhost" : HOST) + ":" + PORT);
    if (!PROD) console.log("Set NODE_ENV=production and serve over HTTPS before real use. See README.md.");
  });
  const stop = () => { server.close(() => close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { server };
