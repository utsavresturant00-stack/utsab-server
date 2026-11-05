# Deploying the UTSAV API on Hostinger

The zip contains the API without `node_modules`; Hostinger installs them. Data and images live in MongoDB Atlas, so nothing needs a disk.

## From GitHub (auto deploy)

The repo has no secrets: `.env` and `production.env` are git-ignored. So add these under **Environment variables** in hPanel before the first deploy (copy the values from your local `server/.env`):

| Key | Value |
| --- | --- |
| `MONGODB_URI` | your Atlas link (…mongodb.net/utsav?retryWrites=true&w=majority) |
| `JWT_SECRET` | the long random string from `.env` (keep it the same, or everyone is signed out) |
| `TOKEN_TTL` | `7d` |
| `TZ_NAME` | `Asia/Kolkata` |

Entry file `server.cjs`, build command `npm run build` (or empty). Every push to `main` redeploys.

## hPanel Node.js app from a zip (Business / Cloud plans)

1. hPanel → **Websites** → **Add website** → **Node.js app** → upload `utsav-server.zip`.
2. Build settings:

   | Setting | Value |
   | --- | --- |
   | Application type | Express |
   | Node.js version | 18, 20 or 22 (all work) |
   | Entry file | **`server.cjs`** (works with Hostinger's runner; `server.js` / `src/index.js` may not) |
   | Install command | `npm install` |
   | Build command | `npm run build` (does nothing; there is no build step) — or leave empty |
   | Output directory | none |

3. **Settings**: the zip has `production.env` with the MongoDB link and login secret, and the API reads it on start. Hostinger drops `.env` files from uploads, which is why it is named this way. If you prefer, add the same keys under **Environment variables** in hPanel instead (`MONGODB_URI`, `JWT_SECRET`, `TOKEN_TTL`, `CORS_ORIGINS`, `TZ_NAME`); hPanel values win over the file. Don't set `PORT`; Hostinger sets it.
4. Deploy, then open `https://<your-api-domain>/api/health`. It should show `{"ok":true,"db":"connected"}`.
   If it shows `"db":"not connected"`, the `error` field says why (for example an IP not allowed in Atlas, or a wrong password). The API keeps retrying, so once the cause is fixed it connects by itself.

## If you see 503 Service Unavailable

- Entry file must be `server.cjs`.
- Open the app's **Runtime logs** in hPanel. A healthy start prints `UTSAV API listening on port …` and then `MongoDB connected`.
- Atlas → Network Access must allow the server (`0.0.0.0/0`).

## Before going live

- **MongoDB Atlas → Network Access**: allow the Hostinger server. Its IP can change, so `0.0.0.0/0` (allow from anywhere) is the simple choice; the database password still protects it.
- **CORS_ORIGINS** in `production.env`: set your website and admin addresses, e.g. `https://utsavcafe.in,https://admin.utsavcafe.in`. Empty allows any site.
- The database is already seeded with the menu, photos, 50 tables and logins. Do not run `npm run seed:from-client` on the server; it needs the website's source folder and is for development only.
- Then in `client/src/config.ts` and `admin/src/config.ts` set the production `api` link, set `isProduction = true`, and build both apps.

## Hostinger VPS (alternative)

```bash
mkdir -p ~/utsav-server && cd ~/utsav-server && unzip ~/utsav-server.zip
npm install --omit=dev
npm install -g pm2 && pm2 start server.js --name utsav-api && pm2 save && pm2 startup
```

Put Nginx in front with HTTPS (Certbot) and turn buffering off for live order updates:

```nginx
location /api/events { proxy_pass http://127.0.0.1:4000; proxy_buffering off; proxy_read_timeout 1h; }
location / { proxy_pass http://127.0.0.1:4000; client_max_body_size 10m; }
```
