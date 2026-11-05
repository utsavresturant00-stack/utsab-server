import { randomBytes } from 'node:crypto'
import { col } from './db.js'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const fail = (status, message) => {
  throw new HttpError(status, message)
}

/** Lets async route handlers throw; errors reach the error middleware. */
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// ---- Input checks -----------------------------------------------------------

const str = (v, { field, max = 500, required = false, def = '' }) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(400, `${field} is required`)
    return def
  }
  if (typeof v !== 'string' && typeof v !== 'number') fail(400, `${field} must be text`)
  const s = String(v).trim()
  if (required && !s) fail(400, `${field} is required`)
  if (s.length > max) fail(400, `${field} is too long (max ${max})`)
  return s
}

const num = (v, { field, min = -Infinity, max = Infinity, int = false, required = false, def = 0 }) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(400, `${field} is required`)
    return def
  }
  const n = Number(v)
  if (!Number.isFinite(n)) fail(400, `${field} must be a number`)
  if (int && !Number.isInteger(n)) fail(400, `${field} must be a whole number`)
  if (n < min || n > max) fail(400, `${field} must be between ${min} and ${max}`)
  return n
}

const bool = (v, { def = false }) => (v === undefined || v === null ? def : v === true || v === 1 || v === '1' || v === 'true')

/**
 * Reads the fields in `spec` from `body`. With `partial`, missing fields are left out (for updates).
 * spec: { field: ['str' | 'int' | 'num' | 'bool' | 'enum', options] }
 */
export const pick = (body, spec, { partial = false } = {}) => {
  const out = {}
  for (const [field, [type, opts = {}]] of Object.entries(spec)) {
    if (partial && body[field] === undefined) continue
    const o = { field, ...opts }
    if (type === 'str') out[field] = str(body[field], o)
    else if (type === 'int') out[field] = num(body[field], { ...o, int: true })
    else if (type === 'num') out[field] = num(body[field], o)
    else if (type === 'bool') out[field] = bool(body[field], o)
    else if (type === 'enum') {
      const v = body[field] ?? o.def
      if (!o.values.includes(v)) fail(400, `${field} must be one of: ${o.values.join(', ')}`)
      out[field] = v
    }
  }
  return out
}

// ---- Naming -----------------------------------------------------------------

export const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'item'

// No lookalike characters (0/O, 1/I/L), so staff can read it out at the counter.
const TICKET_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const newTicket = (date = new Date()) => {
  const d = `${String(date.getDate()).padStart(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}`
  const bytes = randomBytes(4)
  return `TKT-${d}-${[...bytes].map((b) => TICKET_CHARS[b % TICKET_CHARS.length]).join('')}`
}
export const newToken = () => randomBytes(18).toString('base64url')

// ---- Settings ---------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  name: 'UTSAV Cafe & Restaurant',
  shortName: 'UTSAV',
  tagline: 'Good Food • Great Mood • Together Always',
  phone: '',
  email: '',
  address: '',
  landmark: '',
  days: 'Monday – Sunday (All 7 Days)',
  openTime: '11:30',
  closeTime: '22:30',
  services: 'Continuous Dine-in & Takeaway',
  googleRating: 4.6,
  googleReviews: 0,
  mapLink: '',
  mapEmbed: '',
  social: { facebook: '', instagram: '', youtube: '', google: '' },
  logo: '/uploads/seed/brand/logo.png',
  logoWord: '/uploads/seed/brand/logo-word.png',
  logoIcon: '/uploads/seed/brand/logo-cup.png',
  logoSplash: '/uploads/seed/brand/logo-splash.png',
  heroBackground: '/uploads/seed/hero/cafe-bg.webp',
  gstRate: 5,
  deliveryFee: 30,
  freeDeliveryAbove: 499,
  deliveryEnabled: true,
  onlineOrdering: true,
  gstin: '',
  fssai: '',
  invoicePrefix: 'INV',
  invoiceFooter: 'Thank you for dining with us! Visit again.',
}

export const getSettings = async () => {
  const { _id, ...stored } = (await col('settings').findOne({ _id: 'site' })) ?? {}
  return { ...DEFAULT_SETTINGS, ...stored, social: { ...DEFAULT_SETTINGS.social, ...stored.social } }
}

export const saveSettings = async (patch) => {
  const known = Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULT_SETTINGS))
  await col('settings').updateOne({ _id: 'site' }, { $set: known }, { upsert: true })
  return getSettings()
}
