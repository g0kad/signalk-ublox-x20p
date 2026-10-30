'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const ubx = require('../lib/ubx')

test('frame builds header, length and Fletcher checksum', () => {
  // MON-VER poll: known-good frame from the u-blox interface description
  assert.equal(ubx.frame(0x0a, 0x04).toString('hex'), 'b5620a0400000e34')
  const f = ubx.frame(0x06, 0x8b, Buffer.from([0, 0, 0, 0, 0x21, 0x00, 0x11, 0x20]))
  assert.equal(f.length, 16)
  assert.equal(f.readUInt16LE(4), 8)
  const [a, b] = ubx.checksum(f, 2, f.length - 2)
  assert.deepEqual([f[f.length - 2], f[f.length - 1]], [a, b])
})

test('parser splits interleaved UBX and NMEA across arbitrary chunk boundaries', () => {
  const got = []
  const p = new ubx.Parser({ onUbx: (c, i, pl) => got.push(['ubx', c, i, pl.length]), onNmea: l => got.push(['nmea', l]) })
  const nmea = '$GNGGA,000000.00,,,,,0,00,99.99,,,,,,*56\r\n'
  const stream = Buffer.concat([
    Buffer.from([0x00, 0xff]), // line noise
    ubx.frame(0x01, 0x07, Buffer.alloc(92)),
    Buffer.from(nmea, 'latin1'),
    ubx.frame(0x05, 0x01, Buffer.from([0x06, 0x8a]))
  ])
  for (let i = 0; i < stream.length; i += 7) p.push(stream.subarray(i, i + 7))
  assert.deepEqual(got, [['ubx', 1, 7, 92], ['nmea', nmea.trim()], ['ubx', 5, 1, 2]])
  assert.equal(p.stats.badChecksum, 0)
  assert.equal(p.stats.discarded, 2)
})

test('parser rejects a frame with a bad checksum and resynchronises', () => {
  const got = []
  const p = new ubx.Parser({ onUbx: (c, i) => got.push([c, i]) })
  const bad = ubx.frame(0x01, 0x07, Buffer.alloc(4))
  bad[bad.length - 1] ^= 0xff
  p.push(Buffer.concat([bad, ubx.frame(0x0a, 0x04, Buffer.alloc(0))]))
  assert.deepEqual(got, [[0x0a, 0x04]])
  assert.equal(p.stats.badChecksum, 1)
})
