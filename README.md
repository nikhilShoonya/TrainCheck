# TrainCheck

## Configuration

Settings live in `backend/.env` and `frontend/.env`. Copy them from the `.env.example` next to each, which explains every setting. Never commit a `.env` file; `.gitignore` excludes them.

The settings that matter most for real use:

| File | Setting | Real use |
| --- | --- | --- |
| `backend/.env` | `DATABASE_URL` | The only database setting. For Neon, the **direct** connection string (no `-pooler` in the host). The API, scheduler, operator commands and Alembic migrations all use it. |
| `backend/.env` | `DEMO_RESET_ENABLED` | `false`. When `true`, anyone can erase all data from the sign-in page. |
| `backend/.env` | `EMPLOYEE_PASSWORD_CHANGE_ENABLED` | `false` keeps employee passwords at `Fin@DDMMYYYY` (joining date). `true` lets employees change theirs. |
| `backend/.env` | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The designated L&D Admin. Applied only by `sync-admin` (below). |
| `frontend/.env` | `NEXT_PUBLIC_DEMO_MODE` | `false`. Keep `NEXT_PUBLIC_DEMO_PASSWORD` empty. |

### When a change takes effect

| What changed | What to do |
| --- | --- |
| Any backend setting except `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Restart the backend. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Run `python -m app.manage sync-admin`. No restart needed. |
| `NEXT_PUBLIC_*` in the frontend | These are built into the browser code. Restart `npm run dev`, or run `npm run build` again and restart `npm start`. |
| `BACKEND_URL` in the frontend | Restart the frontend. |

Changing a setting never erases data. Data is erased only by the explicit commands below.

## The designated L&D Admin

1. In `backend/.env`, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 10 characters with upper case, lower case and a number).
2. From `backend/`, run `python -m app.manage sync-admin`.

The first run creates the account: employee record `TC-LD-ADMIN`, name "L&D Admin", role L&D Admin. Later runs update that same account:

- A new email changes the address of the same account. It does not create a second admin.
- A changed email or password signs out the admin's existing sessions.
- Running it again with the same values changes nothing.
- It refuses, changing nothing, if the email belongs to another employee or account, or if `TC-LD-ADMIN` belongs to a record it did not create. It never touches or promotes anyone else.
- It runs only when you call it, never at startup. Running it makes the `.env` password the current one again, including after the admin changed it in My profile or an operator reset it.

The email and password are stored only in `backend/.env` and as a password hash. They are never printed, logged, audited or sent to the browser.

Other operator commands, also run from `backend/`: `reset-password <email>`, `set-role <email> <role>` and `import-employees <file.csv>`. See `app/manage.py`.

## Starting with an empty database

This is a one-time operator operation. Nothing runs it automatically.

1. Stop the backend, and pause any other instance that writes to the database.
2. Back up the database (below) and confirm the backup restores.
3. Erase the records: `python -m app.manage clear-data --confirm-database <database name>`. Every application record is removed: employees, accounts, sessions, trainings, assignments, assessments, results, notifications and audit history. The schema, the migration history (`alembic_version`) and the two roles stay.
4. Set the working calendar, for example `python -m app.manage set-calendar --timezone Asia/Kolkata --weekdays Mon-Fri`. Add `--holiday dd/mm/yyyy` for holidays, or add them later in L&D Admin.
5. Create the admin: `python -m app.manage sync-admin`.
6. Start the backend, sign in as the admin, and add departments, then employees (Employee Assignments → Add Employee).

## Backups and restoring

Use PostgreSQL's own tools, version 18 or newer to match the server: `pg_dump`, `pg_restore`, `psql`. The portable Windows binaries from EnterpriseDB work without installing anything. They need the Microsoft Visual C++ 2015–2022 runtime, either installed or with `vcruntime140.dll`, `vcruntime140_1.dll` and `msvcp140.dll` copied next to them.

- **Back up:** `pg_dump --format=custom --no-owner --no-privileges --file=traincheck.dump "<DATABASE_URL without +psycopg>"`. The dump contains password hashes and personal data, so keep it in a folder only you can read. Also copy `backend/var/files` (uploads and exports) and `backend/.env`.
- **Restore safely:** restore into a new, empty database first, such as a new Neon branch or a local PostgreSQL. Compare it, then point `DATABASE_URL` at it: `pg_restore --no-owner --no-privileges --dbname="<target URL>" traincheck.dump`.
- **Restore over the live database:** this **replaces all real records**, so do it only with explicit authorisation, and take a fresh backup of the current data first. Stop the backend, then run `pg_restore --clean --if-exists --no-owner --no-privileges --dbname="<DATABASE_URL>" traincheck.dump`, and put back the matching `backend/var/files`.

## Demo data

Demo data is never loaded on its own, not at startup, restart or migration, nor when a setting changes. To load the synthetic demo data deliberately (it never belongs beside real records), first take a backup. Then run, from `backend/`:

- `python -m app.seed --confirm-database <database name>` loads it into an **empty** database. It refuses when employees exist.
- `python -m app.seed --confirm-database <database name> --reset` **erases every record** and loads the demo data. It requires explicit authorisation wherever real records exist.

Both refuse when `APP_ENV=production`. The demo seed lives in `app/seed.py` and `app/seed_data.py`.

## Tests

The backend tests never use `DATABASE_URL`. Each run creates its own throwaway PostgreSQL server in a temporary folder, on 127.0.0.1 and a free port. It migrates that server with the real Alembic scripts, erases it freely, and deletes it at the end. The PostgreSQL programs (`initdb`, `pg_ctl`) are taken from `pytest --pg-bin <folder>`, from `PATH`, or from `%LOCALAPPDATA%\TrainCheck\pgsql18\bin`. If none is found, the database tests are refused rather than pointed anywhere else.

```
cd backend
python -m pytest
```

Browser tests (`frontend`, Playwright) consume demo assessments, so run them only against a backend whose `DATABASE_URL` is a throwaway database loaded with demo data. Never run them against real data.
