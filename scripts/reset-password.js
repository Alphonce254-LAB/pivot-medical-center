"use strict";
// Use when the administrator is locked out:  npm run reset-password -- admin
// Sets a new temporary password for the account, signs it out everywhere and prints the password once.
const { query, close } = require("../db");
const { hashPasswordSync, randomPassword, passwordProblem } = require("../auth");

(async () => {
  const username = String(process.argv[2] || "").trim().toLowerCase();
  if (!username) throw new Error("Usage: npm run reset-password -- <username> [new-password]");
  const found = await query("SELECT 1 FROM users WHERE username = $1", [username]);
  if (!found.rows.length) throw new Error('No account named "' + username + '".');
  const password = process.argv[3] || randomPassword();
  const problem = passwordProblem(password, username);
  if (problem) throw new Error(problem);
  await query("UPDATE users SET pwhash = $1, temp = TRUE WHERE username = $2", [hashPasswordSync(password), username]);
  await query("DELETE FROM sessions WHERE username = $1", [username]);
  await query("INSERT INTO audit(t,username,ip,msg) VALUES ($1,$2,$3,$4)", [Date.now(), "server-console", "local", "Password reset for " + username]);
  console.log("New temporary password for " + username + ": " + password);
  console.log("They must choose a new password at their next sign-in.");
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => close());
