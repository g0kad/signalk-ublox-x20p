#!/usr/bin/env node
// Builds lib/data/cfg-keys.json from u-blox's official interface description JSON files
// (https://github.com/u-blox/u-blox-X20-interface-description-json, use/copy/modify/distribute
// permitted per that repository's README). Files are merged oldest first, so keys present in any
// listed firmware are known, with the newest description winning.
// Usage: node tools/build-cfgdb.js u-blox-X20-HPG-2.02.json u-blox-X20-HPG-2.10.json u-blox-X20-HPG-2.11.json
'use strict'
const fs = require('fs')
const path = require('path')

const files = process.argv.slice(2)
if (!files.length) { console.error('Give one or more interface description JSON files, oldest first'); process.exit(1) }

const out = { source: [], groups: {}, keys: {} }

// Constant values are strings, sometimes hex, occasionally empty (meaning 0)
const num = v => (v === '' || v === undefined) ? 0 : Number(v)

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  out.source.push(j.meta.firmware.scope)
  for (const [gname, g] of Object.entries(j.configuration)) {
    out.groups[gname] = { title: g.title || gname, desc: g.description || '' }
    for (const [iname, it] of Object.entries(g.items || {})) {
      const e = { id: parseInt(it.configKey, 16) >>> 0, type: it.type, title: it.title || '' }
      if (it.description) e.desc = it.description
      if (it.scale) e.scale = it.scale
      if (it.unit) e.unit = it.unit
      if (it.constants) {
        e.consts = Object.entries(it.constants).map(([name, c]) => ({ name, value: num(c.value), title: c.title || name }))
      }
      out.keys[`CFG-${gname}-${iname}`] = e
    }
  }
}

const dest = path.join(__dirname, '..', 'lib', 'data', 'cfg-keys.json')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(out))
console.log(`${Object.keys(out.keys).length} keys in ${Object.keys(out.groups).length} groups from ${out.source.join(', ')} -> ${dest}`)
