"use strict";
// Loads settings from a file named .env in this folder, if there is one. Real environment variables win.
const fs = require("node:fs");
const path = require("node:path");

try {
  const text = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
} catch (e) {
  /* no .env file: that is fine */
}
