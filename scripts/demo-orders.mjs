// Fills the database with a year of believable sample orders so the dashboard charts have something to show.
//   npm run demo               add sample orders
//   npm run demo -- --remove   delete them again (real orders are never touched)
import { client, col, connect, nextId } from '../src/db.js'
import { newTicket, newToken } from '../src/util.js'

await connect()

if (process.argv.includes('--remove')) {
  const { deletedCount } = await col('orders').deleteMany({ demo: true })
  console.log(`Removed ${deletedCount} sample orders.`)
  await client.close()
  process.exit(0)
}

const menu = await col('menu').find().toArray()
const tables = await col('tables').find({ active: true }).toArray()
const waiter = await col('users').findOne({ role: 'waiter' })
const names = ['Ananya Das', 'Rahul Ghosh', 'Priya Saha', 'Sourav Mondal', 'Riya Banerjee', 'Arijit Paul', 'Sneha Roy', 'Debjit Sen', 'Moumita Dey', 'Subhajit Pal', 'Tania Kar', 'Abhishek Bera', 'Pritam Maity', 'Sayani Jana', 'Koushik Hazra', 'Rupa Bag']
const phones = names.map((_, i) => `98${String(31000000 + i * 7919).padStart(8, '0')}`)
const pick = (list) => list[Math.floor(Math.random() * list.length)]
// Lunch and dinner peaks.
const hours = [12, 13, 13, 14, 14, 15, 16, 17, 18, 19, 19, 20, 20, 20, 21, 21, 22]

const now = Date.now()
const docs = []
for (let day = 364; day >= 1; day--) {
  const d = new Date(now - day * 86_400_000)
  // Slow growth over the year, busier weekends, a festive bump in October.
  const base = 4 + (364 - day) / 60 + ([0, 6].includes(d.getDay()) ? 4 : 0) + (d.getMonth() === 9 ? 3 : 0)
  const n = Math.max(1, Math.round(base + (Math.random() - 0.5) * 4))
  for (let i = 0; i < n; i++) {
    d.setHours(pick(hours), Math.floor(Math.random() * 60), 0, 0)
    const createdAt = d.getTime()
    const mode = pick(['Dine-in', 'Dine-in', 'Dine-in', 'Takeaway', 'Takeaway', 'Delivery'])
    const table = mode === 'Dine-in' ? pick(tables) : null
    const items = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => pick(menu)).filter((m, idx, all) => all.indexOf(m) === idx)
    const lines = items.map((m) => ({ itemId: m.id, name: m.name, image: m.image, isVeg: m.isVeg, price: m.price, qty: 1 + Math.floor(Math.random() * 2.2), note: '' }))
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0)
    const delivery = mode === 'Delivery' && subtotal <= 499 ? 30 : 0
    const gst = Math.round(subtotal * 0.05)
    const who = Math.floor(Math.random() * names.length)
    const source = table && Math.random() < 0.6 ? 'waiter' : 'online'
    const cancelled = Math.random() < 0.04
    docs.push({
      source,
      mode,
      tableId: table?.id ?? null,
      tableNo: table?.number ?? null,
      name: source === 'waiter' ? `Table ${table.number}` : names[who],
      phone: source === 'waiter' ? '' : phones[who],
      address: mode === 'Delivery' ? `${10 + who}, Maju Rd, Dakshin Maju` : '',
      note: '',
      payment: pick(['Cash', 'Cash', 'UPI', 'UPI', 'Card']),
      coupon: null,
      subtotal,
      discount: 0,
      gst,
      delivery,
      total: subtotal + gst + delivery,
      step: 3,
      stepAt: [0, 8, 20, 32].map((m) => createdAt + m * 60_000),
      cancelled,
      cancelledAt: cancelled ? createdAt + 5 * 60_000 : null,
      paid: !cancelled,
      paidAt: cancelled ? null : createdAt + 40 * 60_000,
      waiterId: source === 'waiter' ? (waiter?.id ?? null) : null,
      lines,
      demo: true,
      createdAt,
      ticket: newTicket(d),
      token: newToken(),
    })
  }
}

// Reserve a block of order numbers in one go.
const last = (await col('counters').findOneAndUpdate({ _id: 'orders' }, { $inc: { seq: docs.length } }, { upsert: true, returnDocument: 'after' })).seq
docs.forEach((o, i) => {
  o.id = last - docs.length + 1 + i
  o.code = `UTS${1266 + o.id}`
})
await col('orders').insertMany(docs)
console.log(`Added ${docs.length} sample orders over the last year. Remove them with: npm run demo -- --remove`)
await client.close()
