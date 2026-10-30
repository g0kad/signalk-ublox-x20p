#!/usr/bin/env node
// Read-only probe: polls MON-VER and a few config keys, then summarises
// what the receiver is currently outputting. Changes no receiver settings.
// Usage: node probe.js [/dev/ttyACM0] [seconds]
'use strict'
const fs = require('fs')

const dev = process.argv[2] || '/dev/ttyACM0'
const seconds = Number(process.argv[3] || 5)

function ubxFrame (cls, id, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(8 + payload.length)
  b[0] = 0xb5; b[1] = 0x62; b[2] = cls; b[3] = id
  b.writeUInt16LE(payload.length, 4)
  payload.copy(b, 6)
  let a = 0, c = 0
  for (let i = 2; i < 6 + payload.length; i++) { a = (a + b[i]) & 0xff; c = (c + a) & 0xff }
  b[6 + payload.length] = a; b[7 + payload.length] = c
  return b
}

// CFG-VALGET (0x06 0x8b): version 0, layer 0 (RAM), position 0, then key IDs
function valget (keys) {
  const p = Buffer.alloc(4 + 4 * keys.length)
  keys.forEach((k, i) => p.writeUInt32LE(k, 4 + 4 * i))
  return ubxFrame(0x06, 0x8b, p)
}

const KEYS = {
  0x20110021: 'CFG-NAVSPG-DYNMODEL',
  0x30210001: 'CFG-RATE-MEAS',
  0x10770001: 'CFG-USBINPROT-UBX',
  0x10770002: 'CFG-USBINPROT-NMEA',
  0x10780001: 'CFG-USBOUTPROT-UBX',
  0x10780002: 'CFG-USBOUTPROT-NMEA',
  0x10310021: 'CFG-SIGNAL-GAL_ENA',
  0x10310020: 'CFG-SIGNAL-SBAS_ENA',
  0x10310009: 'CFG-SIGNAL-GAL_E6_ENA'
}

// Raw mode: cooked TTY would translate CR/LF and echo bytes back to the receiver
require('child_process').execFileSync('stty', ['-F', dev, 'raw', '-echo'])
const fd = fs.openSync(dev, fs.constants.O_RDWR | fs.constants.O_NOCTTY)
const stream = fs.createReadStream(null, { fd, autoClose: false })
let buf = Buffer.alloc(0)
const ubxSeen = {}, nmeaSeen = {}

function handleUbx (cls, id, p) {
  const key = `${cls.toString(16).padStart(2, '0')}-${id.toString(16).padStart(2, '0')}`
  ubxSeen[key] = (ubxSeen[key] || 0) + 1
  if (cls === 0x0a && id === 0x04) { // MON-VER
    const str = (o, n) => p.subarray(o, o + n).toString('latin1').replace(/\0.*$/s, '')
    console.log('MON-VER sw:', str(0, 30), '| hw:', str(30, 10))
    for (let o = 40; o + 30 <= p.length; o += 30) console.log('  ext:', str(o, 30))
  } else if (cls === 0x06 && id === 0x8b) { // CFG-VALGET response
    let o = 4
    while (o + 4 <= p.length) {
      const k = p.readUInt32LE(o); o += 4
      const size = [0, 1, 1, 2, 4, 8][(k >>> 28) & 0x7]
      const v = size === 8 ? p.readBigUInt64LE(o) : p.readUIntLE(o, size)
      o += size
      console.log(`  ${KEYS[k] || '0x' + k.toString(16)} = ${v}`)
    }
  } else if (cls === 0x01 && id === 0x07) { // NAV-PVT
    const flags = p[21]
    console.log('NAV-PVT fixType', p[20], 'gnssFixOK', flags & 1, 'diffSoln', (flags >> 1) & 1,
      'carrSoln', flags >> 6, 'numSV', p[23],
      'hAcc', p.readUInt32LE(40) / 1000, 'm vAcc', p.readUInt32LE(44) / 1000, 'm',
      'lat', p.readInt32LE(28) / 1e7, 'lon', p.readInt32LE(24) / 1e7)
  } else if (cls === 0x01 && id === 0x43) { // NAV-SIG
    const gnss = ['GPS', 'SBAS', 'GAL', 'BDS', 'IMES', 'QZSS', 'GLO', 'NavIC']
    const bySig = {}, byCorr = {}
    let used = 0
    for (let o = 8; o + 16 <= p.length; o += 16) {
      const k = `${gnss[p[o]] || p[o]}/sig${p[o + 2]}`
      const sf = p.readUInt16LE(o + 10)
      bySig[k] = (bySig[k] || 0) + 1
      if (sf & 0x08) used++
      byCorr[p[o + 8]] = (byCorr[p[o + 8]] || 0) + 1
    }
    console.log('NAV-SIG signals', p[5], 'prUsed', used, '\n  by gnss/sigId', bySig, '\n  by corrSource', byCorr)
  } else if (cls === 0x0a && id === 0x38) { // MON-RF
    for (let o = 4; o + 24 <= p.length; o += 24) {
      console.log('MON-RF block', p[o], 'jamState', p[o + 1] & 3, 'antStatus', p[o + 2], 'antPower', p[o + 3],
        'noise', p.readUInt16LE(o + 12), 'agc', p.readUInt16LE(o + 14), 'cwSupp', p[o + 16])
    }
  } else if (cls === 0x27) {
    console.log(`SEC ${id.toString(16)} len ${p.length}:`, p.toString('hex'))
  } else if (cls === 0x05) {
    console.log(`ACK-${id ? 'ACK' : 'NAK'} for ${p[0].toString(16)}-${p[1].toString(16)}`)
  }
}

stream.on('data', chunk => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const u = buf.indexOf(Buffer.from([0xb5, 0x62]))
    const n = buf.indexOf(0x24) // '$'
    if (u < 0 && n < 0) { buf = Buffer.alloc(0); return }
    if (u >= 0 && (n < 0 || u < n)) {
      if (buf.length < u + 6) { buf = buf.subarray(u); return }
      const len = buf.readUInt16LE(u + 4)
      if (buf.length < u + 8 + len) { buf = buf.subarray(u); return }
      handleUbx(buf[u + 2], buf[u + 3], buf.subarray(u + 6, u + 6 + len))
      buf = buf.subarray(u + 8 + len)
    } else {
      const e = buf.indexOf(0x0a, n)
      if (e < 0) { buf = buf.subarray(n); return }
      const line = buf.subarray(n, e).toString('latin1').trim()
      const t = line.slice(1, 6)
      nmeaSeen[t] = (nmeaSeen[t] || 0) + 1
      if (t.endsWith('TXT')) console.log('TXT:', line)
      buf = buf.subarray(e + 1)
    }
  }
})

fs.writeSync(fd, ubxFrame(0x0a, 0x04))
// One-shot polls (empty payload) of navigation/monitor/security messages
;[[0x01, 0x07], [0x01, 0x43], [0x0a, 0x38], [0x27, 0x09], [0x27, 0x0a]].forEach(([c, i], n) =>
  setTimeout(() => fs.writeSync(fd, ubxFrame(c, i)), 2000 + 200 * n))
// One key per request: an unknown key NAKs the whole VALGET
Object.keys(KEYS).forEach((k, i) =>
  setTimeout(() => fs.writeSync(fd, valget([Number(k)])), 300 + 150 * i))

setTimeout(() => {
  console.log(`\nIn ${seconds}s — NMEA sentences:`, nmeaSeen)
  console.log('UBX messages (cls-id):', ubxSeen)
  stream.destroy(); fs.closeSync(fd); process.exit(0)
}, seconds * 1000)
