import { Router } from 'express'
import { col } from '../db.js'
import { cancelOrder, createOrder, findOrder, MODES, present, presentMany, priceOrder } from '../orders.js'
import { fail, getSettings, pick, route } from '../util.js'

const r = Router()
const list = (name, filter = {}, sort = { sort: 1, id: 1 }, projection = {}) => col(name).find(filter, { projection: { _id: 0, ...projection } }).sort(sort).toArray()

/** Everything the website shows, in one request. */
export const siteContent = async () => {
  const [settings, categories, menu, offers, gallery, slides, testimonials, notifications] = await Promise.all([
    getSettings(),
    list('categories', { active: true }, { sort: 1, id: 1 }, { id: 0, sort: 0, active: 0 }),
    list('menu', {}, { sort: 1, name: 1 }),
    list('offers', { active: true }, { sort: 1 }, { active: 0, sort: 0 }),
    list('gallery', {}, { sort: 1, id: 1 }, { id: 0, sort: 0 }),
    list('slides', { active: true }, { sort: 1, id: 1 }, { id: 0, sort: 0, active: 0 }),
    list('testimonials', { active: true }, { sort: 1, id: 1 }, { id: 0, sort: 0, active: 0 }),
    list('notifications', { active: true }, { createdAt: -1 }, { active: 0 }),
  ])
  return { settings, categories, menu, offers, gallery, slides, testimonials, notifications, updatedAt: Date.now() }
}

r.get(
  '/content',
  route(async (_req, res) => {
    res.set('Cache-Control', 'no-cache')
    res.json(await siteContent())
  }),
)

// Every table guests can pick at checkout, with whether it is free, in use or reserved.
r.get(
  '/tables',
  route(async (_req, res) => {
    const since = Date.now() - 16 * 3600_000
    const [tables, busy] = await Promise.all([
      col('tables').find({ active: true }, { projection: { _id: 0, id: 1, number: 1, name: 1, area: 1, capacity: 1, reserved: 1 } }).sort({ sort: 1, id: 1 }).toArray(),
      col('orders').distinct('tableId', { tableId: { $ne: null }, cancelled: false, createdAt: { $gt: since }, $or: [{ step: { $lt: 3 } }, { paid: false }] }),
    ])
    const inUse = new Set(busy)
    res.set('Cache-Control', 'no-store')
    res.json(tables.map(({ id, reserved, ...t }) => ({ ...t, status: reserved ? 'reserved' : inUse.has(id) ? 'occupied' : 'free' })))
  }),
)

// Used by the QR code on each table.
r.get(
  '/tables/:number',
  route(async (req, res) => {
    const t = await col('tables').findOne({ number: req.params.number, active: true }, { projection: { _id: 0, number: 1, name: 1, area: 1, reserved: 1 } })
    if (!t) fail(404, 'Table not found')
    res.json(t)
  }),
)

r.post(
  '/orders',
  route(async (req, res) => {
    const settings = await getSettings()
    if (!settings.onlineOrdering) fail(503, 'We are not taking online orders right now. Please call us.')
    const body = pick(req.body, {
      mode: ['enum', { values: MODES }],
      payment: ['enum', { values: ['Cash', 'UPI', 'Card', 'Cash on Delivery', 'Pay at Counter'], def: 'Cash' }],
      name: ['str', { required: true, max: 80 }],
      phone: ['str', { required: true, max: 15 }],
      address: ['str', { max: 300 }],
      tableNo: ['str', { max: 10 }],
      note: ['str', { max: 300 }],
      coupon: ['str', { max: 30 }],
    })
    if (!/^\+?\d[\d\s-]{8,14}$/.test(body.phone)) fail(400, 'Enter a valid phone number')
    if (body.mode === 'Delivery' && !settings.deliveryEnabled) fail(400, 'Delivery is not available right now')
    if (body.mode === 'Delivery' && body.address.length < 8) fail(400, 'Enter the full delivery address')
    if (body.mode === 'Dine-in' && !body.tableNo) fail(400, 'Enter your table number')

    const table = body.mode === 'Dine-in' ? await col('tables').findOne({ number: body.tableNo, active: true }) : null
    if (body.mode === 'Dine-in' && !table) fail(400, `Table ${body.tableNo} isn't set up. Please choose your table from the list.`)
    if (table?.reserved) fail(409, `Table ${table.number} is reserved. Please choose another table or ask our staff.`)
    const priced = await priceOrder({ lines: req.body.lines, mode: body.mode, coupon: body.coupon || null, phone: body.phone })

    const order = await createOrder({
      ...body,
      ...priced,
      source: 'online',
      address: body.mode === 'Delivery' ? body.address : '',
      tableId: table?.id ?? null,
      tableNo: body.mode === 'Dine-in' ? body.tableNo : null,
    })
    res.status(201).json({ ...(await present(order)), token: order.token })
  }),
)

const ownOrder = async (req) => {
  const row = await findOrder(req.params.id)
  if (!row || row.token !== String(req.query.token ?? req.body?.token ?? '')) fail(404, 'Order not found')
  return row
}

r.get(
  '/orders/:id',
  route(async (req, res) => res.json(await present(await ownOrder(req)))),
)

// Body: { orders: [{ id, token }] } - refreshes a customer's saved orders in one call.
r.post(
  '/orders/lookup',
  route(async (req, res) => {
    const wanted = Array.isArray(req.body.orders) ? req.body.orders.slice(0, 100) : []
    const tokens = new Map(wanted.map((o) => [String(o.id), String(o.token)]))
    const rows = await col('orders').find({ code: { $in: [...tokens.keys()] } }, { projection: { _id: 0 } }).toArray()
    res.json(await presentMany(rows.filter((o) => tokens.get(o.code) === o.token)))
  }),
)

r.post(
  '/orders/:id/cancel',
  route(async (req, res) => {
    const row = await ownOrder(req)
    if (row.step > 0) fail(409, 'The kitchen has already started this order. Please call us to change it.')
    res.json(await present(await cancelOrder(row)))
  }),
)

export default r
