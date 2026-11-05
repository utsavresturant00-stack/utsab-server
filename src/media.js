import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { bucket, col } from './db.js'

export const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' }
const BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }

export const typeOf = (name) => BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'

/** Saves bytes to GridFS under `path` (e.g. "menu/abc.webp") and returns the public /uploads/... URL. */
export const saveImage = async (path, buffer, contentType = typeOf(path)) => {
  await pipeline(Readable.from(buffer), bucket.openUploadStream(path, { metadata: { contentType } }))
  return `/uploads/${path}`
}

export const newImageName = (folder, mime) => `${folder}/${Date.now().toString(36)}-${randomBytes(4).toString('hex')}${IMAGE_TYPES[mime] ?? ''}`

export const imageExists = async (path) => !!(await col('media.files').findOne({ filename: path }, { projection: { _id: 1 } }))

/** Express handler for GET /uploads/*: streams the newest file with that name from GridFS. */
export const serveImage = async (req, res, next) => {
  try {
    const path = req.params[0]
    const file = await col('media.files').find({ filename: path }).sort({ uploadDate: -1 }).limit(1).next()
    if (!file) return res.status(404).json({ error: 'Image not found' })
    const etag = `"${file._id}"`
    res.set({
      'Content-Type': file.metadata?.contentType ?? typeOf(path),
      'Cache-Control': 'public, max-age=2592000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ETag: etag,
    })
    if (req.get('if-none-match') === etag) return res.status(304).end()
    res.set('Content-Length', String(file.length))
    bucket.openDownloadStream(file._id).on('error', next).pipe(res)
  } catch (e) {
    next(e)
  }
}
