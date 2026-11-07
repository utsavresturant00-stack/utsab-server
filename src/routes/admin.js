import bcrypt from 'bcryptjs'
import { Router } from 'express'
import multer from 'multer'
import { publicUser, requireAuth } from '../auth.js'
import { crud } from '../crud.js'
import { clean, col, nextId } from '../db.js'
import { broadcast } from '../events.js'
import { IMAGE_TYPES, newImageName, saveImage } from '../media.js'
import { DEFAULT_SETTINGS, fail, getSettings, pick, route, saveSettings, slugify } from '../util.js'

const r = Router()
const admin = requireAuth('admin')
const staff = requireAuth('admin', 'waiter')

// Lets open panels know the website content changed.
const contentChanged = () => broadcast('content', { at: Date.now() })

// ---- Settings ---------------------------------------------------------------

r.get('/settings', staff, route(async (_req, res) => res.json(await getSettings())))

r.put(
  '/settings',
  admin,
  route(async (req, res) => {
    const patch = {}
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in req.body)) continue
      const v = req.body[k]
      if (typeof def === 'number') {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) fail(400, `${k} must be a number`)
        patch[k] = n
      } else if (typeof def === 'boolean') patch[k] = !!v
      else if (typeof def === 'object') {
        if (typeof v !== 'object' || !v) fail(400, `${k} must be an object`)
        patch[k] = Object.fromEntries(Object.keys(def).map((sk) => [sk, String(v[sk] ?? '').slice(0, 500)]))
      } else patch[k] = String(v ?? '').slice(0, 2000)
    }
    for (const t of ['openTime', 'closeTime']) if (patch[t] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch[t])) fail(400, `${t} must look like 11:30`)
    const out = await saveSettings(patch)
    contentChanged()
    res.json(out)
  }),
)

// ---- Uploads: images go straight into MongoDB (GridFS) ----------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(IMAGE_TYPES[file.mimetype] ? null : Object.assign(new Error('Upload a JPG, PNG, WebP, GIF or AVIF image'), { status: 400 }), !!IMAGE_TYPES[file.mimetype]),
})

r.post(
  '/uploads',
  admin,
  upload.single('file'),
  route(async (req, res) => {
    if (!req.file) fail(400, 'Choose an image to upload')
    const folder = /^[a-z-]{1,20}$/.test(req.query.folder ?? '') ? req.query.folder : 'misc'
    res.status(201).json({ url: await saveImage(newImageName(folder, req.file.mimetype), req.file.buffer, req.file.mimetype) })
  }),
)

// ---- Menu -------------------------------------------------------------------

const itemFields = {
  name: ['str', { required: true, max: 100 }],
  category: ['str', { required: true, max: 60 }],
  price: ['int', { required: true, min: 0, max: 100000 }],
  image: ['str', { max: 300 }],
  description: ['str', { max: 600 }],
  isVeg: ['bool'],
  rating: ['num', { min: 0, max: 5, def: 4.5 }],
  prepTime: ['str', { max: 20, def: '15 min' }],
  isPopular: ['bool'],
  isNew: ['bool'],
  spicy: ['int', { min: 0, max: 3 }],
  available: ['bool', { def: true }],
}

const uniqueSlug = async (name) => {
  const base = slugify(name)
  let id = base
  for (let n = 2; await col('menu').findOne({ id }, { projection: { _id: 1 } }); n++) id = `${base}-${n}`
  return id
}

r.use('/menu', admin, crud({ collection: 'menu', fields: itemFields, sort: { sort: 1, name: 1 }, makeKey: (body) => uniqueSlug(String(body.name)), onChange: contentChanged }))

// Renaming a category moves its dishes along; a category with dishes cannot be deleted.
r.put(
  '/categories/:id',
  admin,
  route(async (req, _res, next) => {
    const cat = (await col('categories').findOne({ id: Number(req.params.id) })) ?? fail(404, 'Not found')
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    if (name && name !== cat.name) {
      if (await col('categories').findOne({ name, id: { $ne: cat.id } })) fail(409, 'That category already exists')
      await col('menu').updateMany({ category: cat.name }, { $set: { category: name } })
    }
    next()
  }),
)
r.delete(
  '/categories/:id',
  admin,
  route(async (req, _res, next) => {
    const cat = (await col('categories').findOne({ id: Number(req.params.id) })) ?? fail(404, 'Not found')
    const n = await col('menu').countDocuments({ category: cat.name })
    if (n) fail(409, `Move or delete the ${n} dishes in ${cat.name} first`)
    next()
  }),
)
r.use(
  '/categories',
  admin,
  crud({ collection: 'categories', fields: { name: ['str', { required: true, max: 60 }], image: ['str', { max: 300 }], active: ['bool', { def: true }], home: ['bool', { def: true }] }, onChange: contentChanged }),
)

// ---- Website content ----------------------------------------------------------

r.use(
  '/offers',
  admin,
  crud({
    collection: 'offers',
    key: 'code',
    sort: { sort: 1, code: 1 },
    makeKey: (body) => {
      const code = String(body.code ?? '').trim().toUpperCase()
      if (!/^[A-Z0-9]{3,20}$/.test(code)) fail(400, 'Code must be 3-20 letters or numbers')
      return code
    },
    fields: {
      title: ['str', { required: true, max: 60 }],
      description: ['str', { max: 300 }],
      type: ['enum', { values: ['percent', 'flat', 'delivery'], def: 'percent' }],
      value: ['int', { min: 0, max: 100000 }],
      minOrder: ['int', { min: 0, max: 100000 }],
      maxDiscount: ['int', { min: 0, max: 100000 }],
      firstOrderOnly: ['bool'],
      validFrom: ['date'],
      validTo: ['date'],
      featured: ['bool', { def: true }],
      terms: ['str', { max: 300 }],
      active: ['bool', { def: true }],
    },
    onChange: contentChanged,
  }),
)

r.use(
  '/gallery',
  admin,
  crud({
    collection: 'gallery',
    fields: { src: ['str', { required: true, max: 300 }], title: ['str', { max: 100 }], category: ['str', { max: 40 }], width: ['int', { min: 1, def: 800 }], height: ['int', { min: 1, def: 600 }] },
    onChange: contentChanged,
  }),
)

r.use(
  '/slides',
  admin,
  crud({
    collection: 'slides',
    fields: { image: ['str', { required: true, max: 300 }], alt: ['str', { max: 140 }], steam: ['bool'], cutout: ['bool'], active: ['bool', { def: true }] },
    onChange: contentChanged,
  }),
)

r.use(
  '/testimonials',
  admin,
  crud({
    collection: 'testimonials',
    fields: { name: ['str', { required: true, max: 80 }], rating: ['int', { min: 1, max: 5, def: 5 }], quote: ['str', { required: true, max: 800 }], active: ['bool', { def: true }] },
    onChange: contentChanged,
  }),
)

r.use(
  '/notifications',
  admin,
  (req, _res, next) => {
    if (req.method === 'POST') req.body.createdAt = Date.now()
    next()
  },
  crud({
    collection: 'notifications',
    sort: { createdAt: -1 },
    fields: { title: ['str', { required: true, max: 100 }], body: ['str', { max: 400 }], active: ['bool', { def: true }], createdAt: ['int', { def: Date.now() }] },
    onChange: contentChanged,
  }),
)

// ---- Tables -----------------------------------------------------------------

r.get(
  '/tables',
  staff,
  route(async (_req, res) => res.json(await col('tables').find({}, { projection: { _id: 0 } }).sort({ sort: 1, id: 1 }).toArray())),
)
r.use(
  '/tables',
  admin,
  crud({
    collection: 'tables',
    fields: {
      number: ['str', { required: true, max: 10 }],
      name: ['str', { max: 60 }],
      capacity: ['int', { min: 1, max: 50, def: 4 }],
      area: ['str', { max: 40, def: 'Main Hall' }],
      active: ['bool', { def: true }],
      reserved: ['bool'],
      reservedFor: ['str', { max: 80 }],
    },
    onChange: () => broadcast('tables', { at: Date.now() }),
  }),
)

// ---- Staff accounts -----------------------------------------------------------

r.get(
  '/users',
  admin,
  route(async (_req, res) => res.json((await col('users').find().sort({ role: 1, name: 1 }).toArray()).map(publicUser))),
)

r.post(
  '/users',
  admin,
  route(async (req, res) => {
    const u = pick(req.body, {
      name: ['str', { required: true, max: 60 }],
      username: ['str', { required: true, max: 40 }],
      password: ['str', { required: true, max: 200 }],
      role: ['enum', { values: ['admin', 'waiter'], def: 'waiter' }],
    })
    if (!/^[a-z0-9._-]{3,40}$/i.test(u.username)) fail(400, 'Username: 3-40 letters, numbers, dot, dash or underscore')
    if (u.password.length < 6) fail(400, 'Password needs at least 6 characters')
    if (await col('users').findOne({ usernameLower: u.username.toLowerCase() })) fail(409, 'That username is taken')
    const user = { id: await nextId('users'), name: u.name, username: u.username, usernameLower: u.username.toLowerCase(), passwordHash: await bcrypt.hash(u.password, 10), role: u.role, active: true, createdAt: Date.now() }
    await col('users').insertOne(user)
    res.status(201).json(publicUser(user))
  }),
)

const otherAdmins = (id) => col('users').countDocuments({ role: 'admin', active: true, id: { $ne: id } })

r.put(
  '/users/:id',
  admin,
  route(async (req, res) => {
    const user = (await col('users').findOne({ id: Number(req.params.id) })) ?? fail(404, 'Not found')
    const u = pick(req.body, { name: ['str', { max: 60 }], role: ['enum', { values: ['admin', 'waiter'], def: user.role }], active: ['bool', { def: !!user.active }], password: ['str', { max: 200 }] })
    if (user.role === 'admin' && (u.role !== 'admin' || !u.active) && !(await otherAdmins(user.id))) fail(409, 'Keep at least one active admin')
    if (u.password && u.password.length < 6) fail(400, 'Password needs at least 6 characters')
    const set = { name: u.name || user.name, role: u.role, active: u.active }
    if (u.password) set.passwordHash = await bcrypt.hash(u.password, 10)
    const next = await col('users').findOneAndUpdate({ id: user.id }, { $set: set }, { returnDocument: 'after' })
    res.json(publicUser(clean(next)))
  }),
)

r.delete(
  '/users/:id',
  admin,
  route(async (req, res) => {
    const user = (await col('users').findOne({ id: Number(req.params.id) })) ?? fail(404, 'Not found')
    if (user.id === req.user.id) fail(409, "You can't delete your own account")
    if (user.role === 'admin' && !(await otherAdmins(user.id))) fail(409, 'Keep at least one active admin')
    await col('users').deleteOne({ id: user.id })
    res.json({ ok: true })
  }),
)

export default r
