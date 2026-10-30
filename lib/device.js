'use strict'
// Serial connection to the receiver with auto-reconnect and a serialised request/response queue.

const EventEmitter = require('events')
const ubx = require('./ubx')
const cfg = require('./cfg')

const RECONNECT_MS = 5000

class Device extends EventEmitter {
  constructor ({ path, baudRate = 38400, debug = () => {} }) {
    super()
    this.path = path
    this.baudRate = baudRate
    this.debug = debug
    this.port = null
    this.connected = false
    this.stopped = false
    this.queue = Promise.resolve()
    this.pending = null
    this.parser = new ubx.Parser({
      onUbx: (cls, id, p) => this._onUbx(cls, id, p),
      onNmea: line => this.emit('nmea', line),
      onError: e => this.emit('error', e)
    })
  }

  open () {
    this.stopped = false
    const { SerialPort } = require('serialport')
    const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false })
    this.port = port
    port.on('data', d => this.parser.push(d))
    port.on('close', () => this._lost('closed'))
    port.on('error', e => this._lost(e.message))
    port.open(err => {
      if (err) return this._lost(err.message)
      this.connected = true
      this.debug(`opened ${this.path}`)
      this.emit('connect')
    })
  }

  _lost (why) {
    if (this.connected) this.emit('disconnect', why)
    this.connected = false
    if (this.pending) this.pending.reject(new Error(`Port ${why}`))
    if (this.port) { this.port.removeAllListeners(); try { this.port.close(() => {}) } catch (e) {} }
    this.port = null
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.open(), RECONNECT_MS)
    this.emit('status', `waiting for ${this.path}: ${why}`)
  }

  close () {
    this.stopped = true
    clearTimeout(this.retryTimer)
    if (this.port) { this.port.removeAllListeners(); try { this.port.close(() => {}) } catch (e) {} }
    this.port = null
    this.connected = false
  }

  write (buf) {
    if (!this.port || !this.connected) throw new Error('Receiver not connected')
    this.port.write(buf)
  }

  send (cls, id, payload) { this.write(ubx.frame(cls, id, payload)) }

  _onUbx (cls, id, p) {
    const pend = this.pending
    if (pend) {
      if (cls === ubx.CLS.ACK && p.length >= 2 && p[0] === pend.cls && p[1] === pend.id) {
        if (id === 0x00) pend.reject(new Error(`NAK for 0x${pend.cls.toString(16)}-0x${pend.id.toString(16)}`))
        else pend.resolve(pend.data)
      } else if (cls === pend.cls && id === pend.id && pend.wantData) {
        pend.data.push(p)
        if (!pend.wantAck) pend.resolve(pend.data)
      }
    }
    this.emit('ubx', cls, id, p)
  }

  // Serialised request. wantData: wait for a message of the same class/id; wantAck: wait for ACK-ACK/NAK.
  request (cls, id, payload, { wantData = false, wantAck = true, timeout = 2000 } = {}) {
    const run = () => new Promise((resolve, reject) => {
      const done = fn => v => { clearTimeout(t); this.pending = null; fn(v) }
      const t = setTimeout(() => done(reject)(new Error(`Timeout waiting for 0x${cls.toString(16)}-0x${id.toString(16)}`)), timeout)
      this.pending = { cls, id, wantData, wantAck, data: [], resolve: done(resolve), reject: done(reject) }
      try { this.send(cls, id, payload) } catch (e) { this.pending.reject(e) }
    })
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  poll (cls, id, payload) {
    return this.request(cls, id, payload, { wantData: true, wantAck: false }).then(d => d[0])
  }

  // Read config values. Wildcards are paged 64 items at a time.
  async valget (keys, layer = cfg.LAYER.RAM) {
    const out = []
    for (let i = 0; i < keys.length; i += 64) {
      const chunk = keys.slice(i, i + 64)
      const wildcard = chunk.some(k => (cfg.keyId(k) & 0xffff) === 0xffff || (cfg.keyId(k) & 0x0fff0000) === 0x0fff0000)
      let position = 0
      for (;;) {
        const resp = await this.request(ubx.CLS.CFG, 0x8b, cfg.valgetPayload(chunk, layer, position), { wantData: true })
        const items = resp.flatMap(p => cfg.parseValget(p).items)
        out.push(...items)
        if (!wildcard || items.length < 64) break
        position += items.length
      }
    }
    return out
  }

  // Read individual keys one by one so that an unsupported key doesn't fail the whole set.
  async valgetTolerant (keys, layer = cfg.LAYER.RAM) {
    try { return await this.valget(keys, layer) } catch (e) {
      if (!/NAK/.test(e.message)) throw e
    }
    const out = []
    for (const k of keys) {
      try { out.push(...await this.valget([k], layer)) } catch (e) {
        if (!/NAK/.test(e.message)) throw e
      }
    }
    return out
  }

  async valset (items, layers = cfg.SET_LAYER.RAM) {
    for (let i = 0; i < items.length; i += 64) {
      await this.request(ubx.CLS.CFG, 0x8a, cfg.valsetPayload(items.slice(i, i + 64), layers))
    }
  }
}

module.exports = Device
