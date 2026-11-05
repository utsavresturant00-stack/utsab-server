# UTSAV API

Node 18.17+, Express and MongoDB (Atlas). Every image — the original photos and anything uploaded from the admin panel — is stored in MongoDB too (GridFS bucket `media`), so the server keeps nothing on its own disk and can run on any host.

```bash
npm install
cp .env.example .env   # then fill in MONGODB_URI and JWT_SECRET
npm run seed           # put the website's content and photos into the database
npm run dev            # restarts on file changes
npm start              # production (node server.js also works; no Node flags needed)
```

## Environment (`.env`)

| Name | What it is |
| --- | --- |
| `MONGODB_URI` | Connection string; the database name comes after the host (`…mongodb.net/utsav`) |
| `JWT_SECRET` | Long random string that signs logins. Changing it signs everyone out |
| `TOKEN_TTL` | How long a login lasts, e.g. `7d` |
| `CORS_ORIGINS` | Comma-separated website and admin URLs allowed to call the API. Empty allows any (fine locally) |
| `PORT`, `TZ_NAME` | Port, and the time zone used for daily and monthly reports |

In Atlas, allow the server's IP under Network Access.

## Scripts

- `npm run seed` — adds whatever is missing: settings, 15 categories, 77 dishes, offers, 13 gallery photos, hero slides, reviews, notifications, 50 tables, the two starter logins and all 95 photos. Safe to run again. The server also runs it on start.
- `npm run seed:users` — creates or resets the admin and waiter logins and prints new passwords (or uses `SEED_*` values from .env).
- `npm run seed:tables` — makes sure tables 1-50 exist (1-20 Main Hall, 21-35 Family Section, 36-50 Outdoor); `-- --layout` also resets their seats and areas.
- `npm run seed -- --reset` — wipes the content and seed photos and seeds them fresh. Orders, invoices and staff accounts are kept.
- `npm run demo` / `npm run demo -- --remove` — add or remove a year of sample orders for the dashboard charts.
- `npm run seed:from-client` — rebuilds `seed/` from the website's bundled data and photos (development only; needs ../client).

Starter logins: `admin / admin123` and `waiter / waiter123`. Change them in the admin panel.

## Collections

`settings` (one document, `_id: "site"`), `users`, `categories`, `menu`, `offers`, `gallery`, `slides`, `testimonials`, `notifications`, `tables`, `orders` (lines embedded), `invoices`, `counters` (running numbers for ids, order and invoice numbers), `meta`, and `media.files` / `media.chunks` for images. Images are served at `/uploads/<path>`.

## Endpoints

All under `/api`. Errors come back as `{ "error": "message" }`. `GET /api/health` also checks the database.

**Public (website)**
- `GET /public/content` — settings, categories, menu, offers, gallery, slides, reviews, notifications
- `GET /public/tables` — every table with `status`: free, occupied or reserved (guests pick their table from this)
- `GET /public/tables/:number` — checks a table from its QR code
- `POST /public/orders` — place an order; the server prices it. Returns the order plus a `token`
- `GET /public/orders/:id?token=` · `POST /public/orders/lookup` · `POST /public/orders/:id/cancel`

**Sign-in**: `POST /auth/login` → `{ token, user }`, then send `Authorization: Bearer <token>`. `GET /auth/me`, `POST /auth/password`.

**Staff (admin and waiter)**
- `GET /events?token=` — live order events (Server-Sent Events)
- `GET /orders` (filters: `status`, `mode`, `q`, `from`, `to`, `tableId`) · `GET /orders/counts` · `GET /orders/:id`
- `POST /orders` — waiter or counter order · `PATCH /orders/:id/step` · `PATCH /orders/:id/payment`
- `POST /orders/:id/invoice` · `GET /invoices` · `GET /invoices/:id`
- `GET /tables` · `GET /tables/live` · `POST /tables/:id/settle` · `POST /tables/:id/reservation` (`{ reserved, reservedFor }`; orders on a reserved table are refused) · `GET /settings`

**Admin only**
- `POST /orders/:id/cancel`
- `GET|PUT /settings` · `POST /uploads?folder=` (multipart `file`, stored in MongoDB)
- CRUD (`GET`, `POST`, `PUT /:id`, `DELETE /:id`, `PUT /order`): `/menu`, `/categories`, `/offers`, `/gallery`, `/slides`, `/testimonials`, `/notifications`, `/tables`
- `/users` (staff accounts) · `GET /reports/dashboard` · `GET /reports/customers`
