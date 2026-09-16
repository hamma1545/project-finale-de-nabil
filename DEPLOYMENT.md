# Render deployment

This project keeps the existing React/Vite frontend, PostgreSQL schema, public verification API, admin authentication, session cookies, QR generation, and Cloudflare Worker implementation. Render uses the added Node/Express adapter at `server/index.ts`; the existing Worker files remain available for the original Cloudflare deployment path.

## Architecture

`Render Static Site (Vite SPA) → Render Web Service (Express API) → PostgreSQL (Neon or Render PostgreSQL)`

The frontend and API are separate origins in production. The API therefore uses an allowlist and secure cross-site HTTP-only cookies for the admin session.

## Required environment variables

### Backend Web Service: `certificate-verification-api`

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | Do not set manually; Render supplies it. The app defaults to `10000` locally. |
| `DATABASE_URL` | PostgreSQL connection string from Neon or Render PostgreSQL. Use SSL-enabled connection details. |
| `SESSION_SECRET` | Long random value. The Blueprint generates one automatically; it is retained for future rotation and must not be committed. |
| `ALLOWED_ORIGIN` | Exact frontend URL, for example `https://certificate-verification-frontend.onrender.com`, with no trailing slash. Multiple origins may be comma-separated. |

### Static Site: `certificate-verification-frontend`

| Variable | Value |
|---|---|
| `VITE_API_URL` | Exact API URL, for example `https://certificate-verification-api.onrender.com`, with no trailing slash. |

`VITE_API_URL` is a public URL, not a secret. Never put `DATABASE_URL`, `SESSION_SECRET`, or an admin password in the Static Site environment.

## Database setup

Use the existing schema; no tables or API fields were changed. Create a PostgreSQL database in Neon or Render, copy its connection string into the backend service, and apply:

```bash
psql "$DATABASE_URL" -f database/schema.sql
```

The schema is idempotent and seeds certificate `603778716`. Create the first administrator by generating a PBKDF2 hash locally:

```bash
node scripts/hash-password.mjs 'choose-a-strong-password'
```

Then insert the returned hash into the database:

```sql
INSERT INTO admins (email, password_hash)
VALUES ('admin@example.com', 'PASTE_THE_GENERATED_HASH');
```

Do not commit the password, hash, connection string, or any `.env` file.

## Recommended deployment order

1. **Create or prepare PostgreSQL first.** Apply `database/schema.sql` and create the admin row.
2. **Deploy the backend Web Service.** Set `DATABASE_URL`, allow Render to generate `SESSION_SECRET`, and temporarily set `ALLOWED_ORIGIN` to the final frontend URL you plan to use.
3. **Deploy the Static Site.** Set `VITE_API_URL` to the backend URL, then deploy the frontend.
4. **Return to the backend and confirm `ALLOWED_ORIGIN` exactly matches the deployed frontend URL.** Redeploy if the URL changed.

## Manual Render service configuration

### Backend Web Service

- **Root Directory:** repository root
- **Runtime:** Node
- **Build Command:** `corepack enable && pnpm install --frozen-lockfile`
- **Start Command:** `pnpm start`
- **Health Check Path:** `/health`
- **Plan:** Free

### Frontend Static Site

- **Root Directory:** repository root
- **Build Command:** `corepack enable && pnpm install --frozen-lockfile && pnpm build`
- **Publish Directory:** `dist`
- **Plan:** Free
- **Rewrite:** the committed `client/public/_redirects` file keeps SPA routes such as `/verify` and `/admin` working.

## Blueprint deployment

The committed `render.yaml` defines both services and requests only the values that cannot safely be inferred: `DATABASE_URL`, `ALLOWED_ORIGIN`, and `VITE_API_URL`.

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Review the two services from `render.yaml`.
4. Enter the PostgreSQL URL for `DATABASE_URL`.
5. Enter the final Static Site URL for the backend `ALLOWED_ORIGIN` and the final API URL for frontend `VITE_API_URL`. If Render assigns different names/URLs, use those actual URLs.
6. Apply the Blueprint. If the frontend URL is not known until creation, deploy the services, then update the two URL variables and redeploy both affected services.
7. Apply the schema and create the admin as described above.

## Local development and verification

```bash
pnpm install
cp .env.example .env
# Set DATABASE_URL and SESSION_SECRET in .env.
# Start the API in one terminal:
pnpm start
# Start Vite in another terminal:
pnpm dev
```

The frontend defaults to `http://localhost:10000` as its API origin in the supplied example. The API binds to `0.0.0.0` and honors Render's `PORT` variable. Run the checks locally:

```bash
pnpm run check
pnpm run build
PORT=10000 NODE_ENV=production DATABASE_URL="$DATABASE_URL" ALLOWED_ORIGIN=http://localhost:5173 pnpm start
curl http://localhost:10000/health
```

For production validation, open the Static Site URL, verify certificate `603778716`, open `/admin`, log in, create/edit/delete a certificate, generate/download its QR code, and confirm the QR opens the public `/verify` route. A browser CORS error almost always means `ALLOWED_ORIGIN` has the wrong URL or a trailing slash.

## Free-tier limitations

Render free Web Services can spin down after inactivity, so the first request may be slow. They have limited CPU, memory, bandwidth, and build/runtime hours, and are not intended for high traffic or latency-sensitive production workloads. Ephemeral service filesystems must not be used for durable uploads or generated documents; this project stores its durable records in PostgreSQL and generates QR images in the browser. Neon or a free PostgreSQL option may also sleep, have connection/rate limits, or impose storage limits. Keep database queries short and use an external object store if future features add persistent PDF/upload storage.

Render may also suspend free services subject to current account policies. Check Render's current free-tier terms before relying on the service for critical verification traffic.
