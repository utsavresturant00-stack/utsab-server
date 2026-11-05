// Creates (or resets) the owner's admin login and a waiter login, then prints the credentials once.
//   npm run seed:users
// Usernames and passwords come from .env when set (SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD,
// SEED_WAITER_USERNAME, SEED_WAITER_PASSWORD); otherwise strong passwords are generated.
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { client, col, connect, nextId } from '../src/db.js'

// No lookalike characters, so the password is easy to read out and type on a phone.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
const generate = (n = 12) => Array.from({ length: n }, () => CHARS[randomInt(CHARS.length)]).join('')

const accounts = [
  { role: 'admin', name: 'Owner', username: process.env.SEED_ADMIN_USERNAME || 'admin', password: process.env.SEED_ADMIN_PASSWORD || generate() },
  { role: 'waiter', name: 'Waiter', username: process.env.SEED_WAITER_USERNAME || 'waiter', password: process.env.SEED_WAITER_PASSWORD || generate() },
]

await connect()
for (const a of accounts) {
  const usernameLower = a.username.toLowerCase()
  const passwordHash = await bcrypt.hash(a.password, 10)
  const existing = await col('users').findOne({ usernameLower })
  if (existing) {
    await col('users').updateOne({ id: existing.id }, { $set: { passwordHash, role: a.role, active: true } })
    a.status = 'password reset'
  } else {
    await col('users').insertOne({ id: await nextId('users'), name: a.name, username: a.username, usernameLower, passwordHash, role: a.role, active: true, createdAt: Date.now() })
    a.status = 'created'
  }
}
await client.close()

console.table(accounts.map(({ role, username, password, status }) => ({ role, username, password, status })))
console.log('Save these now; passwords are stored only as hashes and cannot be shown again.')
