import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url))

// Reads settings from .env (or production.env, for hosts that drop dot-files from uploads)
// without needing any Node flags. Values already set by the host's environment variables panel win.
for (const envFile of [root('.env'), root('production.env')]) {
  if (!existsSync(envFile)) continue
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

if (!process.env.MONGODB_URI) console.error("MONGODB_URI is not set. Add it to .env / production.env or the host's environment variables.")

export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI || '',
  seedDir: root('seed'),
  // Empty means a secret is generated once and kept in the database (see auth.js).
  jwtSecret: process.env.JWT_SECRET || '',
  tokenTtl: process.env.TOKEN_TTL || '7d',
  // Comma-separated list of allowed browser origins; empty allows any (fine: auth uses bearer tokens, not cookies).
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  timeZone: process.env.TZ_NAME || 'Asia/Kolkata',
}
