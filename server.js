// Entry file (CommonJS, so hosts whose Node runner loads it with require() can start it: Hostinger, Passenger, LiteSpeed).
// It records everything the app prints in logs/startup.log (readable from the host's File Manager),
// then starts the real (ES module) server.
const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')

const dir = path.join(__dirname, 'logs')
const file = path.join(dir, 'startup.log')
try {
  fs.mkdirSync(dir, { recursive: true })
  // Keep the file small: start fresh when it passes 1 MB.
  if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.writeFileSync(file, '')
} catch {
  // Read-only disk: logging to the file is skipped, the console still works.
}

const write = (level, args) => {
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`)
  } catch {
    // Ignore: never let logging stop the app.
  }
}
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    write(level.toUpperCase(), args)
    original(...args)
  }
}

console.log(`Starting UTSAV API: Node ${process.version}, PORT=${process.env.PORT ?? '(not set, using 4000)'}, folder ${__dirname}`)
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e))
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e))

import('./src/index.js').catch((err) => {
  console.error('Failed to start the UTSAV API:', err)
  process.exitCode = 1
})
