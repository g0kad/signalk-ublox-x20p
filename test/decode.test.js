'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { decode } = require('../lib/decode')

// Synthetic payloads built to the layouts in the u-blox X20 HPG 2.11 interface description

function navPvt () {
  const p = Buffer.alloc(92)
  p.writeUInt32LE(434230000, 0)
  p.writeUInt16LE(2026, 4); p[6] = 10; p[7] = 30; p[8] = 1; p[9] = 2; p[10] = 3
  p[11] = 0x07 // validDate | validTime | fullyResolved
  p.writeUInt32LE(22, 12) // tAcc ns
  p.writeInt32LE(500000000, 16) // nano
  p[20] = 3 // 3D
  p[21] = 0x01 | 0x02 | (1 << 6) // gnssFixOK, diffSoln, carrSoln float
  p[23] = 28
  p.writeInt32LE(Math.round(-1.5 * 1e7), 24) // lon
  p.writeInt32LE(Math.round(50.25 * 1e7), 28) // lat
  p.writeInt32LE(124048, 32); p.writeInt32LE(78534, 36)
  p.writeUInt32LE(510, 40); p.writeUInt32LE(715, 44)
  p.writeInt32LE(1000, 48); p.writeInt32LE(-2000, 52); p.writeInt32LE(300, 56)
  p.writeInt32LE(2236, 60) // gSpeed mm/s
  p.writeInt32LE(9000000, 64) // headMot 90 deg
  p.writeUInt32LE(69, 68)
  p.writeUInt16LE(96, 76)
  p.writeUInt16LE((3 << 1) | 0x2000 | 0x4000, 78) // corr age bucket 3, authTime, nmaFix
  return p
}

test('NAV-PVT decodes position, velocity, accuracy and flags', () => {
  const { type, data: d } = decode(0x01, 0x07, navPvt())
  assert.equal(type, 'NAV-PVT')
  assert.equal(d.time, '2026-10-30T01:02:03.500Z')
  assert.equal(d.fixType, 3)
  assert.ok(d.gnssFixOK && d.diffSoln)
  assert.equal(d.carrSolnText, 'float')
  assert.equal(d.numSV, 28)
  assert.equal(d.lat, 50.25)
  assert.equal(d.lon, -1.5)
  assert.equal(d.hMSL, 78.534)
  assert.equal(d.hAcc, 0.51)
  assert.equal(d.velD, 0.3)
  assert.equal(d.gSpeed, 2.236)
  assert.ok(Math.abs(d.headMot - Math.PI / 2) < 1e-9)
  assert.equal(d.lastCorrectionAge, 3)
  assert.ok(d.authTime && d.nmaFix)
})

test('NAV-HPPOSLLH adds the high-precision parts', () => {
  const p = Buffer.alloc(36)
  p.writeInt32LE(5, 8); p.writeInt8(7, 24) // lon 5e-7 + 7e-9
  p.writeInt32LE(100, 12); p.writeInt8(-3, 25)
  p.writeInt32LE(1000, 20); p.writeInt8(5, 27) // hMSL 1000.5 mm
  p.writeUInt32LE(12345, 28) // 1.2345 m
  const d = decode(0x01, 0x14, p).data
  assert.ok(Math.abs(d.lon - 5.07e-7) < 1e-15)
  assert.ok(Math.abs(d.lat - 9.997e-6) < 1e-15) // 100e-7 - 3e-9
  assert.equal(d.hMSL, 1.0005)
  assert.equal(d.hAcc, 1.2345)
})

test('NAV-SIG names signals, bands and correction sources', () => {
  const p = Buffer.alloc(8 + 2 * 16)
  p[5] = 2
  // Galileo E6 B, HAS-corrected, used, authenticated
  p[8] = 2; p[9] = 5; p[10] = 8; p[14] = 41; p[15] = 7; p[16] = 12; p.writeUInt16LE(0x08 | 0x200, 18)
  // GPS L5 Q, no corrections, not used
  p[24] = 0; p[25] = 3; p[26] = 7; p[30] = 38; p[31] = 4
  const s = decode(0x01, 0x43, p).data.sigs
  assert.deepEqual(s.map(x => [x.sv, x.gnss, x.signal, x.band, x.corrSource, x.prUsed, x.authenticated]), [
    ['E05', 'Galileo', 'E6 B', 'L6', 'Galileo HAS', true, true],
    ['G03', 'GPS', 'L5 Q', 'L5', 'none', false, false]
  ])
})

test('SEC-SIG decodes jamming and spoofing state per band', () => {
  const p = Buffer.alloc(4 + 2 * 4)
  p[0] = 2; p[1] = 0x01 | (2 << 1) | 0x08 | (1 << 4); p[3] = 2
  p.writeUInt32LE(1575420, 4)
  p.writeUInt32LE(1176450 | 0x1000000, 8)
  const d = decode(0x27, 0x09, p).data
  assert.equal(d.jamStateText, 'warning')
  assert.equal(d.spfStateText, 'none')
  assert.deepEqual(d.bands, [{ centFreqKHz: 1575420, jammed: false }, { centFreqKHz: 1176450, jammed: true }])
})

test('MON-RF handles both 24-byte (v0) and 20-byte (v1) blocks', () => {
  const v0 = Buffer.alloc(4 + 24); v0[0] = 0; v0[1] = 1; v0[6] = 2; v0[7] = 1; v0.writeUInt16LE(78, 16); v0.writeUInt16LE(3534, 18)
  const v1 = Buffer.alloc(4 + 20); v1[0] = 1; v1[1] = 1; v1[5] = 3; v1[6] = 1; v1.writeUInt16LE(60, 16); v1.writeUInt16LE(100, 18)
  const a = decode(0x0a, 0x38, v0).data.blocks[0]
  const b = decode(0x0a, 0x38, v1).data.blocks[0]
  assert.deepEqual([a.antStatusText, a.antPowerText, a.noisePerMS, a.agcCnt], ['ok', 'on', 78, 3534])
  assert.deepEqual([b.antStatusText, b.noisePerMS, b.agcCnt], ['short', 60, 100])
})

test('MON-GNSS lists signal plans', () => {
  const p = Buffer.alloc(4 + 28)
  p[1] = 1; p.writeUInt16LE(0x0102, 2)
  p[4] = 2; p.write('SP2', 5, 'latin1')
  p.writeUInt16LE(0b1101, 4 + 6) // GPS L1C/A, L2C, L5
  p.writeUInt16LE(0b1011, 4 + 8) // Galileo E1, E5a, E6
  const d = decode(0x0a, 0x28, p).data
  assert.equal(d.activePlan, 2)
  assert.deepEqual(d.plans[0], { id: 2, name: 'SP2', signals: { GPS: ['L1C/A', 'L2C', 'L5'], Galileo: ['E1', 'E5a', 'E6'] } })
})

test('MON-VER extracts firmware, protocol and module', () => {
  const p = Buffer.alloc(40 + 3 * 30)
  p.write('EXT HPG 2.11 (c97ee1)', 0, 'latin1'); p.write('000B0000', 30, 'latin1')
  p.write('FWVER=HPG 2.11', 40, 'latin1'); p.write('PROTVER=50.11', 70, 'latin1'); p.write('MOD=ZED-X20P', 100, 'latin1')
  const d = decode(0x0a, 0x04, p).data
  assert.deepEqual([d.firmware, d.protocol, d.module], ['HPG 2.11', '50.11', 'ZED-X20P'])
})

test('unknown messages are ignored', () => {
  assert.equal(decode(0x01, 0x99, Buffer.alloc(4)), null)
})
