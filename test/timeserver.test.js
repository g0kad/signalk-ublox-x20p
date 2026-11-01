'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('dgram')
const { TimeServer, NTP_EPOCH_OFFSET_S } = require('../lib/timeserver')
const { independentSync } = require('../lib/receiver')

const T0 = Date.parse('2026-11-01T12:00:00.000Z')
const pvt = (ms, extra = {}) => ({ time: new Date(ms).toISOString(), timeValid: true, gnssFixOK: true, tAcc: 2e-8, ...extra })
const ntpMs = (buf, o) => (buf.readUInt32BE(o) - NTP_EPOCH_OFFSET_S) * 1000 + buf.readUInt32BE(o + 4) / 0x100000000 * 1000

function request (transmitMs) {
  const r = Buffer.alloc(48)
  r[0] = (4 << 3) | 3 // version 4, client
  r[2] = 4
  r.writeUInt32BE(Math.floor(transmitMs / 1000) + NTP_EPOCH_OFFSET_S, 40)
  r.writeUInt32BE(123456, 44)
  return r
}

test('offset is the median of epoch time plus delay minus arrival time', () => {
  let now = T0
  const ts = new TimeServer({ delayMs: 40, now: () => now })
  // the host clock runs 500 ms fast; messages arrive 30-50 ms after their epoch
  for (const [k, lag] of [30, 50, 40, 45, 35].entries()) {
    now = T0 + k * 1000 + 500 + lag
    assert.ok(ts.sample(pvt(T0 + k * 1000), now))
  }
  assert.equal(ts.offsetMs(), 40 - 500 - 40)
})

test('only a valid, accurate time with a fix is sampled', () => {
  const ts = new TimeServer({ now: () => T0 })
  assert.equal(ts.sample(pvt(T0, { timeValid: false }), T0), false)
  assert.equal(ts.sample(pvt(T0, { gnssFixOK: false }), T0), false)
  assert.equal(ts.sample(pvt(T0, { tAcc: 0.01 }), T0), false)
  assert.equal(ts.sample({ ...pvt(T0), time: null }, T0), false)
  assert.equal(ts.offsetMs(), null)
})

test('a step in the host clock starts the samples again', () => {
  let now = T0
  const ts = new TimeServer({ now: () => now })
  for (let k = 0; k < 5; k++) { now = T0 + k * 1000; ts.sample(pvt(now), now) }
  now = T0 + 5000; ts.sample(pvt(now - 3000), now) // host clock jumped 3 s ahead
  assert.equal(ts.offsetMs(), -3000)
  assert.equal(ts.status().samples, 1)
})

test('reply carries stratum 1, origin copied and the corrected time', () => {
  let now = T0
  const ts = new TimeServer({ now: () => now })
  ts.sample(pvt(T0 + 250), T0) // host 250 ms slow
  now = T0 + 100
  const req = request(T0)
  const r = ts.reply(req, now)
  assert.equal(r.length, 48)
  assert.equal(r[0] >> 6, 0)
  assert.equal(r[0] & 0x07, 4)
  assert.equal((r[0] >> 3) & 0x07, 4)
  assert.equal(r[1], 1)
  assert.equal(r.toString('ascii', 12, 16), 'GNSS')
  assert.deepEqual(r.subarray(24, 32), req.subarray(40, 48))
  assert.ok(Math.abs(ntpMs(r, 32) - (T0 + 350)) < 1)
  assert.ok(Math.abs(ntpMs(r, 40) - (T0 + 350)) < 1)
})

test('without recent time the reply says unsynchronised; non-client packets are ignored', () => {
  let now = T0
  const ts = new TimeServer({ now: () => now })
  ts.sample(pvt(T0), T0)
  now = T0 + 6000
  const r = ts.reply(request(now), now)
  assert.equal(r[0] >> 6, 3)
  assert.equal(r[1], 16)
  const server = request(now); server[0] = (4 << 3) | 4
  assert.equal(ts.reply(server, now), null)
  assert.equal(ts.reply(Buffer.alloc(10), now), null)
})

test('answers over UDP on localhost', async () => {
  const ts = new TimeServer({ port: 0 })
  await ts.start()
  ts.sample(pvt(Date.now()), Date.now())
  const { port } = ts.socket.address()
  const client = dgram.createSocket('udp4')
  const reply = await new Promise((resolve, reject) => {
    client.on('message', resolve)
    client.send(request(Date.now()), port, '127.0.0.1', e => e && reject(e))
  })
  client.close()
  ts.stop()
  assert.equal(reply[1], 1)
  assert.ok(Math.abs(ntpMs(reply, 40) - Date.now()) < 1000)
  assert.equal(ts.served, 1)
})

test('host time counts as independent only when not synced to a refclock or a local server', () => {
  const sources = sel => `MS Name/IP address         Stratum Poll Reach LastRx Last sample\n===\n${sel}\n`
  assert.equal(independentSync('yes\n', null), true)
  assert.equal(independentSync('no\n', null), false)
  assert.equal(independentSync('yes', sources('^* 162.159.200.1    3   6   377    20   +120us[ +150us] +/-   15ms\n^- 127.0.0.1   1   4   377   5  -30ms')), true)
  assert.equal(independentSync('yes', sources('^* 127.0.0.1                     1   4   377     5   -12ms[  -12ms] +/-   20ms')), false)
  assert.equal(independentSync('yes', sources('^* ::1                           1   4   377     5   -12ms[  -12ms] +/-   20ms')), false)
  assert.equal(independentSync('yes', sources('#* GPS0                          0   4   377     5   -12ms[  -12ms] +/-   20ms')), false)
})
