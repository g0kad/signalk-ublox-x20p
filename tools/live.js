#!/usr/bin/env node
// Dev harness: exercises lib/ against a real receiver without Signal K. Read-only (polls + VALGET).
// Usage: node tools/live.js [/dev/ttyACM0]
'use strict'
const Device = require('../lib/device')
const { decode } = require('../lib/decode')
const cfg = require('../lib/cfg')

const dev = new Device({ path: process.argv[2] || '/dev/ttyACM0', debug: console.log })
const show = (cls, id, p) => { const d = decode(cls, id, p); return d ? d.data : p }

dev.on('connect', async () => {
  try {
    console.log('MON-VER', show(0x0a, 0x04, await dev.poll(0x0a, 0x04)))
    console.log('MON-GNSS', JSON.stringify(show(0x0a, 0x28, await dev.poll(0x0a, 0x28)), null, 1))
    const sig = await dev.valget([cfg.groupWildcard('CFG-SIGNAL-GPS_ENA')])
    console.log('CFG-SIGNAL (RAM):', sig.map(i => `${i.name}=${i.value}`).join(' '))
    const nav = await dev.valgetTolerant(['CFG-NAVCOR-ENABLE_GAL_HAS', 'CFG-GAL-USE_OSNMA', 'CFG-SEC-JAMDET_SENSITIVITY_HI', 'CFG-NAVSPG-USE_PPP', 'CFG-ITFM-ENABLE', 'CFG-NMEA-PROTVER', 'CFG-NMEA-HIGHPREC'])
    console.log('misc:', nav.map(i => `${i.name}=${i.value}`).join(' '))
    const all = await dev.valget([cfg.ALL_WILDCARD])
    const unknown = all.filter(i => i.name.startsWith('0x'))
    console.log(`all keys on device: ${all.length}, not in DB: ${unknown.length}`, unknown.slice(0, 10).map(i => i.name).join(' '))
    const groups = {}
    for (const i of all) { const g = i.name.split('-')[1] || '?'; groups[g] = (groups[g] || 0) + 1 }
    console.log('groups on device:', JSON.stringify(groups))
    for (const [c, i] of [[0x01, 0x07], [0x01, 0x14], [0x01, 0x04], [0x27, 0x09], [0x27, 0x0a], [0x0a, 0x38], [0x0a, 0x39], [0x01, 0x03]]) {
      try { console.log(JSON.stringify(decode(c, i, await dev.poll(c, i)))) } catch (e) { console.log('poll', c, i, e.message) }
    }
    const s = decode(0x01, 0x43, await dev.poll(0x01, 0x43)).data.sigs
    const bands = {}
    for (const x of s) { const k = `${x.gnss} ${x.signal} (${x.band})`; bands[k] = bands[k] || [0, 0]; bands[k][0]++; if (x.prUsed) bands[k][1]++ }
    console.log('signals tracked/used:', bands)
    console.log('parser stats', dev.parser.stats)
  } catch (e) { console.error('ERROR', e) }
  dev.close()
})
dev.on('status', s => console.log(s))
dev.open()
