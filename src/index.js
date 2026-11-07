import cors from 'cors'
import express from 'express'
import { loadSecret } from './auth.js'
import { config } from './config.js'
import { client, connect, db } from './db.js'
import { serveImage } from './media.js'
import adminRoutes from './routes/admin.js'
import authRoutes from './routes/auth.js'
import publicRoutes from './routes/public.js'
import staffRoutes from './routes/staff.js'
import { migrateToRestaurant, seed } from './seed.js'

// The server starts listening at once and connects to MongoDB in the background, retrying until it works.
// Hosts that wait for the port (Hostinger, Passenger) see the app as up straight away, and /api/health
// says exactly what is wrong if the database can't be reached.
const status = { ready: false, error: null, since: Date.now() }
let markReady
const ready = new Promise((resolve) => (markReady = resolve))

const start = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Connecting to MongoDB (attempt ${attempt})…`)
      await connect()
      await loadSecret()
      status.ready = true
      status.error = null
      markReady()
      console.log(`MongoDB connected: database "${db.databaseName}"`)
      break
    } catch (e) {
      status.error = e?.message ?? String(e)
      console.error(`MongoDB connection failed: ${status.error}`)
      await client?.close().catch(() => {})
      await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * attempt)))
    }
  }
  // Adds anything missing (it is quick when the database is already seeded). A failure here never stops the API.
  try {
    await seed()
  } catch (e) {
    console.error('Seeding skipped:', e?.message ?? e)
  }
  try {
    await migrateToRestaurant()
  } catch (e) {
    console.error('Restaurant update skipped:', e?.message ?? e)
  }
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : undefined))
app.use(express.json({ limit: '1mb' }))

app.get('/', (_req, res) => res.json({ name: 'UTSAV API', health: '/api/health' }))

app.get('/api/health', async (_req, res) => {
  const ok = status.ready && (await db.command({ ping: 1 }).then(() => true, () => false))
  res.status(ok ? 200 : 503).json({ ok, db: ok ? 'connected' : 'not connected', error: ok ? undefined : status.error ?? 'Still connecting…', node: process.version, time: Date.now() })
})

// Everything else needs the database; give it a few seconds while the server is starting.
const needDb = async (_req, res, next) => {
  if (status.ready) return next()
  const ok = await Promise.race([ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))])
  if (ok) return next()
  res.status(503).json({ error: 'The database is not connected yet. Please try again in a moment.', detail: status.error })
}

// Every image (seeded and uploaded) is stored in MongoDB and served from here.
app.get('/uploads/*', needDb, serveImage)
app.use('/api', needDb)
app.use('/api/public', publicRoutes)
app.use('/api/auth', authRoutes)
// Staff routes first: /tables/live must not fall into the admin-only table editor.
app.use('/api', staffRoutes)
app.use('/api', adminRoutes)

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))

// Every error leaves as { error: message }.
app.use((err, _req, res, _next) => {
  const code = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500)
  if (code >= 500) console.error(err)
  res.status(code).json({ error: code >= 500 ? 'Something went wrong on the server' : err.message })
})

// A stray error is logged instead of taking the whole API down.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e))
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e))

const server = app.listen(config.port, () => console.log(`UTSAV API listening on port ${config.port} (Node ${process.version})`))
void start()

const stop = async () => {
  server.close()
  await client?.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
