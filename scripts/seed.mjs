// Seeds MongoDB with the website's content and photos.
//   npm run seed            add whatever is missing (safe to run again)
//   npm run seed -- --reset wipe content collections and photos first, then seed fresh
//                           (orders, invoices and staff accounts are kept)
import { client, col, connect, db } from '../src/db.js'
import { migrateToRestaurant, seed } from '../src/seed.js'

await connect()

if (process.argv.includes('--reset')) {
  const content = ['settings', 'categories', 'menu', 'offers', 'gallery', 'slides', 'testimonials', 'notifications', 'tables']
  for (const name of content) await col(name).deleteMany({})
  await col('counters').deleteMany({ _id: { $in: content } })
  const files = await col('media.files').find({ filename: /^seed\// }, { projection: { _id: 1 } }).toArray()
  const ids = files.map((f) => f._id)
  await db.collection('media.chunks').deleteMany({ files_id: { $in: ids } })
  await col('media.files').deleteMany({ _id: { $in: ids } })
  console.log(`Cleared ${content.length} collections and ${ids.length} seed photos.`)
}

await seed({ log: true })
await migrateToRestaurant()

const names = ['settings', 'users', 'categories', 'menu', 'offers', 'gallery', 'slides', 'testimonials', 'notifications', 'tables', 'orders', 'invoices', 'media.files']
const counts = await Promise.all(names.map(async (n) => [n, await col(n).countDocuments()]))
console.table(Object.fromEntries(counts))
const bytes = (await col('media.files').aggregate([{ $group: { _id: null, b: { $sum: '$length' } } }]).next())?.b ?? 0
console.log(`Images in MongoDB: ${(bytes / 1024 / 1024).toFixed(1)} MB`)
await client.close()
