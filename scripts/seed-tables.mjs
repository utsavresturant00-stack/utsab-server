// Makes sure tables 1-50 exist with the standard layout.
//   npm run seed:tables
// Adds any missing table numbers. Tables that already exist keep their seats, area and reservation,
// unless --layout is passed, which resets seats and area to the standard layout (reservations are kept).
import { client, col, connect, nextId } from '../src/db.js'
import { defaultTables } from '../src/seed.js'

await connect()
const relayout = process.argv.includes('--layout')
let added = 0
let updated = 0
for (const [i, t] of defaultTables().entries()) {
  const existing = await col('tables').findOne({ number: t.number })
  if (!existing) {
    await col('tables').insertOne({ ...t, id: await nextId('tables'), sort: i })
    added++
  } else {
    const set = { sort: i, ...(existing.reserved === undefined ? { reserved: false, reservedFor: '' } : {}) }
    if (relayout) Object.assign(set, { area: t.area, capacity: t.capacity })
    await col('tables').updateOne({ _id: existing._id }, { $set: set })
    updated++
  }
}
const byArea = await col('tables').aggregate([{ $group: { _id: '$area', tables: { $sum: 1 }, seats: { $sum: '$capacity' } } }, { $sort: { _id: 1 } }]).toArray()
console.log(`Added ${added} tables, checked ${updated}.`)
console.table(Object.fromEntries(byArea.map((a) => [a._id, { tables: a.tables, seats: a.seats }])))
await client.close()
