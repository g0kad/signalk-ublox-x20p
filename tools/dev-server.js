#!/usr/bin/env node
// Standalone dev server: runs the plugin with a mock Signal K app and serves the web app,
// using the same URL layout as Signal K (/signalk-ublox-x20p/ and /plugins/signalk-ublox-x20p/).
// Usage: node tools/dev-server.js [/dev/ttyACM0] [port]
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')

const device = process.argv[2] || '/dev/ttyACM0'
const port = Number(process.argv[3] || 3999)
const PUB = path.join(__dirname, '..', 'public')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

const app = {
  debug: () => {},
  error: e => console.error(e),
  setPluginStatus: s => console.log('[status]', s),
  setPluginError: s => console.log('[error]', s),
  handleMessage: () => {}
}
const routes = {}
const router = { get: (p, h) => { routes['GET ' + p] = h }, post: (p, h) => { routes['POST ' + p] = h } }
const plugin = require('..')(app)
plugin.registerWithRouter(router)
plugin.start({ device })

const PREFIX = '/plugins/signalk-ublox-x20p'
http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url.startsWith(PREFIX)) {
    const h = routes[`${req.method} ${url.slice(PREFIX.length)}`]
    if (!h) { res.writeHead(404); return res.end() }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const r = {
        statusCode: 200,
        status (c) { this.statusCode = c; return this },
        json (v) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
      }
      try { h({ body: body ? JSON.parse(body) : {} }, r) } catch (e) { r.status(400).json({ error: e.message }) }
    })
    return
  }
  let f = url.replace(/^\/signalk-ublox-x20p/, '') || '/'
  if (f.endsWith('/')) f += 'index.html'
  const file = path.join(PUB, path.normalize(f))
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end() }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}).listen(port, () => console.log(`http://localhost:${port}/signalk-ublox-x20p/`))
