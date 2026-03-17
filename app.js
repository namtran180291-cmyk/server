/**
 * High-Performance WebSocket Mining Proxy
 * Stack: uWebSockets.js + Node.js cluster
 *
 * Miner connects as: ws://proxy:3333/<base64_pool_address>
 * Example: ws://proxy:3333/c3RyYXR1bSt0Y3A6Ly9wb29sLmV4YW1wbGUuY29tOjMzMzM=
 *          where base64 decodes to "stratum+tcp://pool.example.com:3333"
 *
 * Flow: Miner (WS) ──▶ Proxy ──▶ Pool (TCP/Stratum)
 */

import cluster from 'cluster'
import os from 'os'
import net from 'net'
import { App } from 'uWebSockets.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  ws: {
    port:            parseInt(process.env.PORT || '3333'),
    idleTimeout:     0,
    maxBackpressure: 64 * 1024,
    compression:     0,
  },
  // Optional whitelist — leave empty to allow any pool
  // e.g. ALLOWED_POOLS=pool.example.com:3333,pool2.example.com:4444
  allowedPools: (process.env.ALLOWED_POOLS || '').split(',').filter(Boolean),
  workers: parseInt(process.env.WORKERS || String(os.cpus().length)),
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse pool address from URL path.
 * Path format: /<base64_encoded_pool_address>
 *
 * Supported pool address formats after base64 decode:
 *   stratum+tcp://host:port
 *   stratum+ssl://host:port
 *   host:port
 *
 * Returns { host, port, tls, raw } or null if invalid.
 */
function parsePoolFromPath(url) {
  try {
    const b64 = decodeURIComponent(url.slice(1)) // strip leading /
    if (!b64) return null

    const decoded = Buffer.from(b64, 'base64').toString('utf8')

    let host, port, tls = false

    if (decoded.startsWith('stratum+ssl://') || decoded.startsWith('stratum+tls://')) {
      tls = true
      const addr = decoded.replace(/^stratum\+(ssl|tls):\/\//, '')
      ;[host, port] = splitHostPort(addr)
    } else if (decoded.startsWith('stratum+tcp://')) {
      const addr = decoded.replace('stratum+tcp://', '')
      ;[host, port] = splitHostPort(addr)
    } else {
      ;[host, port] = splitHostPort(decoded)
    }

    if (!host || !port) return null

    return { host, port, tls, raw: decoded }
  } catch {
    return null
  }
}

function splitHostPort(addr) {
  const lastColon = addr.lastIndexOf(':')
  if (lastColon === -1) return [null, null]
  const host = addr.slice(0, lastColon)
  const port = parseInt(addr.slice(lastColon + 1))
  if (!host || isNaN(port) || port < 1 || port > 65535) return [null, null]
  return [host, port]
}

function isPoolAllowed(host, port) {
  if (CONFIG.allowedPools.length === 0) return true
  return CONFIG.allowedPools.includes(`${host}:${port}`)
}

// ─── Cluster: Primary ─────────────────────────────────────────────────────────

if (cluster.isPrimary) {
  console.log(`[master] pid=${process.pid} spawning ${CONFIG.workers} workers`)
  console.log(`[master] allowed pools: ${CONFIG.allowedPools.length ? CONFIG.allowedPools.join(', ') : 'any'}`)

  for (let i = 0; i < CONFIG.workers; i++) cluster.fork()

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[master] worker ${worker.process.pid} died (${signal || code}), respawning...`)
    cluster.fork()
  })

// ─── Cluster: Worker ──────────────────────────────────────────────────────────

} else {
  let activeConnections = 0

  const app = App()

  app.ws('/*', {
    idleTimeout:     CONFIG.ws.idleTimeout,
    maxBackpressure: CONFIG.ws.maxBackpressure,
    compression:     CONFIG.ws.compression,

    // ── Upgrade: validate URL before accepting WS connection ──────────────────
    upgrade(res, req, context) {
      const url  = req.getUrl()
      const pool = parsePoolFromPath(url)

      if (!pool) {
        res.writeStatus('400 Bad Request').end('Invalid pool address')
        return
      }

      if (!isPoolAllowed(pool.host, pool.port)) {
        res.writeStatus('403 Forbidden').end('Pool not allowed')
        return
      }

      // Pass pool info into open() via userData
      res.upgrade(
        { pool },
        req.getHeader('sec-websocket-key'),
        req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'),
        context,
      )
    },

    // ── Miner connects ────────────────────────────────────────────────────────
    open(ws) {
      activeConnections++
      const { pool } = ws.getUserData()

      console.log(`[worker ${process.pid}] miner connected → ${pool.raw} (active: ${activeConnections})`)

      const socket = net.createConnection({
        host:    pool.host,
        port:    pool.port,
        noDelay: true,
      })

      ws.poolSocket = socket
      ws.alive      = true

      // ── Pool → Miner ────────────────────────────────────────────────────────
      socket.on('data', (chunk) => {
        if (!ws.alive) return

        const result = ws.send(chunk, true) // binary frame

        // Backpressure: pool faster than WS client → pause pool reads
        if (result === 2 /* BACKPRESSURE */) {
          socket.pause()
        }
      })

      socket.on('error', (err) => {
        console.error(`[worker ${process.pid}] pool ${pool.raw} error: ${err.message}`)
        if (ws.alive) { ws.alive = false; ws.close() }
      })

      socket.on('close', () => {
        if (ws.alive) { ws.alive = false; ws.close() }
      })
    },

    // ── Miner → Pool ──────────────────────────────────────────────────────────
    message(ws, message) {
      const socket = ws.poolSocket
      if (!socket || socket.destroyed) {
        if (ws.alive) { ws.alive = false; ws.close() }
        return
      }

      socket.write(Buffer.from(message))
    },

    // ── WS backpressure drained → resume pool reads ───────────────────────────
    drain(ws) {
      const socket = ws.poolSocket
      if (socket && !socket.destroyed) socket.resume()
    },

    // ── Miner disconnects ─────────────────────────────────────────────────────
    close(ws) {
      ws.alive = false
      activeConnections--

      const { pool } = ws.getUserData()
      console.log(`[worker ${process.pid}] miner disconnected ← ${pool.raw} (active: ${activeConnections})`)

      const socket = ws.poolSocket
      if (socket && !socket.destroyed) socket.destroy()
    },
  })

  // ── Health check ─────────────────────────────────────────────────────────────
  app.get('/health', (res) => {
    res.writeHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      pid:         process.pid,
      connections: activeConnections,
      uptime:      Math.floor(process.uptime()),
      memory:      process.memoryUsage(),
    }))
  })

  app.listen(CONFIG.ws.port, (token) => {
    if (token) {
      console.log(`[worker ${process.pid}] listening on ws://0.0.0.0:${CONFIG.ws.port}`)
    } else {
      console.error(`[worker ${process.pid}] failed to bind port ${CONFIG.ws.port}`)
      process.exit(1)
    }
  })

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  const shutdown = (signal) => {
    console.log(`[worker ${process.pid}] ${signal} received, shutting down...`)
    app.close()
    setTimeout(() => process.exit(0), 1000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}
