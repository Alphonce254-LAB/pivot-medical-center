"use strict";
// First-run setup: the doctor roster, optional sample records, and the first staff accounts.
const { tx, syncCounters } = require("./db");
const { hashPasswordSync, randomPassword } = require("./auth");

const pad = (n) => String(n).padStart(2, "0");
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

const DOCTORS = [
  ["D1", "Dr. Achieng Otieno", "Cardiology", "Block B · Room 204", 3500, true],
  ["D2", "Dr. Kamau Mwangi", "General Medicine", "Block A · Room 110", 2000, true],
  ["D3", "Dr. Fatuma Hassan", "Obstetrics", "Maternity Wing · Room 3", 3000, true],
  ["D4", "Dr. Peter Njoroge", "Pediatrics", "Block C · Room 021", 2500, true],
  ["D5", "Dr. Wanjiru Kariuki", "Orthopaedics", "Block B · Room 112", 3500, false],
  ["D6", "Dr. Samuel Odhiambo", "Critical Care", "ICU · Station 1", 5000, true]
];

async function insertAll(c, sql, rows) {
  for (const r of rows) await c.query(sql, r);
}

async function seedSample(c) {
  await insertAll(c, "INSERT INTO patients(id,name,age,sex,phone,status,ward,bed,doctor_id,dx,since) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
    [1001, "Grace Wanjiku", 54, "F", "0712 000 101", "Admitted", "General", 1, "D2", "Pneumonia", addDays(-3)],
    [1002, "Hassan Abdi", 67, "M", "0722 000 102", "Admitted", "ICU", 1, "D6", "Acute myocardial infarction", addDays(-1)],
    [1003, "Mercy Chebet", 28, "F", "0733 000 103", "Admitted", "Maternity", 1, "D3", "Labour, 38 weeks", addDays(0)],
    [1004, "Brian Otieno", 9, "M", "0710 000 104", "Admitted", "Pediatrics", 1, "D4", "Asthma exacerbation", addDays(-2)],
    [1005, "John Mutua", 41, "M", "0714 000 105", "Admitted", "General", 2, "D5", "Femur fracture, post-op", addDays(-5)],
    [1006, "Naomi Akinyi", 33, "F", "0723 000 106", "Admitted", "Maternity", 2, "D3", "Post-caesarean recovery", addDays(-2)],
    [1007, "Peter Kiprop", 59, "M", "0734 000 107", "Admitted", "General", 3, "D2", "Type 2 diabetes review", addDays(-1)],
    [1008, "Amina Yusuf", 6, "F", "0711 000 108", "Outpatient", "", 0, "D4", "Fever follow-up", addDays(-4)],
    [1009, "Daniel Maina", 46, "M", "0721 000 109", "Outpatient", "", 0, "D1", "Hypertension check", addDays(-9)],
    [1010, "Esther Njeri", 72, "F", "0735 000 110", "Outpatient", "", 0, "D2", "Joint pain", addDays(-2)],
    [1011, "Joseph Ouma", 38, "M", "0713 000 111", "Discharged", "", 0, "D5", "Knee ligament repair", addDays(-12)],
    [1012, "Lucy Wambui", 25, "F", "0724 000 112", "Outpatient", "", 0, "D3", "Antenatal visit", addDays(-6)]
  ]);
  await insertAll(c, "INSERT INTO appointments(id,patient_id,doctor_id,date,time,reason,status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    [3001, 1009, "D1", addDays(0), "09:00", "Blood pressure review", "Completed"],
    [3002, 1008, "D4", addDays(0), "10:30", "Fever follow-up", "Checked in"],
    [3003, 1010, "D2", addDays(0), "11:15", "Joint pain, X-ray results", "Scheduled"],
    [3004, 1012, "D3", addDays(0), "14:00", "Antenatal scan", "Scheduled"],
    [3005, 1009, "D1", addDays(0), "15:30", "ECG", "Scheduled"],
    [3006, 1011, "D5", addDays(1), "09:30", "Wound check", "Scheduled"],
    [3007, 1008, "D4", addDays(3), "10:00", "Review", "Scheduled"],
    [3008, 1010, "D2", addDays(-2), "13:00", "Initial consultation", "Completed"]
  ]);
  await insertAll(c, "INSERT INTO invoices(id,patient_id,descr,amount,due,paid) VALUES ($1,$2,$3,$4,$5,$6)", [
    [2001, 1005, "Surgery and 5 ward days", 185000, addDays(7), false],
    [2002, 1002, "ICU, day 1", 62000, addDays(3), false],
    [2003, 1011, "Surgery and discharge", 210000, addDays(-5), true],
    [2004, 1009, "Consultation and ECG", 4500, addDays(0), true],
    [2005, 1001, "3 ward days, chest X-ray", 38500, addDays(-2), false],
    [2006, 1008, "Consultation", 2500, addDays(0), true],
    [2007, 1010, "Consultation and lab tests", 6200, addDays(1), false]
  ]);
}

// Returns the list of new accounts with their temporary passwords on first run, otherwise null.
async function firstRun() {
  const withSample = process.env.SEED_SAMPLE !== "0";
  const accounts = withSample
    ? [
        ["admin", "System Administrator", "admin"],
        ["doctor", "Dr. Achieng Otieno", "doctor"],
        ["reception", "Front Desk", "receptionist"],
        ["accounts", "Billing Office", "accounts"]
      ]
    : [["admin", "System Administrator", "admin"]];
  const created = [];
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7001)"); // two servers starting together must not both seed
    if ((await c.query("SELECT 1 FROM meta WHERE k = 'initialised'")).rows.length) return;
    await insertAll(c, "INSERT INTO doctors(id,name,dept,room,fee,duty) VALUES ($1,$2,$3,$4,$5,$6)", DOCTORS);
    if (withSample) await seedSample(c);
    for (const [username, name, role] of accounts) {
      const pw = randomPassword();
      await c.query("INSERT INTO users(username,name,role,pwhash,temp,created) VALUES ($1,$2,$3,$4,TRUE,$5)", [username, name, role, hashPasswordSync(pw), Date.now()]);
      created.push({ username, role, password: pw });
    }
    await syncCounters(c);
    await c.query("INSERT INTO meta(k,v) VALUES ('initialised','1')");
  });
  return created.length ? created : null;
}

module.exports = { firstRun };
