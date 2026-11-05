import bcrypt from 'bcryptjs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { config } from './config.js'
import { col, nextId } from './db.js'
import { saveImage } from './media.js'
import { saveSettings } from './util.js'

export const TABLE_COUNT = 50

/** The restaurant's 50 tables: 1-20 Main Hall, 21-35 Family Section, 36-50 Outdoor. */
export const defaultTables = () =>
  Array.from({ length: TABLE_COUNT }, (_, k) => {
    const n = k + 1
    const area = n <= 20 ? 'Main Hall' : n <= 35 ? 'Family Section' : 'Outdoor'
    const capacity = n <= 8 ? 2 : n <= 30 ? 4 : n <= 35 ? 6 : n <= 45 ? 4 : 8
    return { number: String(n), name: '', capacity, area, active: true, reserved: false, reservedFor: '' }
  })

const empty = async (name) => (await col(name).estimatedDocumentCount()) === 0

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))

/** Inserts docs with numeric ids from the collection's counter, in the order given. */
const insertNumbered = async (name, docs) => {
  const out = []
  for (const [i, d] of docs.entries()) out.push({ ...d, id: await nextId(name), sort: i })
  if (out.length) await col(name).insertMany(out)
}

/** Copies every photo in seed/media into MongoDB (GridFS) as /uploads/seed/...; files already there are skipped. */
const seedMedia = async () => {
  const root = join(config.seedDir, 'media')
  let added = 0
  // One query for every stored name, instead of one per photo: keeps start-up fast.
  const have = new Set(await col('media.files').distinct('filename', { filename: /^seed\// }))
  for (const file of walk(root)) {
    const path = `seed/${relative(root, file).split(sep).join('/')}`
    if (have.has(path)) continue
    await saveImage(path, readFileSync(file))
    added++
  }
  return added
}

/** Fills an empty database with the website's original content, its photos, tables and two starter logins. */
export const seed = async ({ log = false } = {}) => {
  const content = JSON.parse(readFileSync(join(config.seedDir, 'content.json'), 'utf8'))
  const done = []

  const images = await seedMedia()
  if (images) done.push(`${images} images`)

  if (!(await col('settings').findOne({ _id: 'site' }))) {
    const { site } = content
    const [open, close] = ['11:30', '22:30']
    await saveSettings({
      name: site.name,
      tagline: site.tagline,
      phone: site.phone,
      address: site.address,
      landmark: site.landmark,
      days: site.days,
      openTime: open,
      closeTime: close,
      services: site.services,
      googleRating: site.googleRating,
      googleReviews: site.googleReviews,
      mapLink: site.mapLink,
      mapEmbed: site.mapEmbed,
      social: site.social,
    })
    done.push('settings')
  }

  if (await empty('users')) {
    const now = Date.now()
    await col('users').insertMany([
      { id: await nextId('users'), name: 'Owner', username: 'admin', usernameLower: 'admin', passwordHash: await bcrypt.hash('admin123', 10), role: 'admin', active: true, createdAt: now },
      { id: await nextId('users'), name: 'Waiter', username: 'waiter', usernameLower: 'waiter', passwordHash: await bcrypt.hash('waiter123', 10), role: 'waiter', active: true, createdAt: now },
    ])
    done.push('logins admin/admin123 and waiter/waiter123 (change these!)')
  }

  if (await empty('categories')) {
    await insertNumbered(
      'categories',
      content.categories.map((name) => {
        const first = content.menu.find((m) => m.category === name && m.isPopular) ?? content.menu.find((m) => m.category === name)
        return { name, image: first?.image ?? '', active: true }
      }),
    )
    done.push(`${content.categories.length} categories`)
  }

  if (await empty('menu')) {
    await col('menu').insertMany(
      content.menu.map((m, i) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        price: m.price,
        image: m.image,
        description: m.description,
        isVeg: !!m.isVeg,
        rating: m.rating,
        prepTime: m.prepTime,
        isPopular: !!m.isPopular,
        isNew: !!m.isNew,
        spicy: m.spicy ?? 0,
        available: true,
        sort: i,
      })),
    )
    done.push(`${content.menu.length} dishes`)
  }

  if (await empty('offers')) {
    await col('offers').insertMany(
      content.offers.map((o, i) => ({ code: o.code, title: o.title, description: o.description, type: o.type, value: o.value, minOrder: o.minOrder, firstOrderOnly: !!o.firstOrderOnly, active: true, sort: i })),
    )
    done.push(`${content.offers.length} offers`)
  }

  if (await empty('gallery')) {
    await insertNumbered('gallery', content.gallery.map((g) => ({ src: g.src, title: g.title, category: g.category, width: g.width, height: g.height })))
    done.push(`${content.gallery.length} gallery photos`)
  }

  if (await empty('slides')) {
    await insertNumbered('slides', content.slides.map((s) => ({ ...s, active: true })))
    done.push(`${content.slides.length} slides`)
  }

  if (await empty('testimonials')) {
    await insertNumbered('testimonials', content.testimonials.map((t) => ({ ...t, active: true })))
    done.push(`${content.testimonials.length} reviews`)
  }

  if (await empty('notifications')) {
    const now = Date.now()
    await insertNumbered('notifications', content.notifications.map((n, i) => ({ title: n.title, body: n.body, active: true, createdAt: now - i * 86_400_000 })))
    done.push(`${content.notifications.length} notifications`)
  }

  if (await empty('tables')) {
    await insertNumbered('tables', defaultTables())
    done.push(`${TABLE_COUNT} tables`)
  }

  if (log || done.length) console.log(done.length ? `Seeded: ${done.join(', ')}` : 'Database already seeded, nothing to add.')
}
