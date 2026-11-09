"use strict";
// One-time copy of the data from the earlier SQLite version of this app into PostgreSQL.
//   npm run migrate-from-sqlite -- path/to/hospital.db
// The PostgreSQL database must be new and empty. Everyone will have to sign in again afterwards.
// Reading the old file needs Node.js 22.13 or newer (the rest of the app does not).
const fs = require("node:fs");
const path = require("node:path");
const { query, tx, init, close, syncCounters } = require("../db");

(async () => {
  const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "hospital.db"));
  if (!fs.existsSync(file)) throw new Error("Cannot find " + file + ". Give the path: npm run migrate-from-sqlite -- path/to/hospital.db");
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch (e) { throw new Error("Reading the old file needs Node.js 22.13 or newer. Your version is " + process.version + "."); }
  const src = new DatabaseSync(file);
  const rows = (table) => src.prepare("SELECT * FROM " + table).all();

  await init();
  const used = (await query("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM patients) + (SELECT COUNT(*) FROM doctors) + (SELECT COUNT(*) FROM meta) AS n")).rows[0].n;
  if (used > 0) throw new Error("The PostgreSQL database already has data. Create a new empty database for the migration.");

  const counts = {};
  await tx(async (c) => {
    for (const r of rows("doctors")) await c.query("INSERT INTO doctors(id,name,dept,room,fee,duty) VALUES ($1,$2,$3,$4,$5,$6)", [r.id, r.name, r.dept, r.room, r.fee, !!r.duty]);
    for (const r of rows("users")) await c.query("INSERT INTO users(username,name,role,pwhash,temp,last_login,created) VALUES ($1,$2,$3,$4,$5,$6,$7)", [r.username, r.name, r.role, r.pwhash, !!r.temp, r.last_login, r.created]);
    for (const r of rows("patients")) await c.query("INSERT INTO patients(id,name,age,sex,phone,status,ward,bed,doctor_id,dx,since) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [r.id, r.name, r.age, r.sex, r.phone, r.status, r.ward, r.bed, r.doctor_id, r.dx, r.since]);
    for (const r of rows("appointments")) await c.query("INSERT INTO appointments(id,patient_id,doctor_id,date,time,reason,status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [r.id, r.patient_id, r.doctor_id, r.date, r.time, r.reason, r.status]);
    for (const r of rows("invoices")) await c.query("INSERT INTO invoices(id,patient_id,descr,amount,due,paid) VALUES ($1,$2,$3,$4,$5,$6)", [r.id, r.patient_id, r.descr, r.amount, r.due, !!r.paid]);
    for (const r of rows("audit")) await c.query("INSERT INTO audit(id,t,username,ip,msg) VALUES ($1,$2,$3,$4,$5)", [r.id, r.t, r.username, r.ip, r.msg]);
    await syncCounters(c);
    await c.query("INSERT INTO meta(k,v) VALUES ('initialised','1')");
    for (const t of ["doctors", "users", "patients", "appointments", "invoices", "audit"]) counts[t] = (await c.query("SELECT COUNT(*) AS n FROM " + t)).rows[0].n;
  });
  console.log("Copied into PostgreSQL:");
  for (const [t, n] of Object.entries(counts)) console.log("  " + t.padEnd(13) + n);
  console.log("Done. Start the app with: npm start");
})().catch((e) => { console.error("\nMigration stopped: " + e.message); process.exitCode = 1; }).finally(() => close());
