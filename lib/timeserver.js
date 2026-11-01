'use strict'
// A minimal NTP server on localhost that serves the receiver's time, so chrony (or ntpd) can
// keep the computer's clock right where there is no network time, e.g. offshore.
//
// Each NAV-PVT gives the GNSS time of its epoch. It reaches us some milliseconds later (the
// receiver computes the solution, then USB delivers it), so the true time on arrival is the
// epoch time plus that delay. The offset between that and the host clock is kept as the median
// of recent samples; replies are the host clock plus the offset. Accuracy is a few milliseconds
// to tens of milliseconds: ample for logging, not a substitute for a PPS line.

const dgram = require('dgram')

const NTP_EPOCH_OFFSET_S = 2208988800 // 1900-01-01 to 1970-01-01
const SAMPLES = 16
const STALE_MS = 5000 // no valid sample for this long: report unsynchronised
const MAX_TACC_S = 1e-3
const RESET_MS = 1000 // a sample this far from the median means the host clock was stepped: start again

function writeTimestamp (buf, offset, ms) {
  const s = Math.floor(ms / 1000)
  buf.writeUInt32BE((s + NTP_EPOCH_OFFSET_S) >>> 0, offset)
  buf.writeUInt32BE(Math.floor(((ms - s * 1000) / 1000) * 0x100000000) >>> 0, offset + 4)
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2 }

class TimeServer {
  constructor ({ port = 12300, host = '127.0.0.1', delayMs = 0, now = Date.now, debug = () => {} } = {}) {
    Object.assign(this, { port, host, delayMs, now, debug })
    this.offsets = []
    this.lastSample = 0
    this.lastTime = 0 // corrected host time of the last sample
    this.served = 0
    this.socket = null
  }

  // Add one NAV-PVT, received at host time receivedMs. Only a valid, accurate time counts.
  sample (pvt, receivedMs) {
    if (!pvt || !pvt.timeValid || !pvt.time || !pvt.gnssFixOK || !(pvt.tAcc <= MAX_TACC_S)) return false
    const offset = Date.parse(pvt.time) + this.delayMs - receivedMs
    if (this.offsets.length && Math.abs(offset - median(this.offsets)) > RESET_MS) this.offsets = []
    this.offsets.push(offset)
    if (this.offsets.length > SAMPLES) this.offsets.shift()
    this.lastSample = receivedMs
    this.lastTime = receivedMs + offset
    return true
  }

  // Milliseconds to add to the host clock, or null while there is no recent valid time
  offsetMs () {
    if (!this.offsets.length || this.now() - this.lastSample > STALE_MS) return null
    return median(this.offsets)
  }

  // Spread of recent offsets (median absolute deviation), ms
  jitterMs () {
    if (this.offsets.length < 2) return 0
    const m = median(this.offsets)
    return median(this.offsets.map(o => Math.abs(o - m)))
  }

  // The 48-byte server reply to a client request, or null if the request isn't an NTP client packet
  reply (req, recvHostMs) {
    if (!req || req.length < 48 || (req[0] & 0x07) !== 3) return null
    const version = (req[0] >> 3) & 0x07
    const off = this.offsetMs()
    const r = Buffer.alloc(48)
    if (off === null) {
      r[0] = (3 << 6) | (version << 3) | 4 // leap 3: unsynchronised, so clients ignore us
      r[1] = 16
    } else {
      r[0] = (version << 3) | 4
      r[1] = 1 // stratum 1: a reference clock
      // root dispersion: jitter plus a millisecond of margin, NTP short format (16.16 s)
      r.writeUInt32BE(Math.min(0xffffffff, Math.round((this.jitterMs() + 1) / 1000 * 65536)), 8)
      r.write('GNSS', 12, 'ascii')
      writeTimestamp(r, 16, this.lastTime)
      writeTimestamp(r, 32, recvHostMs + off)
    }
    r[2] = req[2] // poll
    r[3] = -10 & 0xff // precision about 1 ms
    req.copy(r, 24, 40, 48) // origin = client's transmit timestamp
    if (off !== null) writeTimestamp(r, 40, this.now() + off)
    return r
  }

  start () {
    this.socket = dgram.createSocket(this.host.includes(':') ? 'udp6' : 'udp4')
    this.socket.on('message', (msg, rinfo) => {
      const r = this.reply(msg, this.now())
      if (!r) return
      this.served++
      this.socket.send(r, rinfo.port, rinfo.address)
    })
    this.socket.on('error', e => this.debug(`time server: ${e.message}`))
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.bind(this.port, this.host, () => { this.socket.off('error', reject); resolve() })
    })
  }

  stop () {
    if (this.socket) this.socket.close()
    this.socket = null
  }

  status () {
    const off = this.offsetMs()
    return {
      listening: !!this.socket, address: `${this.host}:${this.port}`, synced: off !== null,
      offsetMs: off === null ? null : Number(off.toFixed(1)), jitterMs: Number(this.jitterMs().toFixed(1)),
      delayMs: this.delayMs, samples: this.offsets.length, served: this.served
    }
  }
}

module.exports = { TimeServer, NTP_EPOCH_OFFSET_S }
