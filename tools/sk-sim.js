#!/usr/bin/env node
// Runs the plugin against a mock Signal K app: prints deltas and exercises the read-only API.
// Usage: node tools/sk-sim.js [/dev/ttyACM0] [seconds]
'use strict'
const seconds = Number(process.argv[3] || 8)
const deltas = []
const app = {
  debug: (...a) => console.log('[debug]', ...a),
  error: e => console.error('[error]', e),
  setPluginStatus: s => console.log('[status]', s),
  setPluginError: s => console.log('[ERROR status]', s),
  handleMessage: (id, delta) => deltas.push(delta)
}
const routes = {}
const router = {
  get: (p, h) => { routes['GET ' + p] = h },
  post: (p, h) => { routes['POST ' + p] = h }
}
const call = (route, body) => new Promise(resolve => {
  const res = { statusCode: 200, status (c) { this.statusCode = c; return this }, json: v => resolve({ code: res.statusCode, body: v }) }
  routes[route]({ body }, res)
})

const plugin = require('..')(app)
plugin.registerWithRouter(router)
plugin.start({ device: process.argv[2] || '/dev/ttyACM0' })

setTimeout(async () => {
  const meta = deltas.find(d => d.updates[0].meta)
  console.log(`\n${deltas.length} deltas; meta entries: ${meta ? meta.updates[0].meta.length : 0}`)
  const last = {}
  for (const d of deltas) for (const u of d.updates) for (const v of u.values || []) last[v.path] = v.value
  for (const [p, v] of Object.entries(last)) {
    const s = JSON.stringify(v)
    console.log(p.padEnd(42), s.length > 160 ? s.slice(0, 160) + '…' : s)
  }
  const st = await call('GET /api/status')
  console.log('\n/api/status', st.code, 'counts', JSON.stringify(st.body.counts), 'parser', JSON.stringify(st.body.parser))
  const se = await call('GET /api/settings')
  console.log('/api/settings', se.code, se.body.error || `${Object.keys(se.body.defs).length} defs, ram ${Object.keys(se.body.values.ram).length}`)
  if (se.body.values) {
    const r = se.body.values
    for (const k of ['CFG-NAVSPG-DYNMODEL', 'CFG-RATE-MEAS', 'CFG-SIGNAL-PLAN', 'CFG-GAL-USE_OSNMA', 'CFG-NAVCOR-ENABLE_GAL_HAS', 'CFG-UART1-BAUDRATE'])
      console.log('  ', k, 'ram', r.ram[k], 'saved', r.saved[k], 'default', r.def[k])
    console.log('pending changes:', JSON.stringify(se.body.pending))
  }
  const cf = await call('GET /api/config')
  console.log('/api/config', cf.code, cf.body.error || `${Object.keys(cf.body.defs).length} keys (+${cf.body.hidden} undocumented)`)
  plugin.stop()
  setTimeout(() => process.exit(0), 300)
}, seconds * 1000)
