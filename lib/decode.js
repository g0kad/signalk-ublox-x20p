'use strict'
// Decoders for the UBX messages used by the plugin. Layouts per u-blox X20 HPG 2.02 / 2.11
// interface descriptions. Each decoder returns a plain object; units are SI where practical.

const GNSS = ['GPS', 'SBAS', 'Galileo', 'BeiDou', 'IMES', 'QZSS', 'GLONASS', 'NavIC']
const GNSS_PREFIX = ['G', 'S', 'E', 'C', 'I', 'J', 'R', 'I']

const SIGNALS = {
  0: { 0: 'L1C/A', 3: 'L2 CL', 4: 'L2 CM', 6: 'L5 I', 7: 'L5 Q' },
  1: { 0: 'L1C/A' },
  2: { 0: 'E1 C', 1: 'E1 B', 3: 'E5a I', 4: 'E5a Q', 5: 'E5b I', 6: 'E5b Q', 8: 'E6 B', 9: 'E6 C', 10: 'E6 A' },
  3: { 0: 'B1I D1', 1: 'B1I D2', 2: 'B2I D1', 3: 'B2I D2', 4: 'B3I D1', 10: 'B3I D2', 5: 'B1C p', 6: 'B1C d', 7: 'B2a p', 8: 'B2a d' },
  5: { 0: 'L1C/A', 1: 'L1S', 4: 'L2 CM', 5: 'L2 CL', 8: 'L5 I', 9: 'L5 Q', 12: 'L1C/B' },
  6: { 0: 'L1 OF', 2: 'L2 OF' },
  7: { 0: 'L5 A' }
}

// Frequency band of a signal, for grouping in the UI
const BAND = {
  'L1C/A': 'L1', 'L1S': 'L1', 'L1C/B': 'L1', 'L1 OF': 'L1', 'E1 C': 'L1', 'E1 B': 'L1', 'B1I D1': 'L1', 'B1I D2': 'L1', 'B1C p': 'L1', 'B1C d': 'L1',
  'L2 CL': 'L2', 'L2 CM': 'L2', 'L2 OF': 'L2', 'B2I D1': 'L2', 'B2I D2': 'L2', 'E5b I': 'L2', 'E5b Q': 'L2',
  'L5 I': 'L5', 'L5 Q': 'L5', 'L5 A': 'L5', 'E5a I': 'L5', 'E5a Q': 'L5', 'B2a p': 'L5', 'B2a d': 'L5',
  'E6 A': 'L6', 'E6 B': 'L6', 'E6 C': 'L6', 'B3I D1': 'L6', 'B3I D2': 'L6'
}

const CORR_SOURCE = {
  0: 'none', 1: 'SBAS', 2: 'BeiDou', 3: 'RTCM2', 4: 'RTCM3 OSR', 5: 'RTCM3 SSR',
  6: 'QZSS SLAS', 7: 'SPARTN', 9: 'CLAS', 10: 'LPP OSR', 11: 'LPP SSR', 12: 'Galileo HAS'
}
const FIX_TYPE = ['no fix', 'dead reckoning', '2D', '3D', 'GNSS + dead reckoning', 'time only']
const CARR_SOLN = ['none', 'float', 'fixed']
const JAM_STATE = ['unknown', 'none', 'warning', 'critical']
const SPF_STATE = ['unknown', 'none', 'indicated', 'affirmed']
const ANT_STATUS = ['init', 'unknown', 'ok', 'short', 'open']
const ANT_POWER = ['off', 'on', 'unknown']
const NMA_STATUS = ['not authenticated yet', 'test', 'operational', 'invalid']
const COR_PROTOCOL = { 0: 'unknown', 1: 'RTCM3', 2: 'SPARTN', 5: 'Galileo HAS', 29: 'SPARTN (PMP)', 30: 'QZSS L6' }

const deg2rad = Math.PI / 180

function svName (gnssId, svId) { return `${GNSS_PREFIX[gnssId] || '?'}${String(svId).padStart(2, '0')}` }

function navPvt (p) {
  const flags = p[21], valid = p[11]
  const iso = (valid & 0x03) === 0x03
    ? new Date(Date.UTC(p.readUInt16LE(4), p[6] - 1, p[7], p[8], p[9], p[10]) + Math.round(p.readInt32LE(16) / 1e6)).toISOString()
    : null
  const r = {
    iTOW: p.readUInt32LE(0),
    time: iso,
    timeValid: (valid & 0x07) === 0x07,
    tAcc: p.readUInt32LE(12) * 1e-9,
    fixType: p[20],
    fixTypeText: FIX_TYPE[p[20]] || String(p[20]),
    gnssFixOK: !!(flags & 0x01),
    diffSoln: !!(flags & 0x02),
    carrSoln: flags >> 6,
    carrSolnText: CARR_SOLN[flags >> 6],
    numSV: p[23],
    lon: p.readInt32LE(24) * 1e-7,
    lat: p.readInt32LE(28) * 1e-7,
    height: p.readInt32LE(32) / 1000,
    hMSL: p.readInt32LE(36) / 1000,
    hAcc: p.readUInt32LE(40) / 1000,
    vAcc: p.readUInt32LE(44) / 1000,
    velN: p.readInt32LE(48) / 1000,
    velE: p.readInt32LE(52) / 1000,
    velD: p.readInt32LE(56) / 1000,
    gSpeed: p.readInt32LE(60) / 1000,
    headMot: p.readInt32LE(64) * 1e-5 * deg2rad,
    sAcc: p.readUInt32LE(68) / 1000,
    headAcc: p.readUInt32LE(72) * 1e-5 * deg2rad,
    pDOP: p.readUInt16LE(76) * 0.01
  }
  if (p.length >= 80) {
    const f3 = p.readUInt16LE(78)
    r.invalidLlh = !!(f3 & 0x0001)
    r.lastCorrectionAge = (f3 >> 1) & 0x0f
    r.authTime = !!(f3 & 0x2000)
    r.nmaFix = !!(f3 & 0x4000)
  }
  if (p.length >= 92 && (valid & 0x08)) {
    r.magDec = p.readInt16LE(88) * 1e-2 * deg2rad
    r.magAcc = p.readUInt16LE(90) * 1e-2 * deg2rad
  }
  return r
}

// Age in seconds of the upper bound of lastCorrectionAge buckets (null if not available)
const CORR_AGE_MAX = [null, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, Infinity]

function navHpposllh (p) {
  return {
    iTOW: p.readUInt32LE(4),
    invalidLlh: !!(p[3] & 0x01),
    lon: p.readInt32LE(8) * 1e-7 + p.readInt8(24) * 1e-9,
    lat: p.readInt32LE(12) * 1e-7 + p.readInt8(25) * 1e-9,
    height: (p.readInt32LE(16) + p.readInt8(26) * 0.1) / 1000,
    hMSL: (p.readInt32LE(20) + p.readInt8(27) * 0.1) / 1000,
    hAcc: p.readUInt32LE(28) * 1e-4,
    vAcc: p.readUInt32LE(32) * 1e-4
  }
}

function navDop (p) {
  const d = o => p.readUInt16LE(o) * 0.01
  return { iTOW: p.readUInt32LE(0), gDOP: d(4), pDOP: d(6), tDOP: d(8), vDOP: d(10), hDOP: d(12), nDOP: d(14), eDOP: d(16) }
}

function navCov (p) {
  const f = o => p.readFloatLE(o)
  return {
    iTOW: p.readUInt32LE(0),
    posValid: !!p[5],
    velValid: !!p[6],
    pos: { NN: f(16), NE: f(20), ND: f(24), EE: f(28), ED: f(32), DD: f(36) },
    vel: { NN: f(40), NE: f(44), ND: f(48), EE: f(52), ED: f(56), DD: f(60) }
  }
}

function navSat (p) {
  const n = p[5], sats = []
  for (let i = 0, o = 8; i < n && o + 12 <= p.length; i++, o += 12) {
    const flags = p.readUInt32LE(o + 8)
    sats.push({
      gnssId: p[o], svId: p[o + 1], name: svName(p[o], p[o + 1]), gnss: GNSS[p[o]],
      cno: p[o + 2], elev: p.readInt8(o + 3), azim: p.readInt16LE(o + 4), prRes: p.readInt16LE(o + 6) * 0.1,
      quality: flags & 0x07, used: !!(flags & 0x08), health: (flags >> 4) & 0x03,
      diffCorr: !!(flags & 0x40), orbitSource: (flags >> 8) & 0x07,
      sbasCorr: !!(flags & 0x10000), hasCorr: !!(flags & 0x2000000)
    })
  }
  return { iTOW: p.readUInt32LE(0), sats }
}

function navSig (p) {
  const n = p[5], sigs = []
  for (let i = 0, o = 8; i < n && o + 16 <= p.length; i++, o += 16) {
    const g = p[o], s = p[o + 2], f = p.readUInt16LE(o + 10)
    const name = (SIGNALS[g] && SIGNALS[g][s]) || `sig${s}`
    sigs.push({
      gnssId: g, svId: p[o + 1], sv: svName(g, p[o + 1]), gnss: GNSS[g], sigId: s, signal: name, band: BAND[name] || '?',
      cno: p[o + 6], quality: p[o + 7], corrSource: CORR_SOURCE[p[o + 8]] || String(p[o + 8]),
      ionoModel: p[o + 9], health: f & 0x03, prUsed: !!(f & 0x08), crUsed: !!(f & 0x10), doUsed: !!(f & 0x20),
      corrUsed: !!(f & 0x40), authenticated: !!(f & 0x200)
    })
  }
  return { iTOW: p.readUInt32LE(0), sigs }
}

function navTimeutc (p) {
  const valid = p[19]
  return {
    iTOW: p.readUInt32LE(0), tAcc: p.readUInt32LE(4) * 1e-9,
    validUTC: !!(valid & 0x04), authenticated: !!(valid & 0x08),
    time: (valid & 0x04)
      ? new Date(Date.UTC(p.readUInt16LE(12), p[14] - 1, p[15], p[16], p[17], p[18]) + Math.round(p.readInt32LE(8) / 1e6)).toISOString()
      : null
  }
}

function navRelposned (p) {
  const f = p.readUInt32LE(60)
  return {
    iTOW: p.readUInt32LE(4),
    relN: (p.readInt32LE(8) + p.readInt8(32) * 0.01) / 100,
    relE: (p.readInt32LE(12) + p.readInt8(33) * 0.01) / 100,
    relD: (p.readInt32LE(16) + p.readInt8(34) * 0.01) / 100,
    length: (p.readInt32LE(20) + p.readInt8(35) * 0.01) / 100,
    heading: p.readInt32LE(24) * 1e-5 * deg2rad,
    accLength: p.readUInt32LE(48) * 1e-4,
    accHeading: p.readUInt32LE(52) * 1e-5 * deg2rad,
    gnssFixOK: !!(f & 0x01), relPosValid: !!(f & 0x04), carrSoln: (f >> 3) & 0x03,
    isMoving: !!(f & 0x20), headingValid: !!(f & 0x100)
  }
}

function navStatus (p) {
  return {
    iTOW: p.readUInt32LE(0), gpsFix: p[4], spoofDetState: (p[7] >> 3) & 0x03,
    ttff: p.readUInt32LE(8) / 1000, msss: p.readUInt32LE(12) / 1000
  }
}

function secSig (p) {
  const f = p[1]
  const r = {
    version: p[0],
    jamDetEnabled: !!(f & 0x01), jamState: (f >> 1) & 0x03,
    spfDetEnabled: !!(f & 0x08), spfState: (f >> 4) & 0x07
  }
  r.jamStateText = JAM_STATE[r.jamState]; r.spfStateText = SPF_STATE[r.spfState] || String(r.spfState)
  r.bands = []
  if (p[0] >= 2) {
    for (let i = 0, o = 4; i < p[3] && o + 4 <= p.length; i++, o += 4) {
      const v = p.readUInt32LE(o)
      r.bands.push({ centFreqKHz: v & 0xffffff, jammed: !!(v & 0x1000000) })
    }
  }
  return r
}

function secOsnma (p) {
  const h = p[1], mon = p.readUInt16LE(2)
  const r = {
    version: p[0],
    nmaStatus: (h >> 1) & 0x03,
    enabled: !!(mon & 0x0001),
    numberSVs: (mon >> 1) & 0x1f
  }
  r.nmaStatusText = NMA_STATUS[r.nmaStatus]
  r.noData = !!(mon & 0x0100)
  r.wrongData = !!(mon & 0x0e00)
  if (p.length >= 28) {
    r.timSyncEnabled = !!(p[4] & 0x01)
    r.timSyncStatus = (p[4] >> 1) & 0x07
    r.timSyncStatusText = TIMSYNC_STATUS[r.timSyncStatus] || String(r.timSyncStatus)
    r.timSyncDiffMs = p.readInt32LE(8)
    r.dsmAuthStatus = p.readUInt32LE(16) & 0x3f
    r.pubKeyId = (p.readUInt32LE(16) >> 10) & 0x0f // key the satellites are signing with
    r.teslaKeyAuthStatus = p.readUInt32LE(20) & 0x07
    r.teslaKeyAuthText = TESLA_STATUS[r.teslaKeyAuthStatus] || String(r.teslaKeyAuthStatus)
    const g = p.readUInt32LE(24)
    r.authSVs = g & 0x3f
    r.authNumTim = (g >> 6) & 0x3f
    r.timingAuthResult = (g >> 12) & 0x03
    r.pubKeySrc = KEY_SRC[(g >> 15) & 0x03]
    r.merkleRootSrc = KEY_SRC[(g >> 17) & 0x03]
    r.merkleRootValid = !!(g & 0x80000)
    r.pubKeyValid = !!(g & 0x800000)
    // per-SV authentication results
    r.svs = []
    for (let o = 28; o + 4 <= p.length; o += 4) {
      const b = p.readUInt16LE(o)
      r.svs.push({ svId: p[o + 2], authNum: (b >> 10) & 0x1f, authenticated: !!(b & 0x8000) })
    }
  }
  return r
}
const TIMSYNC_STATUS = ['not performed', 'no trusted time available', 'trusted time not accurate enough', 'passed', 'failed (replay attack)']
const TESLA_STATUS = ['not performed', 'authenticated', 'failed', 'in progress', 'not performed']
const KEY_SRC = ['factory default', 'from satellites', 'from host', 'from NVS']

function monRf (p) {
  const n = p[1]
  const blockSize = n ? Math.floor((p.length - 4) / n) : 0 // 24 in version 0, 20 in version 1
  const blocks = []
  for (let i = 0, o = 4; i < n && o + blockSize <= p.length; i++, o += blockSize) {
    const b = blockSize >= 24
      ? { blockId: p[o], antStatus: p[o + 2], antPower: p[o + 3], cwSuppression: p[o + 16] }
      : { blockId: p[o], antStatus: p[o + 1], antPower: p[o + 2], cwSuppression: p[o + 3] }
    b.noisePerMS = p.readUInt16LE(o + 12)
    b.agcCnt = p.readUInt16LE(o + 14)
    b.antStatusText = ANT_STATUS[b.antStatus] || String(b.antStatus)
    b.antPowerText = ANT_POWER[b.antPower] || String(b.antPower)
    b.agcPercent = Math.round(b.agcCnt / 8191 * 1000) / 10
    blocks.push(b)
  }
  return { version: p[0], blocks }
}

function monSys (p) {
  return {
    bootType: p[1], cpuLoad: p[2], cpuLoadMax: p[3], memUsage: p[4], memUsageMax: p[5],
    ioUsage: p[6], ioUsageMax: p[7], runTime: p.readUInt32LE(8),
    notices: p.readUInt16LE(12), warnings: p.readUInt16LE(14), errors: p.readUInt16LE(16),
    temperature: p.readInt8(18)
  }
}

function monVer (p) {
  const str = (o, n) => p.subarray(o, o + n).toString('latin1').replace(/\0.*$/s, '')
  const ext = []
  for (let o = 40; o + 30 <= p.length; o += 30) ext.push(str(o, 30))
  const kv = Object.fromEntries(ext.filter(e => e.includes('=')).map(e => e.split('=')))
  return {
    sw: str(0, 30), hw: str(30, 10), ext,
    firmware: kv.FWVER, protocol: kv.PROTVER, module: kv.MOD,
    gnss: ext.filter(e => !e.includes('=') && !/^ROM/.test(e)).join(';').split(';').filter(Boolean)
  }
}

// [gnss, offset within the 28-byte plan block, bit names]
const PLAN_SIGNALS = [
  ['GPS', 6, ['L1C/A', 'L1C', 'L2C', 'L5']],
  ['Galileo', 8, ['E1', 'E5a', 'E5b', 'E6']],
  ['BeiDou', 10, ['B1I', 'B1C', 'B2I', 'B2a', 'B3I']],
  ['GLONASS', 12, ['L1OF', 'L2OF']],
  ['SBAS', 14, ['L1C/A']],
  ['QZSS', 16, ['L1C/A', 'L1C/B', 'L1C', 'L1S', 'L2C', 'L5']],
  ['NavIC', 18, ['L5']],
  ['L-band', 20, ['L1']]
]

function monGnss (p) {
  const info = p.readUInt16LE(2)
  const plans = []
  for (let i = 0, o = 4; i < p[1] && o + 28 <= p.length; i++, o += 28) {
    const signals = {}
    for (const [gnss, off, names] of PLAN_SIGNALS) {
      const bits = p.readUInt16LE(o + off)
      const s = names.filter((_, b) => bits & (1 << b))
      if (s.length) signals[gnss] = s
    }
    plans.push({ id: p[o], name: p.subarray(o + 1, o + 6).toString('latin1').replace(/\0.*$/s, ''), signals })
  }
  return { activePlan: info & 0xff, gnssCfgLevel: (info >> 8) & 0x07, plans }
}

function rxmCor (p) {
  const s = p.readUInt32LE(4)
  const proto = s & 0x1f
  return {
    ebno: p[1] * 0.125, protocol: proto, protocolText: COR_PROTOCOL[proto] || String(proto),
    errStatus: (s >> 5) & 0x03, msgUsed: (s >> 7) & 0x03,
    msgType: p.readUInt16LE(8), msgSubType: p.readUInt16LE(10)
  }
}

// key: (cls << 8) | id
const DECODERS = {
  0x0107: ['NAV-PVT', navPvt],
  0x0114: ['NAV-HPPOSLLH', navHpposllh],
  0x0104: ['NAV-DOP', navDop],
  0x0136: ['NAV-COV', navCov],
  0x0135: ['NAV-SAT', navSat],
  0x0143: ['NAV-SIG', navSig],
  0x0121: ['NAV-TIMEUTC', navTimeutc],
  0x013c: ['NAV-RELPOSNED', navRelposned],
  0x0103: ['NAV-STATUS', navStatus],
  0x0161: ['NAV-EOE', p => ({ iTOW: p.readUInt32LE(0) })],
  0x2709: ['SEC-SIG', secSig],
  0x270a: ['SEC-OSNMA', secOsnma],
  0x0a38: ['MON-RF', monRf],
  0x0a39: ['MON-SYS', monSys],
  0x0a04: ['MON-VER', monVer],
  0x0a28: ['MON-GNSS', monGnss],
  0x0234: ['RXM-COR', rxmCor]
}

function decode (cls, id, p) {
  const d = DECODERS[(cls << 8) | id]
  if (!d) return null
  return { type: d[0], data: d[1](p) }
}

module.exports = {
  decode, DECODERS, GNSS, SIGNALS, CORR_SOURCE, FIX_TYPE, JAM_STATE, SPF_STATE, CORR_AGE_MAX
}
