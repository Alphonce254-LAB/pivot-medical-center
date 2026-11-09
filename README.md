# Pivot Medical Centre: hospital management system

A web app with a real server. The server checks every sign-in, every permission and every change, and keeps all data in a **PostgreSQL** database.

## What you need

1. **Node.js** 20.11 or newer (any current LTS). Check with `node -v`. Download from https://nodejs.org
2. **PostgreSQL** 14 or newer. Download from https://www.postgresql.org/download/ and install with the defaults. Remember the password you set for the `postgres` user during the install. (Or use a hosted PostgreSQL, see "Using a hosted database" below.)

## First-time setup

**1. Create the database.** Open "SQL Shell (psql)" from the Start menu (or pgAdmin's Query Tool), sign in as `postgres`, and run these two lines. Choose your own password in the first line.

```sql
CREATE USER pivot_app WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE pivot OWNER pivot_app;
```

**2. Tell the app where the database is.** In the project folder, copy the file `.env.example` to a new file named `.env`. Open `.env` and set `DATABASE_URL` with the password you chose:

```
DATABASE_URL=postgres://pivot_app:choose-a-strong-password@localhost:5432/pivot
```

If the password contains symbols such as `@ # / :`, replace each with its code (for example `@` becomes `%40`), or choose a password with only letters and numbers.

**3. Install and start.** Open the project folder in VS Code, open the terminal (Terminal > New Terminal), and run:

```
npm install
npm start
```

The first start creates the tables and prints a **username and temporary password for each account**. They are shown once, so write them down.

**4. Sign in.** Open http://127.0.0.1:3000 and sign in. You will be asked to choose a new password straight away.

Stop the server with Ctrl+C. Next time, just run `npm start`.

If you forget the administrator password: `npm run reset-password -- admin`

## Accounts and roles

| Role | Can see | Can do |
|---|---|---|
| Administrator | Everything, including Staff and the activity log | Everything, including adding staff, resetting passwords, marking doctors on or off duty |
| Doctor | Dashboard, patients, appointments, doctors | Admit and discharge, check in and complete appointments |
| Receptionist | Dashboard, patients, appointments, doctors | Register patients, admit, book, check in and cancel appointments |
| Accounts | Billing only (patient names, no medical details) | Create invoices, mark paid |

The server refuses anything outside the role, even if someone edits the page in the browser.

## Starting without sample data

Sample patients, appointments and invoices are added on the very first run. To start with an empty hospital and only the `admin` account, add this line to `.env` before the first start:

```
SEED_SAMPLE=0
```

The doctor list is created on first run from `seed.js`. Edit it there before the first start to use your own doctors.

## Moving data from the earlier SQLite version

If you already entered data with the earlier version (the one that stored everything in `data/hospital.db`):

1. Create a new, empty PostgreSQL database and set `DATABASE_URL` as above. Do not start the app yet.
2. Run: `npm run migrate-from-sqlite -- data/hospital.db` (this step needs Node.js 22.13 or newer).
3. Run `npm start`. Everyone keeps their account and password, but must sign in again.

## Using a hosted database

Services such as Neon, Supabase, Render, Railway or AWS give you a connection address. Put it in `DATABASE_URL`, and add this line, because hosted databases require an encrypted connection:

```
DATABASE_SSL=1
```

## Security built in

- Passwords are stored as salted scrypt hashes, never as text. Minimum 10 characters with a letter and a number.
- Temporary passwords are random, and every new or reset account must choose its own password at first sign-in.
- Sessions use a random token in an HttpOnly, SameSite=Strict cookie. Staff are signed out after 15 minutes idle (10 on screen) or 8 hours in total. Changing or resetting a password signs out the other sessions.
- Five wrong passwords lock that username for 60 seconds, doubling each time up to 15 minutes. There is also a limit per IP address.
- Every request is checked on the server for role and input. Database queries use bound parameters, so SQL injection does not work.
- Protection against forged requests from other websites, a strict content security policy, and other standard security headers.
- The database itself refuses double-booked doctors and double-occupied beds, even when many people act at the same moment.
- The activity log records sign-ins, failed sign-ins and every change, with the user and IP address (Administrator > Staff).

## Before real patient data goes in

This is a solid base, not a certified medical system. Before using real records:

1. **Use HTTPS.** Without it, passwords travel unencrypted. Put the app behind a reverse proxy that provides HTTPS (Caddy is the simplest, or nginx), then set `NODE_ENV=production` and `TRUST_PROXY=1` in `.env`. In production mode the cookie becomes Secure.
2. **Network access.** By default the server only answers on this computer. To let other devices on your network use it, set `HOST=0.0.0.0`, and only do so together with HTTPS.
3. **Protect the database.** Do not expose PostgreSQL to the internet. Use a strong password for `pivot_app`, and keep `.env` private.
4. **Back up every day** to a second location:
   ```
   pg_dump -Fc -U pivot_app -h localhost pivot > pivot-backup.dump
   ```
   Restore with `pg_restore -U pivot_app -h localhost -d pivot_restored pivot-backup.dump`. Test a restore at least once.
5. **Set the server clock and time zone** correctly, because appointment dates and the "overdue" status use it.
6. **Check your local data-protection and health-records rules.** They may require more, such as consent records, retention rules and breach procedures.

## Known limits

- No two-factor sign-in, and no per-patient access limits within a role.
- No screen for adding or editing doctors yet (edit `seed.js` before the first run).
- Sign-in lockout counters live in the server's memory and reset when it restarts.
- One server process suits a clinic. Several servers sharing one database would need the lockout counters moved into the database.

## Files

- `server.js`: web server and API, with all permission checks
- `db.js`: PostgreSQL connection and tables
- `auth.js`: password hashing and rules
- `seed.js`: first-run doctors, sample data and accounts
- `env.js`: reads the `.env` settings file
- `.env.example`: template for your settings
- `scripts/reset-password.js`: recover a locked-out account
- `scripts/migrate-from-sqlite.js`: one-time copy from the earlier SQLite version
- `public/`: the pages the browser loads (`index.html`, `styles.css`, `app.js`)
