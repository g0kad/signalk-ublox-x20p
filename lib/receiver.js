'use strict'
// Receiver session: owns the Device, enables the UBX outputs we need, keeps the latest decoded
// state, signals epoch completion and exposes configuration operations for the API.

const EventEmitter = require('events')
const Device = require('./device')
const cfg = require('./cfg')
const { decode } = require('./decode')
const osnma = require('./osnma')

// UBX messages the plugin needs on USB; value = output rate relative to navigation epochs.
// 'S' = slow messages, throttled to roughly once per second.
const OUTPUTS = {
  'CFG-MSGOUT-UBX_NAV_PVT_USB': 1,
  'CFG-MSGOUT-UBX_NAV_HPPOSLLH_USB': 1,
  'CFG-MSGOUT-UBX_NAV_DOP_USB': 1,
  'CFG-MSGOUT-UBX_NAV_EOE_USB': 1,
  'CFG-MSGOUT-UBX_NAV_SAT_USB': 'S',
  'CFG-MSGOUT-UBX_NAV_SIG_USB': 'S',
  'CFG-MSGOUT-UBX_SEC_SIG_USB': 'S',
  'CFG-MSGOUT-UBX_SEC_OSNMA_USB': 'S',
  'CFG-MSGOUT-UBX_MON_RF_USB': 'S',
  'CFG-MSGOUT-UBX_MON_SYS_USB': 'S',
  'CFG-MSGOUT-UBX_RXM_COR_USB': 1
}

// Keys the plugin sets itself at every connect; ignored by pending changes and restore
const MANAGED = new Set([...Object.keys(OUTPUTS), 'CFG-MSGOUT-UBX_NAV_RELPOSNED_USB'])

const EPOCH_FALLBACK_MS = 2500

// Claimed accuracy of NTP-synchronised host time; generous so the receiver never over-trusts it
const TRUSTED_TIME_ACC_MS = 1000

// True when the kernel clock is disciplined by NTP (systemd-timesyncd / chrony to network servers).
// The kernel drops this flag by itself some hours after NTP is lost, e.g. offshore.
// A chrony reference clock ('#*' = selected refclock) is likely this GNSS itself, which would be circular.
function hostClockSynced () {
  const { execFile } = require('child_process')
  const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 3000 }, (err, out) => resolve(err ? null : out)))
  return Promise.all([run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']), run('chronyc', ['-n', 'sources'])])
    .then(([ntp, chrony]) => !!ntp && ntp.trim() === 'yes' && !(chrony && /^#\*/m.test(chrony)))
}

class Receiver extends EventEmitter {
  constructor ({ path, baudRate, headingFromRelposned, trustedTime, debug }) {
    super()
    this.debug = debug || (() => {})
    this.relposned = !!headingFromRelposned
    this.trustedTimeEnabled = !!trustedTime
    this.trustedTime = null
    this.device = new Device({ path, baudRate, debug: this.debug })
    this.state = {}
    this.info = {}
    this.status = 'starting'
    this.lastEoe = 0
    this.counts = {}
    this.navHz = 1
    this.device.on('ubx', (c, i, p) => this._onUbx(c, i, p))
    this.device.on('connect', () => this._init().catch(e => this._setStatus(`init failed: ${e.message}`, true)))
    this.device.on('disconnect', why => this._setStatus(`disconnected: ${why}`, true))
    this.device.on('status', s => this._setStatus(s, true))
    this.device.on('error', e => this.debug(`parse error: ${e.message}`))
  }

  start () { this.device.open() }
  stop () { clearInterval(this.timeTimer); this.device.close() }

  _setStatus (s, error = false) {
    this.status = s
    this.emit('status', s, error)
  }

  async _init () {
    this._setStatus('connected, identifying receiver')
    this.info.version = decode(0x0a, 0x04, await this.device.poll(0x0a, 0x04)).data
    try { this.info.gnss = decode(0x0a, 0x28, await this.device.poll(0x0a, 0x28)).data } catch (e) { this.info.gnss = null }
    await this.applyOutputs()
    if (this.trustedTimeEnabled) {
      const send = () => this.sendTrustedTime().catch(e => this.debug(`trusted time: ${e.message}`))
      send()
      clearInterval(this.timeTimer)
      this.timeTimer = setInterval(send, 30 * 60 * 1000)
    }
    const v = this.info.version
    this._setStatus(`${v.module || 'receiver'} ${v.firmware || v.sw}, ${this.navHz} Hz`)
    this.emit('ready', this.info)
  }

  // Enable the UBX outputs in RAM only, so a power cycle returns the receiver to its saved state
  async applyOutputs () {
    const [meas, nav] = await this.device.valget(['CFG-RATE-MEAS', 'CFG-RATE-NAV'])
    this.navHz = Math.max(1, Math.round(1000 / (meas.value * (nav.value || 1))))
    const items = Object.entries(OUTPUTS).map(([key, rate]) => ({ key, value: rate === 'S' ? this.navHz : rate }))
    items.push({ key: 'CFG-MSGOUT-UBX_NAV_RELPOSNED_USB', value: this.relposned ? 1 : 0 })
    const supported = new Set((await this.device.valgetTolerant(items.map(i => i.key))).map(i => i.name))
    await this.device.valset(items.filter(i => supported.has(i.key)), cfg.SET_LAYER.RAM)
  }

  _onUbx (cls, id, p) {
    let d
    try { d = decode(cls, id, p) } catch (e) { this.debug(`decode 0x${cls.toString(16)}-0x${id.toString(16)}: ${e.message}`); return }
    if (!d) return
    this.counts[d.type] = (this.counts[d.type] || 0) + 1
    this.state[d.type] = d.data
    d.data._received = Date.now()
    if (d.type === 'NAV-EOE') {
      this.lastEoe = Date.now()
      this.emit('epoch', this.state)
    } else if (d.type === 'NAV-PVT' && Date.now() - this.lastEoe > EPOCH_FALLBACK_MS) {
      // EOE not arriving (e.g. disabled by someone else): fall back to PVT-driven epochs
      this.emit('epoch', this.state)
    } else if (d.type === 'RXM-COR') {
      this.emit('correction', d.data)
    }
  }

  // ---- configuration API ----

  // Values in RAM, flash and default layers. A full wildcard read takes <100 ms, so always read
  // everything and filter, rather than many single-key requests.
  async readConfig (keys) {
    const want = keys && new Set(keys)
    const get = async layer => {
      let items = []
      try { items = await this.device.valget([cfg.ALL_WILDCARD], layer) } catch (e) {
        if (!/NAK/.test(e.message)) throw e // an empty layer NAKs
      }
      return Object.fromEntries(items.filter(i => !want || want.has(i.name)).map(i => [i.name, i.value]))
    }
    const r = { ram: await get(cfg.LAYER.RAM), bbr: await get(cfg.LAYER.BBR), flash: await get(cfg.LAYER.FLASH), def: await get(cfg.LAYER.DEFAULT) }
    // What the receiver will load at power-up: default, overridden by flash, overridden by BBR
    r.saved = { ...r.def, ...r.flash, ...r.bbr }
    return r
  }

  // changes: [{key, value}]. persist: also write to BBR + flash so it survives power cycles.
  async writeConfig (changes, persist) {
    const layers = cfg.SET_LAYER.RAM | (persist ? cfg.SET_LAYER.BBR | cfg.SET_LAYER.FLASH : 0)
    await this.device.valset(changes, layers)
    // A rate change alters how often slow messages should be output
    if (changes.some(c => /^CFG-RATE-/.test(c.key))) await this.applyOutputs()
    if (changes.some(c => /^CFG-SIGNAL-/.test(c.key))) {
      // The receiver restarts its GNSS subsystem after signal changes; refresh plan info shortly after
      setTimeout(() => this.device.poll(0x0a, 0x28).then(p => { this.info.gnss = decode(0x0a, 0x28, p).data }).catch(() => {}), 3000)
    }
  }

  // Persist current RAM values of the given keys to BBR + flash
  async saveToFlash (keys) {
    const { ram, saved } = await this.readConfig(keys)
    const changes = keys.filter(k => k in ram && ram[k] !== saved[k]).map(k => ({ key: k, value: ram[k] }))
    if (changes.length) await this.device.valset(changes, cfg.SET_LAYER.BBR | cfg.SET_LAYER.FLASH)
    return changes
  }

  // Put RAM back to the value the receiver would load at power-up
  async revertRam (keys) {
    const { ram, saved } = await this.readConfig(keys)
    const changes = keys.filter(k => k in ram).map(k => ({ key: k, value: saved[k] }))
      .filter(c => c.value !== undefined && c.value !== ram[c.key])
    if (changes.length) await this.device.valset(changes, cfg.SET_LAYER.RAM)
    return changes
  }

  // Remove saved values so the key returns to factory default at next start (and set RAM to default now)
  async resetToDefault (keys) {
    const { def } = await this.readConfig(keys)
    const p = Buffer.alloc(4 + 4 * keys.length)
    p[0] = 0; p[1] = cfg.SET_LAYER.BBR | cfg.SET_LAYER.FLASH
    keys.forEach((k, i) => p.writeUInt32LE(cfg.keyId(k), 4 + 4 * i))
    await this.device.request(0x06, 0x8c, p) // CFG-VALDEL
    const changes = keys.filter(k => k in def).map(k => ({ key: k, value: def[k] }))
    await this.device.valset(changes, cfg.SET_LAYER.RAM)
    return changes
  }

  // Everything the receiver loads at power-up (flash + BBR), by key ID so undocumented keys survive
  async backup () {
    const read = async layer => {
      try { return await this.device.valget([cfg.ALL_WILDCARD], layer) } catch (e) {
        if (/NAK/.test(e.message)) return []
        throw e
      }
    }
    const pack = items => items.map(i => ({ id: `0x${i.id.toString(16).padStart(8, '0')}`, name: i.name, value: i.value }))
    const v = this.info.version || {}
    return {
      format: 'signalk-ublox-x20p-backup',
      version: 1,
      created: new Date().toISOString(),
      receiver: { module: v.module, firmware: v.firmware, protocol: v.protocol, sw: v.sw },
      flash: pack(await read(cfg.LAYER.FLASH)),
      bbr: pack(await read(cfg.LAYER.BBR))
    }
  }

  // Work out what restoring a backup would change. BBR values win over flash, as at power-up.
  async restorePlan (backup) {
    if (!backup || backup.format !== 'signalk-ublox-x20p-backup') throw new Error('Not a configuration backup from this plugin')
    const wanted = new Map()
    for (const it of [...(backup.flash || []), ...(backup.bbr || [])]) wanted.set(Number(it.id) >>> 0, it)
    const ram = new Map((await this.device.valget([cfg.ALL_WILDCARD])).map(i => [i.id >>> 0, i.value]))
    const plan = { apply: [], unchanged: 0, unsupported: [], forbidden: [] }
    for (const [id, it] of wanted) {
      const def = cfg.lookup(id)
      const name = def ? def.name : it.name
      if (MANAGED.has(name)) continue
      if (cfg.FORBIDDEN.has(name)) plan.forbidden.push(name)
      else if (!ram.has(id)) plan.unsupported.push(name)
      else if (String(ram.get(id)) === String(it.value)) plan.unchanged++
      else plan.apply.push({ id, name, title: def && def.title, from: ram.get(id), to: it.value })
    }
    const v = this.info.version || {}
    plan.warnings = []
    if (backup.receiver && backup.receiver.module && v.module && backup.receiver.module !== v.module) {
      plan.warnings.push(`Backup is from a ${backup.receiver.module}, this receiver is a ${v.module}`)
    }
    if (backup.receiver && backup.receiver.firmware && v.firmware && backup.receiver.firmware !== v.firmware) {
      plan.warnings.push(`Backup was made on firmware ${backup.receiver.firmware}, receiver now runs ${v.firmware}`)
    }
    return plan
  }

  // Write the planned values to RAM + BBR + flash. If a batch is rejected, retry key by key.
  async restore (backup) {
    const plan = await this.restorePlan(backup)
    const items = plan.apply.map(a => ({ key: a.id, value: a.to }))
    const layers = cfg.SET_LAYER.RAM | cfg.SET_LAYER.BBR | cfg.SET_LAYER.FLASH
    const failed = []
    try { await this.device.valset(items, layers) } catch (e) {
      if (!/NAK/.test(e.message)) throw e
      for (const it of items) {
        try { await this.device.valset([it], layers) } catch (e2) { failed.push(plan.apply.find(a => a.id === it.key).name) }
      }
    }
    await this.applyOutputs()
    return { ...plan, failed, restored: plan.apply.length - failed.length }
  }

  // ---- Galileo OSNMA ----

  // files: [{name, text}] from GSC. Loads the Merkle root and the public key the satellites are using.
  async loadOsnmaKeys (files) {
    const found = { publicKeys: [], treeNodes: {} }
    for (const f of files) {
      const r = osnma.parseGscFile(f.text, f.name)
      if (r.merkleRoot) { found.merkleRoot = r.merkleRoot; Object.assign(found.treeNodes, r.treeNodes) }
      found.publicKeys.push(...r.publicKeys)
    }
    const inUse = this.state['SEC-OSNMA'] && this.state['SEC-OSNMA'].pubKeyId
    const keys = found.publicKeys.filter(k => Number.isInteger(k.pkid))
    const key = keys.find(k => k.pkid === inUse) || keys.sort((a, b) => b.pkid - a.pkid)[0]
    if (!found.merkleRoot && !key) throw new Error('No usable Merkle root or public key in the files')
    let proof = null
    if (key && found.merkleRoot) {
      // the leaf index may only be given in one of the files
      const leaf = found.publicKeys.find(k => k.pkid === key.pkid && Number.isInteger(k.leaf))
      proof = osnma.verifyKeyInTree({ ...key, leaf: leaf && leaf.leaf }, found.treeNodes, found.merkleRoot)
      if (proof === false) throw new Error(`Public key ID ${key.pkid} does not match the Merkle tree root: files are inconsistent or corrupted, nothing sent`)
    }
    // Root first: a new current root invalidates keys verified against the old one
    if (found.merkleRoot) this.device.send(0x13, 0x02, osnma.merklePayload(found.merkleRoot))
    if (key) this.device.send(0x13, 0x02, osnma.pubKeyPayload(key))
    await new Promise(resolve => setTimeout(resolve, 3000))
    const st = decode(0x27, 0x0a, await this.device.poll(0x27, 0x0a)).data
    return {
      sent: { merkleRoot: !!found.merkleRoot, pubKeyId: key ? key.pkid : null, satellitesUse: inUse || null },
      keyVerifiedAgainstRoot: proof,
      keysInFiles: found.publicKeys.map(k => k.pkid),
      receiver: { merkleRootSrc: st.merkleRootSrc, merkleRootValid: st.merkleRootValid, pubKeySrc: st.pubKeySrc, pubKeyValid: st.pubKeyValid }
    }
  }

  // Send the host clock as trusted time, but only while it is NTP-synchronised to the network.
  async sendTrustedTime () {
    const sync = await hostClockSynced()
    this.trustedTime = { at: new Date().toISOString(), hostSynced: sync, sent: false }
    if (!sync) return this.trustedTime
    this.device.send(0x13, 0x40, osnma.trustedTimePayload(new Date(), TRUSTED_TIME_ACC_MS))
    this.trustedTime.sent = true
    return this.trustedTime
  }

  // GNSS restart: hot keeps everything, warm clears ephemeris, cold clears all navigation data
  async restart (type) {
    const mask = { hot: 0x0000, warm: 0x0001, cold: 0xffff }[type]
    if (mask === undefined) throw new Error('restart type must be hot, warm or cold')
    const p = Buffer.alloc(4)
    p.writeUInt16LE(mask, 0); p[2] = 0x02 // controlled GNSS-only software reset; no ACK is sent
    this.device.send(0x06, 0x04, p)
  }
}

module.exports = { Receiver, OUTPUTS, MANAGED }
