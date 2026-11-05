import { clean, col, nextId } from './db.js'
import { broadcast } from './events.js'
import { fail, getSettings, newTicket, newToken } from './util.js'

export const MODES = ['Delivery', 'Takeaway', 'Dine-in']

export const stepsFor = (mode) =>
  mode === 'Delivery'
    ? ['Placed', 'Preparing', 'Out for Delivery', 'Delivered']
    : mode === 'Dine-in'
      ? ['Placed', 'Preparing', 'Serving to Table', 'Served']
      : ['Placed', 'Preparing', 'Ready to Collect', 'Completed']

const shape = (o, staff, waiters, invoices) => {
  const out = {
    id: o.code,
    ticket: o.ticket,
    source: o.source,
    mode: o.mode,
    tableId: o.tableId ?? null,
    tableNo: o.tableNo ?? null,
    name: o.name,
    phone: o.phone,
    address: o.address,
    note: o.note,
    payment: o.payment,
    coupon: o.coupon ?? null,
    subtotal: o.subtotal,
    discount: o.discount,
    gst: o.gst,
    delivery: o.delivery,
    total: o.total,
    step: o.step,
    stepAt: o.stepAt,
    status: o.cancelled ? 'Cancelled' : o.step === 0 ? 'Confirmed' : stepsFor(o.mode)[o.step],
    cancelled: !!o.cancelled,
    cancelledAt: o.cancelledAt ?? null,
    paid: !!o.paid,
    paidAt: o.paidAt ?? null,
    createdAt: o.createdAt,
    lines: o.lines,
  }
  if (staff) {
    out.waiter = o.waiterId ? (waiters.get(o.waiterId) ?? null) : null
    out.invoice = invoices.get(o.id) ?? null
  }
  return out
}

/** The JSON shape of many orders. `staff` adds who took each one and its invoice. */
export const presentMany = async (rows, { staff = false } = {}) => {
  if (!staff || !rows.length) return rows.map((o) => shape(o, false))
  const waiterIds = [...new Set(rows.map((o) => o.waiterId).filter(Boolean))]
  const [users, invs] = await Promise.all([
    waiterIds.length ? col('users').find({ id: { $in: waiterIds } }, { projection: { id: 1, name: 1 } }).toArray() : [],
    col('invoices').find({ orderId: { $in: rows.map((o) => o.id) } }, { projection: { id: 1, number: 1, orderId: 1 } }).toArray(),
  ])
  const waiters = new Map(users.map((u) => [u.id, { id: u.id, name: u.name }]))
  const invoices = new Map(invs.map((i) => [i.orderId, { id: i.id, number: i.number }]))
  return rows.map((o) => shape(o, true, waiters, invoices))
}

export const present = async (row, opts) => (row ? (await presentMany([row], opts))[0] : null)

export const findOrder = async (code) => clean(await col('orders').findOne({ code }))

/** Works out the bill from today's prices and rules, never from numbers the browser sent. */
export const priceOrder = async ({ lines, mode, coupon, phone }) => {
  const settings = await getSettings()
  if (!Array.isArray(lines) || lines.length === 0) fail(400, 'Add at least one dish')
  if (lines.length > 60) fail(400, 'Too many different dishes in one order')

  const merged = new Map()
  for (const l of lines) {
    const qty = Number(l?.qty)
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) fail(400, 'Each dish needs a quantity from 1 to 50')
    const note = String(l.note ?? '').trim().slice(0, 140)
    const key = `${l.id}|${note}`
    merged.set(key, { id: String(l.id), qty: (merged.get(key)?.qty ?? 0) + qty, note })
  }

  const ids = [...new Set([...merged.values()].map((l) => l.id))]
  const items = new Map((await col('menu').find({ id: { $in: ids } }).toArray()).map((m) => [m.id, m]))
  const priced = [...merged.values()].map((l) => {
    const item = items.get(l.id)
    if (!item) fail(400, 'A dish in this order is no longer on the menu')
    if (!item.available) fail(409, `${item.name} is sold out right now`)
    return { itemId: item.id, name: item.name, image: item.image, isVeg: !!item.isVeg, price: item.price, qty: l.qty, note: l.note }
  })

  const subtotal = priced.reduce((s, l) => s + l.price * l.qty, 0)

  let offer = null
  if (coupon) {
    offer = await col('offers').findOne({ code: String(coupon).trim().toUpperCase(), active: true })
    if (!offer) fail(400, 'This coupon is not available')
    if (subtotal < offer.minOrder) fail(400, `${offer.code} needs an order of ₹${offer.minOrder} or more`)
    if (offer.firstOrderOnly && phone && (await col('orders').countDocuments({ phone, cancelled: false }, { limit: 1 }))) {
      fail(400, `${offer.code} is for a first order only`)
    }
  }

  let discount = 0
  if (offer?.type === 'percent') discount = Math.round((subtotal * offer.value) / 100)
  if (offer?.type === 'flat') discount = Math.min(offer.value, subtotal)
  const gst = Math.round(((subtotal - discount) * settings.gstRate) / 100)
  const freeDelivery = mode !== 'Delivery' || subtotal > settings.freeDeliveryAbove || offer?.type === 'delivery'
  const delivery = freeDelivery ? 0 : settings.deliveryFee

  return { lines: priced, subtotal, discount, gst, delivery, total: subtotal - discount + gst + delivery, coupon: offer?.code ?? null }
}

/** Saves a new order and tells the staff panels. */
export const createOrder = async (data) => {
  const now = Date.now()
  const id = await nextId('orders')
  const doc = {
    tableId: null,
    tableNo: null,
    address: '',
    note: '',
    waiterId: null,
    ...data,
    id,
    // Order numbers carry on from the website's earlier local numbering.
    code: `UTS${1266 + id}`,
    ticket: newTicket(),
    token: newToken(),
    step: 0,
    stepAt: [now],
    cancelled: false,
    cancelledAt: null,
    paid: false,
    paidAt: null,
    demo: false,
    createdAt: now,
  }
  await col('orders').insertOne(doc)
  const order = clean(doc)
  broadcast('order', { type: 'created', order: await present(order, { staff: true }) })
  return order
}

export const updateOrder = async (row, patch) => {
  const next = await col('orders').findOneAndUpdate({ id: row.id }, { $set: patch }, { returnDocument: 'after', projection: { _id: 0 } })
  broadcast('order', { type: 'updated', order: await present(next, { staff: true }) })
  return next
}

export const setStep = (row, step) => {
  if (row.cancelled) fail(409, 'This order is cancelled')
  if (!Number.isInteger(step) || step < 0 || step > 3) fail(400, 'step must be 0 to 3')
  const stepAt = [...row.stepAt]
  stepAt[step] = Date.now()
  return updateOrder(row, { step, stepAt: stepAt.slice(0, step + 1) })
}

export const cancelOrder = (row) => {
  if (row.cancelled) return row
  if (row.step >= 3) fail(409, 'A finished order cannot be cancelled')
  return updateOrder(row, { cancelled: true, cancelledAt: Date.now() })
}
