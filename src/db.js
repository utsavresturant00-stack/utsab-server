import { GridFSBucket, MongoClient } from 'mongodb'
import { config } from './config.js'

/** @type {MongoClient} Created on connect, so a missing MONGODB_URI is reported instead of crashing on load. */
export let client

/** @type {import('mongodb').Db} */
export let db
/** Images live in MongoDB too, in the "media" GridFS bucket, so the server keeps nothing on disk. */
/** @type {GridFSBucket} */
export let bucket

export const col = (name) => db.collection(name)

/** Next number in a sequence (orders, tables, …). Records keep small numeric ids the panels already use. */
export const nextId = async (name) => {
  const doc = await col('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' })
  return doc.seq
}

/** A document without Mongo's internal _id. */
export const clean = (doc) => {
  if (!doc) return doc
  const { _id, ...rest } = doc
  return rest
}

export const connect = async () => {
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set')
  client ??= new MongoClient(config.mongoUri, { maxPoolSize: 20, serverSelectionTimeoutMS: 15000 })
  await client.connect()
  db = client.db()
  bucket = new GridFSBucket(db, { bucketName: 'media' })
  await Promise.all([
    col('users').createIndex({ usernameLower: 1 }, { unique: true }),
    col('users').createIndex({ id: 1 }, { unique: true }),
    col('categories').createIndex({ name: 1 }, { unique: true }),
    col('categories').createIndex({ id: 1 }, { unique: true }),
    col('menu').createIndex({ id: 1 }, { unique: true }),
    col('menu').createIndex({ category: 1 }),
    col('offers').createIndex({ code: 1 }, { unique: true }),
    col('gallery').createIndex({ id: 1 }, { unique: true }),
    col('slides').createIndex({ id: 1 }, { unique: true }),
    col('testimonials').createIndex({ id: 1 }, { unique: true }),
    col('notifications').createIndex({ id: 1 }, { unique: true }),
    col('tables').createIndex({ id: 1 }, { unique: true }),
    col('tables').createIndex({ number: 1 }, { unique: true }),
    col('orders').createIndex({ id: 1 }, { unique: true }),
    col('orders').createIndex({ code: 1 }, { unique: true }),
    col('orders').createIndex({ createdAt: -1 }),
    col('orders').createIndex({ phone: 1 }),
    col('orders').createIndex({ tableId: 1, createdAt: -1 }),
    col('invoices').createIndex({ number: 1 }, { unique: true }),
    col('invoices').createIndex({ orderId: 1 }, { unique: true }),
    db.collection('media.files').createIndex({ filename: 1 }),
  ])
}

export const isDuplicate = (e) => e?.code === 11000
