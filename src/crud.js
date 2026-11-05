import { Router } from 'express'
import { clean, col, isDuplicate, nextId } from './db.js'
import { fail, pick, route } from './util.js'

/**
 * Standard list / create / update / delete / reorder routes for one collection.
 * key: the public id field. Numeric ids ('id') come from a counter unless makeKey builds one.
 */
export const crud = ({ collection, key = 'id', fields, sort = { sort: 1, id: 1 }, makeKey, defaults = {}, onChange }) => {
  const r = Router()
  const c = () => col(collection)
  const numeric = key === 'id' && !makeKey
  const keyOf = (raw) => (numeric ? Number(raw) : raw)
  const changed = () => onChange?.()
  const unique = (e) => {
    if (isDuplicate(e)) fail(409, 'That already exists')
    throw e
  }

  r.get(
    '/',
    route(async (_req, res) => res.json((await c().find({}, { projection: { _id: 0 } }).sort(sort).toArray()))),
  )

  r.post(
    '/',
    route(async (req, res) => {
      const doc = { ...defaults, ...pick(req.body, fields) }
      doc[key] = makeKey ? await makeKey(req.body, doc) : await nextId(collection)
      const last = await c().find({}, { projection: { sort: 1 } }).sort({ sort: -1 }).limit(1).next()
      doc.sort = (last?.sort ?? -1) + 1
      await c().insertOne(doc).catch(unique)
      changed()
      res.status(201).json(clean(doc))
    }),
  )

  // Body: { ids: [...] } in the new order.
  r.put(
    '/order',
    route(async (req, res) => {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : fail(400, 'ids must be a list')
      if (ids.length) await c().bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { [key]: keyOf(id) }, update: { $set: { sort: i } } } })))
      changed()
      res.json({ ok: true })
    }),
  )

  r.put(
    '/:id',
    route(async (req, res) => {
      const patch = pick(req.body, fields, { partial: true })
      const doc = await c()
        .findOneAndUpdate({ [key]: keyOf(req.params.id) }, { $set: patch }, { returnDocument: 'after', projection: { _id: 0 } })
        .catch(unique)
      if (!doc) fail(404, 'Not found')
      changed()
      res.json(doc)
    }),
  )

  r.delete(
    '/:id',
    route(async (req, res) => {
      const { deletedCount } = await c().deleteOne({ [key]: keyOf(req.params.id) })
      if (!deletedCount) fail(404, 'Not found')
      changed()
      res.json({ ok: true })
    }),
  )

  return r
}
