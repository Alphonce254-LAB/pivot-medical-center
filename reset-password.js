const crypto = require("node:crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hash(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, OPTS);
  return "s1$" + salt.toString("hex") + "$" + key.toString("hex");
}

(async () => {
  const newPw = "ChangeMe123!";
  await pool.query("UPDATE users SET pwhash=$1, temp=true", [hash(newPw)]);
  const r = await pool.query("SELECT username, role FROM users");
  console.table(r.rows);
  console.log("All passwords set to:", newPw);
  process.exit();
})();