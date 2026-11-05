// Server-Sent Events: the admin and waiter panels keep one connection open and hear about order changes live.

const clients = new Set()

export const subscribe = (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write('retry: 3000\n\n')
  const client = { res, user: req.user }
  clients.add(client)
  // Comments every 25s stop proxies from closing an idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    clients.delete(client)
  })
}

/** Sends an event to every connected staff panel. */
export const broadcast = (type, data) => {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) c.res.write(msg)
}
