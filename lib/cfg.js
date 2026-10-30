'use strict'
// Configuration key database and CFG-VALGET / CFG-VALSET encoding.

const db = require('./data/cfg-keys.json')

const byId = new Map()
for (const [name, k] of Object.entries(db.keys)) byId.set(k.id >>> 0, { name, ...k })

const LAYER = { RAM: 0, BBR: 1, FLASH: 2, DEFAULT: 7 }
const SET_LAYER = { RAM: 0x01, BBR: 0x02, FLASH: 0x04 }

// Keys that must never be written from this plugin: they can permanently lock or brick configuration.
const FORBIDDEN = new Set(['CFG-SEC-CFG_LOCK', 'CFG-SEC-CFG_LOCK_UNLOCKGRP1', 'CFG-SEC-CFG_LOCK_UNLOCKGRP2'])

const sizeOfId = id => [0, 1, 1, 2, 4, 8][(id >>> 28) & 0x7] || 0

function lookup (nameOrId) {
  if (typeof nameOrId === 'number') return byId.get(nameOrId >>> 0)
  const k = db.keys[nameOrId]
  return k && { name: nameOrId, ...k }
}

function keyId (nameOrId) {
  if (typeof nameOrId === 'number') return nameOrId >>> 0
  const k = db.keys[nameOrId]
  if (!k) throw new Error(`Unknown config key ${nameOrId}`)
  return k.id >>> 0
}

function readValue (buf, off, id) {
  const def = byId.get(id)
  const type = def ? def.type : null
  switch (sizeOfId(id)) {
    case 1:
      if (type === 'L') return buf[off] !== 0
      return type === 'I1' ? buf.readInt8(off) : buf[off]
    case 2: return type === 'I2' ? buf.readInt16LE(off) : buf.readUInt16LE(off)
    case 4:
      if (type === 'R4') return buf.readFloatLE(off)
      return type === 'I4' ? buf.readInt32LE(off) : buf.readUInt32LE(off)
    case 8: {
      if (type === 'R8') return buf.readDoubleLE(off)
      const v = type === 'I8' ? buf.readBigInt64LE(off) : buf.readBigUInt64LE(off)
      return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
    }
  }
  throw new Error(`Bad key size for 0x${id.toString(16)}`)
}

function writeValue (buf, off, id, value) {
  const type = (byId.get(id) || {}).type
  switch (sizeOfId(id)) {
    case 1:
      if (type === 'L' || typeof value === 'boolean') { buf[off] = value ? 1 : 0; return }
      if (type === 'I1') buf.writeInt8(Number(value), off); else buf.writeUInt8(Number(value), off)
      return
    case 2:
      if (type === 'I2') buf.writeInt16LE(Number(value), off); else buf.writeUInt16LE(Number(value), off)
      return
    case 4:
      if (type === 'R4') buf.writeFloatLE(Number(value), off)
      else if (type === 'I4') buf.writeInt32LE(Number(value), off)
      else buf.writeUInt32LE(Number(value) >>> 0, off)
      return
    case 8:
      if (type === 'R8') buf.writeDoubleLE(Number(value), off)
      else if (type === 'I8') buf.writeBigInt64LE(BigInt(value), off)
      else buf.writeBigUInt64LE(BigInt(value), off)
      return
  }
  throw new Error(`Bad key size for 0x${id.toString(16)}`)
}

// CFG-VALGET poll payload. keys: up to 64 ids (wildcards allowed), position: skip count for paging.
function valgetPayload (keys, layer = LAYER.RAM, position = 0) {
  const p = Buffer.alloc(4 + 4 * keys.length)
  p[0] = 0; p[1] = layer; p.writeUInt16LE(position, 2)
  keys.forEach((k, i) => p.writeUInt32LE(keyId(k), 4 + 4 * i))
  return p
}

// Parse a CFG-VALGET response into [{id, name, value}]
function parseValget (p) {
  const out = []
  let o = 4
  while (o + 4 <= p.length) {
    const id = p.readUInt32LE(o); o += 4
    const size = sizeOfId(id)
    if (!size || o + size > p.length) break
    const def = byId.get(id)
    out.push({ id, name: def ? def.name : `0x${id.toString(16).padStart(8, '0')}`, value: readValue(p, o, id) })
    o += size
  }
  return { layer: p[1], position: p.readUInt16LE(2), items: out }
}

// CFG-VALSET payload. items: [{key, value}], layers: bitmask of SET_LAYER.
function valsetPayload (items, layers = SET_LAYER.RAM) {
  const ids = items.map(it => keyId(it.key))
  for (const it of items) {
    const name = lookup(keyId(it.key))?.name
    if (FORBIDDEN.has(name)) throw new Error(`Refusing to write ${name}`)
  }
  const len = 4 + ids.reduce((s, id) => s + 4 + sizeOfId(id), 0)
  const p = Buffer.alloc(len)
  p[0] = 0; p[1] = layers
  let o = 4
  ids.forEach((id, i) => {
    p.writeUInt32LE(id, o); o += 4
    writeValue(p, o, id, items[i].value); o += sizeOfId(id)
  })
  return p
}

// Wildcard for every item in the group of the given key
const groupWildcard = id => ((keyId(id) & 0x0fff0000) | 0xffff) >>> 0
const ALL_WILDCARD = 0x0fffffff

module.exports = {
  db, lookup, keyId, sizeOfId, readValue, writeValue,
  valgetPayload, parseValget, valsetPayload, groupWildcard, ALL_WILDCARD,
  LAYER, SET_LAYER, FORBIDDEN
}
