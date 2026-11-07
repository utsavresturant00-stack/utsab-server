import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { config } from '../config.js'
import { col, isDuplicate, nextId } from '../db.js'
import { broadcast, subscribe } from '../events.js'
import { billTotals, cancelOrder, cleanLines, createOrder, findOrder, MODES, present, presentMany, priceOrder, setStep, updateOrder } from '../orders.js'
import { allow, fail, getSettings, getWaiterPermissions, pick, route, saveWaiterPermissions } from '../util.js'

const r = Router()
const staff = requireAuth('admin', 'waiter')
const admin = requireAuth('admin')

// ---- Live updates -----------------------------------------------------------

// EventSource cannot send headers, so the token comes in the query string.
r.get('/events', (req, res, next) => {
  req.headers.authorization = `Bearer ${req.query.token ?? ''}`
  staff(req, res, (err) => (err ? next(err) : subscribe(req, res)))
})

// ---- Waiter panel permissions ---------------------------------------------------

r.get('/waiter/permissions', staff, route(async (_req, res) => res.json(await getWaiterPermissions())))

r.put(
  '/waiter/permissions',
  admin,
  route(async (req, res) => {
    const out = await saveWaiterPermissions(req.body)
    broadcast('permissions', out)
    res.json(out)
  }),
)

// ---- Orders -----------------------------------------------------------------

const STAGES = {
  live: { cancelled: false, step: { $lt: 3 } },
  new: { cancelled: false, step: 0 },
  preparing: { cancelled: false, step: 1 },
  ready: { cancelled: false, step: 2 },
  done: { cancelled: false, step: 3 },
  cancelled: { cancelled: true },
  unpaid: { cancelled: false, paid: false },
  all: {},
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

r.get(
  '/orders',
  staff,
  route(async (req, res) => {
    const filter = { ...(STAGES[req.query.status] ?? STAGES.all) }
    if (MODES.includes(req.query.mode)) filter.mode = req.query.mode
    if (req.query.tableId) filter.tableId = Number(req.query.tableId)
    if (req.query.from || req.query.to) {
      filter.createdAt = {}
      if (req.query.from) filter.createdAt.$gte = Number(req.query.from)
      if (req.query.to) filter.createdAt.$lt = Number(req.query.to)
    }
    const q = String(req.query.q ?? '').trim()
    if (q) {
      const re = new RegExp(escape(q), 'i')
      filter.$or = [{ code: re }, { ticket: re }, { name: re }, { phone: re }, { tableNo: q }]
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const offset = Number(req.query.offset) || 0
    // The kitchen reads live orders oldest first; history reads newest first.
    const dir = ['live', 'new', 'preparing', 'ready'].includes(req.query.status) ? 1 : -1
    const [rows, total] = await Promise.all([
      col('orders').find(filter, { projection: { _id: 0 } }).sort({ createdAt: dir }).skip(offset).limit(limit).toArray(),
      col('orders').countDocuments(filter),
    ])
    res.json({ orders: await presentMany(rows, { staff: true }), total })
  }),
)

r.get(
  '/orders/counts',
  staff,
  route(async (_req, res) => {
    const entries = await Promise.all(Object.entries(STAGES).map(async ([k, f]) => [k, await col('orders').countDocuments(f)]))
    res.json(Object.fromEntries(entries))
  }),
)

r.get(
  '/orders/:id',
  staff,
  route(async (req, res) => res.json(await present((await findOrder(req.params.id)) ?? fail(404, 'Order not found'), { staff: true }))),
)

// Orders taken by a waiter at a table, or at the counter.
r.post(
  '/orders',
  staff,
  route(async (req, res) => {
    const body = pick(req.body, {
      mode: ['enum', { values: MODES, def: 'Dine-in' }],
      tableId: ['int', { min: 1 }],
      name: ['str', { max: 80 }],
      phone: ['str', { max: 15 }],
      address: ['str', { max: 300 }],
      note: ['str', { max: 300 }],
      payment: ['enum', { values: ['Cash', 'UPI', 'Card', 'Pay at Counter'], def: 'Pay at Counter' }],
      coupon: ['str', { max: 30 }],
    })
    if (req.user.role === 'waiter') {
      const can = await getWaiterPermissions()
      if (body.mode === 'Dine-in' && !can.takeDineIn) fail(403, 'The admin has turned off table orders for waiters')
      if (body.mode !== 'Dine-in' && !can.takeTakeaway) fail(403, 'The admin has turned off takeaway orders for waiters')
    }
    let table = null
    if (body.mode === 'Dine-in') table = (await col('tables').findOne({ id: body.tableId, active: true })) ?? fail(400, 'Choose a table')
    if (table?.reserved) fail(409, `Table ${table.number} is reserved. Release the reservation when the guests arrive, then take the order.`)
    const priced = await priceOrder({ lines: req.body.lines, mode: body.mode, coupon: body.coupon || null, phone: body.phone })
    const order = await createOrder({
      ...body,
      ...priced,
      name: body.name || (table ? `Table ${table.number}` : 'Walk-in'),
      source: req.user.role === 'waiter' ? 'waiter' : 'counter',
      tableId: table?.id ?? null,
      tableNo: table?.number ?? null,
      waiterId: req.user.id,
    })
    res.status(201).json(await present(order, { staff: true }))
  }),
)

r.patch(
  '/orders/:id/step',
  staff,
  route(async (req, res) => {
    const row = (await findOrder(req.params.id)) ?? fail(404, 'Order not found')
    const step = Number(req.body.step)
    // Without kitchen access a waiter can still mark food served once it is ready.
    if (req.user.role === 'waiter' && !(step === 3 && row.step === 2) && !(await getWaiterPermissions()).kitchenSteps) fail(403, 'The admin has turned off kitchen steps for waiters')
    res.json(await present(await setStep(row, step), { staff: true }))
  }),
)

r.post(
  '/orders/:id/cancel',
  admin,
  route(async (req, res) => {
    const row = (await findOrder(req.params.id)) ?? fail(404, 'Order not found')
    res.json(await present(await cancelOrder(row), { staff: true }))
  }),
)

r.patch(
  '/orders/:id/payment',
  staff,
  allow('markPaid'),
  route(async (req, res) => {
    const row = (await findOrder(req.params.id)) ?? fail(404, 'Order not found')
    if (row.cancelled) fail(409, 'This order is cancelled')
    const { paid, payment } = pick(req.body, { paid: ['bool', { def: true }], payment: ['str', { max: 30, def: row.payment }] })
    res.json(await present(await updateOrder(row, { paid, paidAt: paid ? Date.now() : null, payment }), { staff: true }))
  }),
)

// ---- Invoices ---------------------------------------------------------------

const presentInvoice = (inv) =>
  inv && {
    id: inv.id,
    number: inv.number,
    createdAt: inv.createdAt,
    revision: inv.revision ?? 0,
    updatedAt: inv.updatedAt ?? null,
    updatedBy: inv.updatedBy ?? null,
    customerGstin: '',
    notes: '',
    ...inv.data,
  }

/** Gives an order its invoice, numbered per prefix and year. Returns the existing one if it has one. */
const makeInvoice = async (row, user, extra = {}) => {
  const existing = await col('invoices').findOne({ orderId: row.id })
  if (existing) return { inv: existing, created: false }
  const s = await getSettings()
  const prefix = `${s.invoicePrefix || 'INV'}-${new Date().getFullYear()}-`
  const data = {
    business: { name: s.name, address: s.address, phone: s.phone, email: s.email, gstin: s.gstin, fssai: s.fssai, logo: s.logo },
    gstRate: extra.gstRate ?? s.gstRate,
    footer: s.invoiceFooter,
    issuedBy: user.name,
    customerGstin: extra.customerGstin ?? '',
    notes: extra.notes ?? '',
    order: await present(row, { staff: true }),
  }
  // A clash from two people at once just takes the next number.
  for (let attempt = 0; attempt < 5; attempt++) {
    const n = await nextId(`invoice:${prefix}`)
    const inv = { id: await nextId('invoices'), number: `${prefix}${String(n).padStart(4, '0')}`, orderId: row.id, data, revision: 0, createdBy: user.id, createdAt: Date.now() }
    try {
      await col('invoices').insertOne(inv)
      broadcast('order', { type: 'updated', order: await present(row, { staff: true }) })
      return { inv, created: true }
    } catch (e) {
      if (!isDuplicate(e)) throw e
      const made = await col('invoices').findOne({ orderId: row.id })
      if (made) return { inv: made, created: false }
    }
  }
  fail(409, 'Could not number the invoice, please try again')
}

/** Payment can change after the invoice is made, so it is read fresh from the order. */
const withPayment = async (inv) => {
  const out = presentInvoice(inv)
  const o = await col('orders').findOne({ id: inv.orderId }, { projection: { paid: 1, paidAt: 1, payment: 1 } })
  if (o) out.order = { ...out.order, paid: !!o.paid, paidAt: o.paidAt, payment: o.payment }
  return out
}

const billFields = {
  name: ['str', { max: 80 }],
  phone: ['str', { max: 15 }],
  address: ['str', { max: 300 }],
  customerGstin: ['str', { max: 20 }],
  notes: ['str', { max: 400 }],
  payment: ['str', { max: 30, def: 'Cash' }],
  paid: ['bool'],
  discount: ['num', { min: 0, max: 1_000_000 }],
  delivery: ['num', { min: 0, max: 100_000 }],
  gstRate: ['num', { min: 0, max: 28 }],
}

/** Makes the invoice for an order, or returns the one already made. */
r.post(
  '/orders/:id/invoice',
  staff,
  allow('createInvoice'),
  route(async (req, res) => {
    const row = (await findOrder(req.params.id)) ?? fail(404, 'Order not found')
    if (row.cancelled) fail(409, 'A cancelled order cannot be invoiced')
    const { inv, created } = await makeInvoice(row, req.user)
    res.status(created ? 201 : 200).json(await withPayment(inv))
  }),
)

/** A new bill typed in by hand (counter sale, phone order, catering): saved as a finished order with its invoice. */
r.post(
  '/invoices',
  staff,
  allow('createInvoice'),
  route(async (req, res) => {
    const b = pick(req.body, { ...billFields, mode: ['enum', { values: MODES, def: 'Takeaway' }], tableId: ['int', { min: 1 }] })
    const s = await getSettings()
    const lines = cleanLines(req.body.lines)
    const t = billTotals(lines, { discount: b.discount, delivery: b.delivery, gstRate: req.body.gstRate === undefined || req.body.gstRate === '' ? s.gstRate : b.gstRate })
    const table = b.mode === 'Dine-in' && b.tableId ? await col('tables').findOne({ id: b.tableId }) : null
    const row = await createOrder(
      {
        mode: b.mode,
        name: b.name || 'Walk-in',
        phone: b.phone,
        address: b.address,
        note: '',
        payment: b.payment || 'Cash',
        coupon: null,
        lines,
        subtotal: t.subtotal,
        discount: t.discount,
        gst: t.gst,
        delivery: t.delivery,
        total: t.total,
        paid: b.paid,
        source: req.user.role === 'waiter' ? 'waiter' : 'counter',
        tableId: table?.id ?? null,
        tableNo: table?.number ?? null,
        waiterId: req.user.id,
      },
      { done: true },
    )
    const { inv } = await makeInvoice(row, req.user, { gstRate: t.gstRate, customerGstin: b.customerGstin, notes: b.notes })
    res.status(201).json(await withPayment(inv))
  }),
)

/** Edits a saved invoice. The order behind it is updated too, so reports match the bill. */
r.put(
  '/invoices/:id',
  staff,
  allow('editInvoice'),
  route(async (req, res) => {
    const inv = (await col('invoices').findOne({ id: Number(req.params.id) })) ?? fail(404, 'Invoice not found')
    const o = inv.data.order
    const b = pick(req.body, billFields, { partial: true })
    const lines = req.body.lines === undefined ? o.lines : cleanLines(req.body.lines)
    const t = billTotals(lines, { discount: b.discount ?? o.discount, delivery: b.delivery ?? o.delivery, gstRate: b.gstRate ?? inv.data.gstRate })
    const row = await col('orders').findOne({ id: inv.orderId }, { projection: { _id: 0 } })
    const wasPaid = row ? !!row.paid : !!o.paid
    const paid = b.paid ?? wasPaid
    const now = Date.now()
    const paidAt = paid ? (row?.paidAt ?? o.paidAt ?? now) : null
    const order = {
      ...o,
      name: b.name ?? o.name,
      phone: b.phone ?? o.phone,
      address: b.address ?? o.address,
      payment: b.payment ?? row?.payment ?? o.payment,
      paid,
      paidAt,
      lines,
      subtotal: t.subtotal,
      discount: t.discount,
      gst: t.gst,
      delivery: t.delivery,
      total: t.total,
    }
    const next = await col('invoices').findOneAndUpdate(
      { id: inv.id },
      {
        $set: {
          'data.order': order,
          'data.gstRate': t.gstRate,
          'data.customerGstin': b.customerGstin ?? inv.data.customerGstin ?? '',
          'data.notes': b.notes ?? inv.data.notes ?? '',
          updatedAt: now,
          updatedBy: req.user.name,
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after' },
    )
    if (row) {
      await updateOrder(row, {
        name: order.name,
        phone: order.phone,
        address: order.address,
        payment: order.payment,
        paid,
        paidAt,
        lines,
        subtotal: t.subtotal,
        discount: t.discount,
        gst: t.gst,
        delivery: t.delivery,
        total: t.total,
      })
    }
    res.json(await withPayment(next))
  }),
)

r.get(
  '/invoices',
  staff,
  allow('viewInvoices'),
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim()
    const re = new RegExp(escape(q), 'i')
    const filter = q ? { $or: [{ number: re }, { 'data.order.id': re }, { 'data.order.name': re }, { 'data.order.phone': re }] } : {}
    const invs = await col('invoices').find(filter).sort({ id: -1 }).limit(300).toArray()
    const orders = new Map((await col('orders').find({ id: { $in: invs.map((i) => i.orderId) } }, { projection: { id: 1, paid: 1, total: 1 } }).toArray()).map((o) => [o.id, o]))
    res.json(
      invs.map((i) => ({
        id: i.id,
        number: i.number,
        createdAt: i.createdAt,
        orderId: i.data.order.id,
        name: i.data.order.name,
        phone: i.data.order.phone,
        total: orders.get(i.orderId)?.total ?? i.data.order.total,
        mode: i.data.order.mode,
        paid: !!orders.get(i.orderId)?.paid,
        revision: i.revision ?? 0,
        updatedAt: i.updatedAt ?? null,
      })),
    )
  }),
)

r.get(
  '/invoices/:id',
  staff,
  route(async (req, res) => {
    const inv = (await col('invoices').findOne({ $or: [{ id: Number(req.params.id) }, { number: req.params.id }] })) ?? fail(404, 'Invoice not found')
    res.json(await withPayment(inv))
  }),
)

// ---- Tables with what is happening at each ----------------------------------

const openAt = (since) => ({ cancelled: false, createdAt: { $gt: since }, $or: [{ step: { $lt: 3 } }, { paid: false }] })

r.get(
  '/tables/live',
  staff,
  route(async (_req, res) => {
    const since = Date.now() - 16 * 3600_000
    const [tables, open] = await Promise.all([
      col('tables').find({ active: true }, { projection: { _id: 0 } }).sort({ sort: 1, id: 1 }).toArray(),
      col('orders').find({ ...openAt(since), tableId: { $ne: null } }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray(),
    ])
    const shown = await presentMany(open, { staff: true })
    res.json(
      tables.map((t) => {
        const orders = shown.filter((o) => o.tableId === t.id)
        return { ...t, orders, total: orders.reduce((s, o) => s + o.total, 0), since: orders[0]?.createdAt ?? null, ready: orders.filter((o) => o.step === 2).length }
      }),
    )
  }),
)

// Reserve a table (no orders can be placed on it) or release it when the guests arrive.
r.post(
  '/tables/:id/reservation',
  staff,
  allow('reserveTables'),
  route(async (req, res) => {
    const { reserved, reservedFor } = pick(req.body, { reserved: ['bool'], reservedFor: ['str', { max: 80 }] })
    const t = await col('tables').findOneAndUpdate(
      { id: Number(req.params.id) },
      { $set: { reserved, reservedFor: reserved ? reservedFor : '' } },
      { returnDocument: 'after', projection: { _id: 0 } },
    )
    if (!t) fail(404, 'Table not found')
    broadcast('tables', { at: Date.now() })
    res.json(t)
  }),
)

// Marks everything at the table served and paid, freeing it for the next guests.
r.post(
  '/tables/:id/settle',
  staff,
  allow('settleTable'),
  route(async (req, res) => {
    const { payment } = pick(req.body, { payment: ['str', { max: 30, def: 'Cash' }] })
    const orders = await col('orders').find({ ...openAt(Date.now() - 16 * 3600_000), tableId: Number(req.params.id) }, { projection: { _id: 0 } }).toArray()
    const now = Date.now()
    for (const o of orders) {
      const stepAt = [...o.stepAt]
      if (o.step < 3) stepAt[3] = now
      await updateOrder(o, { step: 3, stepAt, paid: true, paidAt: o.paid ? o.paidAt : now, payment: o.paid ? o.payment : payment })
    }
    res.json({ settled: orders.length })
  }),
)

// ---- Reports ----------------------------------------------------------------

// Formatters are slow to create, so make them once.
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone })
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: 'numeric', hour12: false })
const dayKey = (ms) => dayFmt.format(ms)
const hourOf = (ms) => Number(hourFmt.format(ms)) % 24

r.get(
  '/reports/dashboard',
  admin,
  route(async (_req, res) => {
    const now = Date.now()
    const rows = await col('orders')
      .find({ createdAt: { $gte: now - 400 * 86_400_000 } }, { projection: { _id: 0, id: 1, mode: 1, source: 1, payment: 1, total: 1, createdAt: 1, cancelled: 1, phone: 1, lines: 1 } })
      .toArray()
    for (const o of rows) o.day = dayKey(o.createdAt)
    const valid = rows.filter((o) => !o.cancelled)
    const byDay = new Map()
    for (const o of valid) byDay.set(o.day, [...(byDay.get(o.day) ?? []), o])
    const sum = (list) => list.reduce((s, o) => s + o.total, 0)
    const onDay = (key) => byDay.get(key) ?? []
    const today = dayKey(now)
    const yesterday = dayKey(now - 86_400_000)

    const days = Array.from({ length: 30 }, (_, i) => {
      const key = dayKey(now - (29 - i) * 86_400_000)
      const list = onDay(key)
      return { date: key, revenue: sum(list), orders: list.length }
    })

    const [y, m] = today.split('-').map(Number)
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1 - (11 - i), 1))
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      const list = valid.filter((o) => o.day.startsWith(key))
      return { month: key, revenue: sum(list), orders: list.length }
    })

    const last30 = valid.filter((o) => now - o.createdAt < 30 * 86_400_000)
    const menu = new Map((await col('menu').find({}, { projection: { id: 1, category: 1 } }).toArray()).map((x) => [x.id, x.category]))
    const items = new Map()
    const cats = new Map()
    for (const o of last30) {
      for (const l of o.lines) {
        const it = items.get(l.itemId) ?? { id: l.itemId, name: l.name, image: l.image, qty: 0, revenue: 0 }
        it.qty += l.qty
        it.revenue += l.qty * l.price
        items.set(l.itemId, it)
        const name = menu.get(l.itemId) ?? 'Other'
        const c = cats.get(name) ?? { name, revenue: 0, qty: 0 }
        c.qty += l.qty
        c.revenue += l.qty * l.price
        cats.set(name, c)
      }
    }

    const group = (list, key) => {
      const map = new Map()
      for (const o of list) {
        const k = key(o)
        const g = map.get(k) ?? { key: k, orders: 0, revenue: 0 }
        g.orders += 1
        g.revenue += o.total
        map.set(k, g)
      }
      return [...map.values()]
    }

    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }))
    for (const o of last30) {
      const h = hours[hourOf(o.createdAt)]
      h.orders += 1
      h.revenue += o.total
    }

    const [live, waiting, unpaid] = await Promise.all(['live', 'new', 'unpaid'].map((k) => col('orders').countDocuments(STAGES[k])))
    res.json({
      today: { revenue: sum(onDay(today)), orders: onDay(today).length },
      yesterday: { revenue: sum(onDay(yesterday)), orders: onDay(yesterday).length },
      month: { revenue: months[11].revenue, orders: months[11].orders },
      prevMonth: { revenue: months[10].revenue, orders: months[10].orders, month: months[10].month },
      avgOrder30: last30.length ? Math.round(sum(last30) / last30.length) : 0,
      live,
      waiting,
      unpaid,
      cancelled30: rows.filter((o) => o.cancelled && now - o.createdAt < 30 * 86_400_000).length,
      customers30: new Set(last30.filter((o) => o.phone).map((o) => o.phone)).size,
      days,
      months,
      hours,
      byMode: MODES.map((mode) => {
        const list = last30.filter((o) => o.mode === mode)
        return { mode, orders: list.length, revenue: sum(list) }
      }).sort((a, b) => b.orders - a.orders),
      bySource: group(last30, (o) => o.source),
      byPayment: group(last30, (o) => o.payment),
      top: [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 8),
      categories: [...cats.values()].sort((a, b) => b.revenue - a.revenue),
    })
  }),
)

r.get(
  '/reports/customers',
  admin,
  route(async (_req, res) => {
    const rows = await col('orders')
      .aggregate([
        { $match: { phone: { $ne: '' } } },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: '$phone',
            name: { $last: '$name' },
            orders: { $sum: 1 },
            spent: { $sum: { $cond: ['$cancelled', 0, '$total'] } },
            last: { $max: '$createdAt' },
            first: { $min: '$createdAt' },
            modes: { $addToSet: '$mode' },
          },
        },
        { $sort: { spent: -1 } },
      ])
      .toArray()
    res.json(rows.map(({ _id, ...c }) => ({ phone: _id, ...c })))
  }),
)

// Each staff member's orders and sales: today and the last 30 days.
r.get(
  '/reports/staff',
  admin,
  route(async (_req, res) => {
    const now = Date.now()
    const today = dayKey(now)
    const rows = await col('orders')
      .find({ waiterId: { $ne: null }, cancelled: false, createdAt: { $gte: now - 30 * 86_400_000 } }, { projection: { _id: 0, waiterId: 1, total: 1, createdAt: 1 } })
      .toArray()
    const out = {}
    for (const o of rows) {
      const s = (out[o.waiterId] ??= { today: { orders: 0, sales: 0 }, month: { orders: 0, sales: 0 }, last: 0 })
      s.month.orders += 1
      s.month.sales += o.total
      if (dayKey(o.createdAt) === today) {
        s.today.orders += 1
        s.today.sales += o.total
      }
      s.last = Math.max(s.last, o.createdAt)
    }
    res.json(out)
  }),
)

export default r
