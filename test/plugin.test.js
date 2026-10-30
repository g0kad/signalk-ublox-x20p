'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { SignalKMapper } = require('../lib/signalk')

function mockApp () {
  const app = { deltas: [], status: [], errors: [] }
  app.debug = () => {}
  app.error = e => app.errors.push(e)
  app.setPluginStatus = s => app.status.push(s)
  app.setPluginError = s => app.status.push(`ERROR ${s}`)
  app.handleMessage = (id, d) => app.deltas.push(d)
  return app
}
const values = app => Object.fromEntries(app.deltas.flatMap(d => d.updates.flatMap(u => (u.values || []).map(v => [v.path, v.value]))))

test('plugin exposes id, name, schema and lifecycle', () => {
  const plugin = require('..')(mockApp())
  assert.equal(plugin.id, 'signalk-ublox-x20p')
  assert.equal(typeof plugin.start, 'function')
  assert.equal(typeof plugin.stop, 'function')
  assert.equal(plugin.schema.type, 'object')
  assert.ok(plugin.schema.properties.device.default)
})

test('starts with schema defaults and no receiver attached, then stops cleanly', async () => {
  const app = mockApp()
  const plugin = require('..')(app)
  plugin.start({ device: '/dev/does-not-exist-x20p' })
  await new Promise(resolve => setTimeout(resolve, 300))
  plugin.stop()
  assert.ok(app.status.some(s => /waiting for|ERROR/.test(s)), 'reports that the receiver is missing')
  assert.equal(app.errors.length, 0)
})

test('API routes answer 503 while the receiver is not connected', async () => {
  const app = mockApp()
  const plugin = require('..')(app)
  const routes = {}
  const router = { get: (p, h) => { routes[`GET ${p}`] = h }, post: (p, h) => { routes[`POST ${p}`] = h } }
  plugin.registerWithRouter(router)
  plugin.start({ device: '/dev/does-not-exist-x20p' })
  const call = (r, body) => new Promise(resolve => {
    const res = { code: 200, status (c) { this.code = c; return this }, json (v) { resolve({ code: this.code, body: v }) } }
    routes[r]({ body }, res)
  })
  assert.equal((await call('GET /api/settings')).code, 503)
  assert.equal((await call('POST /api/config', { changes: [] })).code, 503)
  plugin.stop()
})

test('recognises the ZED-X20P from MON-VER', () => {
  const { isX20P } = require('../lib/receiver')
  assert.equal(isX20P({ module: 'ZED-X20P' }), true)
  assert.equal(isX20P({ module: 'ZED-F9P' }), false)
  assert.equal(isX20P({}), false)
})

test('configuration writes are blocked on other receivers unless allowed', async t => {
  const { Receiver } = require('../lib/receiver')
  // Pretend a ZED-F9P is connected, without touching a serial port
  t.mock.method(Receiver.prototype, 'start', function () {
    this.device.connected = true
    this.info = { version: { module: 'ZED-F9P' }, supported: false }
  })
  t.mock.method(Receiver.prototype, 'stop', () => {})
  t.mock.method(Receiver.prototype, 'writeConfig', async () => {})
  t.mock.method(Receiver.prototype, 'readConfig', async () => ({ ram: {}, saved: {} }))
  const run = async allowOtherReceivers => {
    const plugin = require('..')(mockApp())
    const routes = {}
    const router = { get: (p, h) => { routes[`GET ${p}`] = h }, post: (p, h) => { routes[`POST ${p}`] = h } }
    plugin.registerWithRouter(router)
    plugin.start({ device: '/dev/null', allowOtherReceivers })
    const call = (r, body) => new Promise(resolve => {
      const res = { code: 200, status (c) { this.code = c; return this }, json (v) { resolve({ code: this.code, body: v }) } }
      routes[r]({ body }, res)
    })
    const out = {
      status: (await call('GET /api/status')).body,
      write: await call('POST /api/config', { changes: [{ key: 'CFG-RATE-MEAS', value: 100 }] }),
      restore: await call('POST /api/restore', { backup: {} })
    }
    plugin.stop()
    return out
  }
  const locked = await run(false)
  assert.equal(locked.status.configLocked, true)
  assert.equal(locked.write.code, 400)
  assert.match(locked.write.body.error, /ZED-F9P/)
  assert.match(locked.restore.body.error, /ZED-F9P/)
  const allowed = await run(true)
  assert.equal(allowed.status.configLocked, false)
  assert.equal(allowed.write.code, 200)
})

test('maps an epoch to Signal K paths', () => {
  const app = mockApp()
  const m = new SignalKMapper(app, 'test', { cogMinSpeed: 0.25, satelliteInterval: 0, publishDatetime: true, notifications: true })
  m.epoch({
    'NAV-PVT': {
      iTOW: 1, gnssFixOK: true, fixType: 3, diffSoln: true, carrSoln: 1, carrSolnText: 'float', numSV: 30,
      lat: 50.1, lon: -1.2, height: 100, hMSL: 54.5, hAcc: 0.07, vAcc: 0.1, gSpeed: 2, headMot: 1, sAcc: 0.05, headAcc: 0.01,
      velN: 1, velE: 1, velD: 0, tAcc: 2.2e-8, timeValid: true, time: '2026-10-30T01:00:00.000Z', lastCorrectionAge: 1, nmaFix: true
    },
    'NAV-SIG': { sigs: [{ prUsed: true, corrSource: 'Galileo HAS', authenticated: true }, { prUsed: true, corrSource: 'Galileo HAS', authenticated: false }] },
    'SEC-SIG': { jamDetEnabled: true, jamState: 1, jamStateText: 'none', spfDetEnabled: true, spfState: 1, spfStateText: 'none' },
    'SEC-OSNMA': { enabled: true, nmaStatusText: 'operational' },
    'NAV-SAT': { sats: [{ svId: 5, name: 'E05', gnss: 'Galileo', used: true, elev: 45, azim: 90, cno: 40 }] }
  })
  const v = values(app)
  assert.deepEqual(v['navigation.position'], { latitude: 50.1, longitude: -1.2, altitude: 54.5 })
  assert.equal(v['navigation.gnss.methodQuality'], 'Precise GNSS')
  assert.equal(v['navigation.gnss.correctionSource'], 'Galileo HAS')
  assert.equal(v['navigation.gnss.integrity'], 'Safe')
  assert.equal(v['navigation.gnss.horizontalAccuracy'], 0.07)
  assert.equal(v['navigation.gnss.timeAccuracy'], 2.2e-8)
  assert.equal(v['navigation.courseOverGroundTrue'], 1)
  assert.equal(v['navigation.gnss.authenticatedFix'], true)
  assert.equal(v['navigation.gnss.authenticatedSignals'], 1)
  assert.equal(v['navigation.gnss.satellitesInView'].count, 1)
  assert.ok(app.deltas[0].updates[0].meta, 'custom paths get meta first')
})

test('raises and clears spoofing notifications', () => {
  const app = mockApp()
  const m = new SignalKMapper(app, 'test', { cogMinSpeed: 0.25, satelliteInterval: 60, notifications: true })
  const epoch = spf => m.epoch({
    'NAV-PVT': { gnssFixOK: true, fixType: 3, lat: 0, lon: 0, height: 0, hMSL: 0, hAcc: 1, vAcc: 1, gSpeed: 0, velN: 0, velE: 0, velD: 0, sAcc: 0, headAcc: 0, tAcc: 0, carrSoln: 0 },
    'SEC-SIG': { jamDetEnabled: true, jamState: 1, spfDetEnabled: true, spfState: spf, spfStateText: '' }
  })
  epoch(3)
  epoch(1)
  const n = app.deltas.flatMap(d => d.updates.flatMap(u => u.values || [])).filter(v => v.path === 'notifications.navigation.gnss.spoofing')
  assert.deepEqual(n.map(x => x.value.state), ['alarm', 'normal'])
})
