"use strict";
// Password hashing with scrypt (built into Node.js). Passwords are never stored, only salted hashes.
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(crypto.scrypt);
const OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, OPTS);
  return "s1$" + salt.toString("hex") + "$" + key.toString("hex");
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, OPTS);
  return "s1$" + salt.toString("hex") + "$" + key.toString("hex");
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  const key = await scryptAsync(password, Buffer.from(parts[1], "hex"), KEYLEN, OPTS);
  const expected = Buffer.from(parts[2], "hex");
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Checked against when the username does not exist, so timing does not reveal which usernames are real.
const DUMMY_HASH = hashPasswordSync("not-a-real-password-1");

// Returns a message when the password is too weak, or "" when it is fine.
function passwordProblem(password, username) {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 128) return "Use no more than 128 characters.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Include at least one letter and one number.";
  const low = password.toLowerCase();
  if (username && username.length >= 3 && low.includes(String(username).toLowerCase())) return "The password must not contain the username.";
  if (/password|qwerty|12345678|letmein/.test(low)) return "That password is too easy to guess. Choose another.";
  return "";
}

function randomPassword() {
  for (;;) {
    const p = crypto.randomBytes(12).toString("base64url").slice(0, 14);
    if (/[A-Za-z]/.test(p) && /\d/.test(p)) return p;
  }
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, passwordProblem, randomPassword, DUMMY_HASH };
