// One-off tool: turns the website's original data files into seed/content.json and copies
// its photos into seed/media, so a fresh database starts with the real menu and gallery.
// Run from the server folder: npm run seed:from-client (needs ../client with its node_modules).
import { build } from '../../client/node_modules/esbuild/lib/main.js'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const client = new URL('../../client/', import.meta.url)
const out = new URL('../seed/', import.meta.url)
mkdirSync(out, { recursive: true })

const entry = `
export { categories, defaultMenu as menu } from './src/data/menu'
export { allOffers as offers } from './src/data/offers'
export { gallery } from './src/data/gallery'
export { testimonials } from './src/data/testimonials'
export { notifications } from './src/data/notifications'
export { site } from './src/data/site'
`
const bundle = new URL('../seed/.data.mjs', import.meta.url)
await build({ stdin: { contents: entry, resolveDir: client.pathname.slice(1), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: bundle.pathname.slice(1) })
const data = await import(pathToFileURL(bundle.pathname.slice(1)).href)

const media = (p) => p.replace(/^\/images\//, '/uploads/seed/').replace(/^\/(logo[\w-]*\.png)$/, '/uploads/seed/brand/$1')
const content = {
  categories: data.categories,
  menu: data.menu.map((m) => ({ ...m, image: media(m.image) })),
  offers: data.offers,
  gallery: data.gallery.map((g) => ({ ...g, src: media(g.src) })),
  testimonials: data.testimonials,
  notifications: data.notifications.map(({ title, body }) => ({ title, body })),
  slides: [
    { image: '/uploads/seed/hero/dish-biryani-cut.webp', alt: 'Chicken biryani in a brass bowl', steam: true, cutout: true },
    { image: '/uploads/seed/hero/dish-pizza.webp', alt: 'Wood-fired pizza on a dark table', steam: false, cutout: false },
    { image: '/uploads/seed/hero/dish-dessert-cut.webp', alt: 'Ice cream dessert with caramel sauce', steam: false, cutout: true },
  ],
  site: data.site,
}
writeFileSync(new URL('content.json', out), JSON.stringify(content, null, 2))

for (const dir of ['menu', 'gallery', 'hero', 'ambience']) cpSync(new URL(`public/images/${dir}`, client), new URL(`media/${dir}`, out), { recursive: true })
mkdirSync(new URL('media/brand', out), { recursive: true })
for (const f of ['logo.png', 'logo-word.png', 'logo-cup.png', 'logo-splash.png']) cpSync(new URL(`public/${f}`, client), new URL(`media/brand/${f}`, out))
console.log(`seed: ${content.menu.length} dishes, ${content.gallery.length} photos, ${content.offers.length} offers`)
