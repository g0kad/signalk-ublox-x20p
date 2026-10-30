'use strict'
// UBX framing: frame builder and a streaming parser that also splits out NMEA lines.

const SYNC1 = 0xb5
const SYNC2 = 0x62
const MAX_PAYLOAD = 8192

function checksum (buf, start, end) {
  let a = 0, b = 0
  for (let i = start; i < end; i++) { a = (a + buf[i]) & 0xff; b = (b + a) & 0xff }
  return [a, b]
}

function frame (cls, id, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(8 + payload.length)
  b[0] = SYNC1; b[1] = SYNC2; b[2] = cls; b[3] = id
  b.writeUInt16LE(payload.length, 4)
  payload.copy(b, 6)
  const [ca, cb] = checksum(b, 2, 6 + payload.length)
  b[6 + payload.length] = ca; b[7 + payload.length] = cb
  return b
}

// Feed raw bytes; calls onUbx(cls, id, payload) and onNmea(line) for complete, valid messages.
class Parser {
  constructor ({ onUbx, onNmea, onError }) {
    this.onUbx = onUbx
    this.onNmea = onNmea || (() => {})
    this.onError = onError || (() => {})
    this.buf = Buffer.alloc(0)
    this.stats = { ubx: 0, nmea: 0, badChecksum: 0, discarded: 0 }
  }

  push (chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let pos = 0
    const buf = this.buf
    while (pos < buf.length) {
      const c = buf[pos]
      if (c === SYNC1) {
        if (pos + 1 >= buf.length) break
        if (buf[pos + 1] !== SYNC2) { pos++; this.stats.discarded++; continue }
        if (pos + 6 > buf.length) break
        const len = buf.readUInt16LE(pos + 4)
        if (len > MAX_PAYLOAD) { pos++; this.stats.discarded++; continue }
        if (pos + 8 + len > buf.length) break
        const [ca, cb] = checksum(buf, pos + 2, pos + 6 + len)
        if (ca !== buf[pos + 6 + len] || cb !== buf[pos + 7 + len]) {
          this.stats.badChecksum++
          pos++
          continue
        }
        this.stats.ubx++
        // copy so consumers may keep the payload after the buffer is reused
        const payload = Buffer.from(buf.subarray(pos + 6, pos + 6 + len))
        try { this.onUbx(buf[pos + 2], buf[pos + 3], payload) } catch (e) { this.onError(e) }
        pos += 8 + len
      } else if (c === 0x24) { // '$'
        const end = buf.indexOf(0x0a, pos)
        if (end < 0) {
          if (buf.length - pos > 120) { pos++; this.stats.discarded++; continue } // not a real sentence
          break
        }
        const line = buf.toString('latin1', pos, end).trim()
        this.stats.nmea++
        try { this.onNmea(line) } catch (e) { this.onError(e) }
        pos = end + 1
      } else {
        pos++
        this.stats.discarded++
      }
    }
    this.buf = pos >= buf.length ? Buffer.alloc(0) : buf.subarray(pos)
  }
}

const CLS = { NAV: 0x01, RXM: 0x02, INF: 0x04, ACK: 0x05, CFG: 0x06, MON: 0x0a, TIM: 0x0d, SEC: 0x27 }

module.exports = { frame, checksum, Parser, CLS }
