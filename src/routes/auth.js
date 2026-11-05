import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { checkLoginRate, clearLoginFailures, publicUser, recordLoginFailure, requireAuth, signToken } from '../auth.js'
import { col } from '../db.js'
import { fail, pick, route } from '../util.js'

const r = Router()

r.post(
  '/login',
  route(async (req, res) => {
    const { username, password } = pick(req.body, { username: ['str', { required: true, max: 60 }], password: ['str', { required: true, max: 200 }] })
    const key = `${req.ip}|${username.toLowerCase()}`
    checkLoginRate(key)
    const user = await col('users').findOne({ usernameLower: username.toLowerCase() })
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
      recordLoginFailure(key)
      fail(401, 'Wrong username or password')
    }
    clearLoginFailures(key)
    res.json({ token: signToken(user), user: publicUser(user) })
  }),
)

r.get('/me', requireAuth(), (req, res) => res.json(publicUser(req.user)))

r.post(
  '/password',
  requireAuth(),
  route(async (req, res) => {
    const { current, next } = pick(req.body, { current: ['str', { required: true, max: 200 }], next: ['str', { required: true, max: 200 }] })
    if (next.length < 6) fail(400, 'The new password needs at least 6 characters')
    if (!(await bcrypt.compare(current, req.user.passwordHash))) fail(400, 'Current password is wrong')
    await col('users').updateOne({ id: req.user.id }, { $set: { passwordHash: await bcrypt.hash(next, 10) } })
    res.json({ ok: true })
  }),
)

export default r
