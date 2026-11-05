import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { clean, col } from './db.js'
import { fail } from './util.js'

let secret = config.jwtSecret

/** Without JWT_SECRET a random one is made once and kept in the database, so logins survive restarts. */
export const loadSecret = async () => {
  if (secret) return
  const doc = await col('meta').findOneAndUpdate(
    { _id: 'jwt' },
    { $setOnInsert: { secret: randomBytes(48).toString('hex') } },
    { upsert: true, returnDocument: 'after' },
  )
  secret = doc.secret
}

export const signToken = (user) => jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: config.tokenTtl })

export const publicUser = (u) => u && { id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active, createdAt: u.createdAt }

/** The active user a token belongs to, or null. */
export const userFromToken = async (token) => {
  try {
    const { sub } = jwt.verify(token, secret)
    const user = clean(await col('users').findOne({ id: sub }))
    return user?.active ? user : null
  } catch {
    return null
  }
}

/** Requires a signed-in staff member; pass roles to narrow it, e.g. requireAuth('admin'). */
export const requireAuth =
  (...roles) =>
  async (req, _res, next) => {
    const header = req.get('authorization') ?? ''
    const user = await userFromToken(header.startsWith('Bearer ') ? header.slice(7) : '')
    if (!user) return next(Object.assign(new Error('Please sign in again'), { status: 401 }))
    if (roles.length && !roles.includes(user.role)) return next(Object.assign(new Error('You do not have access to this'), { status: 403 }))
    req.user = user
    next()
  }

// Slows down password guessing: 10 failed tries per username and address every 15 minutes.
const attempts = new Map()
const WINDOW = 15 * 60_000

export const checkLoginRate = (key) => {
  const a = attempts.get(key)
  if (a && Date.now() - a.first < WINDOW && a.count >= 10) fail(429, 'Too many tries. Wait 15 minutes and try again.')
}
export const recordLoginFailure = (key) => {
  const now = Date.now()
  const a = attempts.get(key)
  if (!a || now - a.first >= WINDOW) attempts.set(key, { first: now, count: 1 })
  else a.count += 1
}
export const clearLoginFailures = (key) => attempts.delete(key)
