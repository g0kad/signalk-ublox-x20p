'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const cfg = require('../lib/cfg')

test('key database resolves names and ids both ways', () => {
  assert.equal(cfg.keyId('CFG-NAVSPG-DYNMODEL'), 0x20110021)
  assert.equal(cfg.lookup(0x20110021).name, 'CFG-NAVSPG-DYNMODEL')
  assert.equal(cfg.lookup('CFG-NAVCOR-ENABLE_GAL_HAS').id, 0x100d0002)
  assert.ok(cfg.lookup('CFG-NAVSPG-DYNMODEL').consts.some(c => c.name === 'SEA' && c.value === 5))
  // "Portable" has an empty value in u-blox's JSON; it must decode as 0
  assert.ok(cfg.lookup('CFG-NAVSPG-DYNMODEL').consts.some(c => c.name === 'PORT' && c.value === 0))
  assert.throws(() => cfg.keyId('CFG-NOPE-NOPE'))
})

test('value size comes from the key id', () => {
  assert.equal(cfg.sizeOfId(0x10770001), 1) // L
  assert.equal(cfg.sizeOfId(0x20110021), 1) // E1
  assert.equal(cfg.sizeOfId(0x30210001), 2) // U2
  assert.equal(cfg.sizeOfId(0x40520001), 4) // U4
  assert.equal(cfg.sizeOfId(0x50360006), 8) // X8
})

test('VALSET payload encodes typed values and VALGET response decodes them', () => {
  const items = [
    { key: 'CFG-NAVSPG-DYNMODEL', value: 5 },
    { key: 'CFG-RATE-MEAS', value: 200 },
    { key: 'CFG-UART1-BAUDRATE', value: 460800 },
    { key: 'CFG-NAVSPG-INFIL_MINELEV', value: -5 },
    { key: 'CFG-NAVCOR-ENABLE_GAL_HAS', value: true }
  ]
  const p = cfg.valsetPayload(items, cfg.SET_LAYER.RAM | cfg.SET_LAYER.FLASH)
  assert.equal(p[1], 0x05)
  // A VALGET response has the same item layout after its 4-byte header
  const parsed = cfg.parseValget(p).items
  assert.deepEqual(parsed.map(i => [i.name, i.value]), items.map(i => [i.key, i.value]))
})

test('the configuration lockdown keys can never be written', () => {
  assert.throws(() => cfg.valsetPayload([{ key: 'CFG-SEC-CFG_LOCK', value: true }]), /Refusing/)
})

test('VALGET payload carries layer, position and wildcard keys', () => {
  const p = cfg.valgetPayload([cfg.ALL_WILDCARD], cfg.LAYER.FLASH, 64)
  assert.equal(p[1], 2)
  assert.equal(p.readUInt16LE(2), 64)
  assert.equal(p.readUInt32LE(4), 0x0fffffff)
  assert.equal(cfg.groupWildcard('CFG-SIGNAL-GPS_ENA'), 0x1031ffff)
})
