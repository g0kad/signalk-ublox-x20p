'use strict'
// Maps decoded UBX state to Signal K deltas and notifications.

const { CORR_AGE_MAX } = require('./decode')

const deg2rad = Math.PI / 180

// Custom paths (not in the Signal K spec) get meta so units display correctly.
const META = {
  'navigation.gnss.horizontalAccuracy': { units: 'm', description: 'Estimated horizontal position accuracy (1 sigma)' },
  'navigation.gnss.verticalAccuracy': { units: 'm', description: 'Estimated vertical position accuracy (1 sigma)' },
  'navigation.gnss.speedAccuracy': { units: 'm/s', description: 'Estimated speed accuracy' },
  'navigation.gnss.courseAccuracy': { units: 'rad', description: 'Estimated course over ground accuracy' },
  'navigation.gnss.timeAccuracy': { units: 's', description: 'Estimated time accuracy' },
  'navigation.gnss.velocityNorth': { units: 'm/s', description: 'GNSS velocity, north component' },
  'navigation.gnss.velocityEast': { units: 'm/s', description: 'GNSS velocity, east component' },
  'navigation.gnss.velocityDown': { units: 'm/s', description: 'GNSS velocity, down component (positive = descending)' },
  'navigation.gnss.verticalDilution': { description: 'Vertical dilution of precision' },
  'navigation.gnss.timeDilution': { description: 'Time dilution of precision' },
  'navigation.gnss.correctionSource': { description: 'Correction service in use (none, SBAS, Galileo HAS, RTCM3, SPARTN, ...)' },
  'navigation.gnss.carrierSolution': { description: 'Carrier-phase solution: none, float or fixed' },
  'navigation.gnss.signalsTracked': { description: 'Number of GNSS signals tracked' },
  'navigation.gnss.signalsUsed': { description: 'Number of GNSS signals used in the solution' },
  'navigation.gnss.jamming': { description: 'Jamming detector state: unknown, none, warning, critical' },
  'navigation.gnss.spoofing': { description: 'Spoofing detector state: unknown, none, indicated, affirmed' },
  'navigation.gnss.osnma': { description: 'Galileo OSNMA navigation message authentication status' },
  'navigation.gnss.authenticatedFix': { description: 'Fix verified using OSNMA-authenticated navigation data' },
  'navigation.gnss.authenticatedSignals': { description: 'Number of tracked Galileo signals with OSNMA-authenticated navigation data' },
  'navigation.gnss.antennaStatus': { description: 'Antenna supervisor state: ok, short, open, unknown' },
  'navigation.gnss.baselineLength': { units: 'm', description: 'Moving-base antenna baseline length' }
}

class SignalKMapper {
  constructor (app, pluginId, options) {
    this.app = app
    this.pluginId = pluginId
    this.opts = options
    this.lastSatsSent = 0
    this.notified = {}
    this.metaSent = false
  }

  sendMeta () {
    if (this.metaSent) return
    this.metaSent = true
    this.app.handleMessage(this.pluginId, {
      updates: [{ meta: Object.entries(META).map(([path, value]) => ({ path, value })) }]
    })
  }

  // state: latest decoded messages keyed by type, for the epoch just finished
  epoch (state) {
    this.sendMeta()
    const values = []
    // Numbers are rounded to 4 decimals (0.1 mm, 0.0001 rad) to drop float noise; positions are added unrounded
    const add = (path, value) => {
      if (value === undefined || value === null || Number.isNaN(value)) return
      values.push({ path, value: typeof value === 'number' ? round(value, 4) : value })
    }
    const pvt = state['NAV-PVT']
    if (!pvt) return

    const hp = state['NAV-HPPOSLLH']
    const useHp = hp && hp.iTOW === pvt.iTOW && !hp.invalidLlh
    const fixOk = pvt.gnssFixOK && pvt.fixType >= 2 && pvt.fixType <= 4 && !pvt.invalidLlh

    add('navigation.gnss.methodQuality', methodQuality(pvt, state))
    add('navigation.gnss.satellites', pvt.numSV)
    add('navigation.gnss.integrity', integrity(state))

    if (fixOk) {
      const pos = useHp ? hp : pvt
      add('navigation.position', { latitude: round(pos.lat, 9), longitude: round(pos.lon, 9), altitude: round(pos.hMSL, 4) })
      add('navigation.gnss.antennaAltitude', pos.hMSL)
      add('navigation.gnss.geoidalSeparation', round(pos.height - pos.hMSL, 3))
      add('navigation.gnss.horizontalAccuracy', pos.hAcc)
      add('navigation.gnss.verticalAccuracy', pos.vAcc)
      add('navigation.speedOverGround', pvt.gSpeed)
      // Course is meaningless when stationary; hold it back below the configured speed
      if (pvt.gSpeed >= this.opts.cogMinSpeed) add('navigation.courseOverGroundTrue', pvt.headMot)
      add('navigation.gnss.speedAccuracy', pvt.sAcc)
      add('navigation.gnss.courseAccuracy', pvt.headAcc)
      add('navigation.gnss.velocityNorth', pvt.velN)
      add('navigation.gnss.velocityEast', pvt.velE)
      add('navigation.gnss.velocityDown', pvt.velD)
      if (this.opts.publishMagvar && pvt.magDec !== undefined) add('navigation.magneticVariation', pvt.magDec)
    }
    if (this.opts.publishDatetime && pvt.timeValid && pvt.time) {
      add('navigation.datetime', pvt.time)
      values.push({ path: 'navigation.gnss.timeAccuracy', value: Number(pvt.tAcc.toPrecision(3)) }) // ns-scale: bypass rounding
    }

    const dop = state['NAV-DOP']
    if (dop) {
      add('navigation.gnss.horizontalDilution', dop.hDOP)
      add('navigation.gnss.positionDilution', dop.pDOP)
      add('navigation.gnss.verticalDilution', dop.vDOP)
      add('navigation.gnss.timeDilution', dop.tDOP)
    }

    const corrAge = CORR_AGE_MAX[pvt.lastCorrectionAge]
    if (corrAge !== null && corrAge !== undefined && Number.isFinite(corrAge)) add('navigation.gnss.differentialAge', corrAge)
    add('navigation.gnss.carrierSolution', pvt.carrSolnText)

    const sig = state['NAV-SIG']
    if (sig) {
      add('navigation.gnss.signalsTracked', sig.sigs.length)
      add('navigation.gnss.signalsUsed', sig.sigs.filter(s => s.prUsed).length)
      add('navigation.gnss.correctionSource', correctionSource(sig))
    }

    const sec = state['SEC-SIG']
    if (sec) {
      add('navigation.gnss.jamming', sec.jamDetEnabled ? sec.jamStateText : 'disabled')
      add('navigation.gnss.spoofing', sec.spfDetEnabled ? sec.spfStateText : 'disabled')
    }
    const osnma = state['SEC-OSNMA']
    if (osnma) {
      add('navigation.gnss.osnma', osnma.enabled ? osnma.nmaStatusText : 'disabled')
      if (osnma.enabled) {
        add('navigation.gnss.authenticatedFix', !!pvt.nmaFix)
        if (sig) add('navigation.gnss.authenticatedSignals', sig.sigs.filter(s => s.authenticated).length)
      }
    }

    const rf = state['MON-RF']
    if (rf && rf.blocks.length) add('navigation.gnss.antennaStatus', antennaStatus(rf))

    const now = Date.now()
    const sat = state['NAV-SAT']
    if (sat && now - this.lastSatsSent >= this.opts.satelliteInterval * 1000) {
      this.lastSatsSent = now
      const inView = sat.sats.filter(s => s.elev >= 0 && s.cno > 0)
      add('navigation.gnss.satellitesInView', {
        count: inView.length,
        satellites: inView.map(s => ({
          id: s.svId, name: s.name, system: s.gnss, used: s.used,
          elevation: round(s.elev * deg2rad, 4), azimuth: round(s.azim * deg2rad, 4), SNR: s.cno
        }))
      })
    }

    const rel = state['NAV-RELPOSNED']
    if (this.opts.headingFromRelposned && rel && rel.headingValid && rel.relPosValid) {
      const h = (rel.heading + this.opts.headingOffset * deg2rad + 4 * Math.PI) % (2 * Math.PI)
      add('navigation.headingTrue', h)
      add('navigation.gnss.baselineLength', rel.length)
    }

    if (values.length) this.app.handleMessage(this.pluginId, { updates: [{ values }] })
    if (this.opts.notifications) this.notify(state, fixOk)
  }

  notify (state, fixOk) {
    const sec = state['SEC-SIG']
    const rf = state['MON-RF']
    const jam = sec && sec.jamDetEnabled ? sec.jamState : 0
    const spf = sec && sec.spfDetEnabled ? sec.spfState : 0
    this.setNotification('navigation.gnss.jamming',
      jam === 3 ? ['alarm', 'GNSS jamming: critical, position may be lost'] : jam === 2 ? ['warn', 'GNSS jamming detected'] : null)
    this.setNotification('navigation.gnss.spoofing',
      spf === 3 ? ['alarm', 'GNSS spoofing affirmed: position is not trustworthy'] : spf === 2 ? ['warn', 'GNSS spoofing indicated: check position against other sources'] : null)
    const ant = rf && rf.blocks.length ? antennaStatus(rf) : 'ok'
    this.setNotification('navigation.gnss.antenna',
      ant === 'short' || ant === 'open' ? ['alarm', `GNSS antenna ${ant} circuit`] : null)
    this.setNotification('navigation.gnss.fix', fixOk ? null : ['warn', 'GNSS fix lost'])
  }

  setNotification (path, v) {
    const key = v ? v[0] + v[1] : 'normal'
    if (this.notified[path] === key) return
    // Don't raise "normal" for a path that was never in alarm
    if (!v && this.notified[path] === undefined) { this.notified[path] = key; return }
    this.notified[path] = key
    this.app.handleMessage(this.pluginId, {
      updates: [{
        values: [{
          path: `notifications.${path}`,
          value: v
            ? { state: v[0], method: v[0] === 'alarm' ? ['visual', 'sound'] : ['visual'], message: v[1] }
            : { state: 'normal', method: [], message: '' }
        }]
      }]
    })
  }
}

function round (v, n) { const f = 10 ** n; return Math.round(v * f) / f }

function correctionSource (sig) {
  const counts = {}
  for (const s of sig.sigs) if (s.prUsed && s.corrSource !== 'none') counts[s.corrSource] = (counts[s.corrSource] || 0) + 1
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best ? best[0] : 'none'
}

function methodQuality (pvt, state) {
  if (!pvt.gnssFixOK || pvt.fixType === 0) return 'no GPS'
  if (pvt.fixType === 1) return 'Estimated (DR) mode'
  if (pvt.carrSoln === 2) return 'RTK fixed integer'
  if (pvt.carrSoln === 1) {
    // a float carrier solution from HAS/SSR corrections is PPP, not RTK
    const src = state['NAV-SIG'] ? correctionSource(state['NAV-SIG']) : ''
    return /HAS|SSR|SPARTN|CLAS/.test(src) ? 'Precise GNSS' : 'RTK float'
  }
  if (pvt.diffSoln) return 'DGNSS fix'
  return 'GNSS Fix'
}

function integrity (state) {
  const sec = state['SEC-SIG']
  if (!sec || (!sec.jamDetEnabled && !sec.spfDetEnabled)) return 'no Integrity checking'
  if (sec.spfState >= 2 || sec.jamState === 3) return 'Unsafe'
  if (sec.jamState === 2) return 'Caution'
  return 'Safe'
}

function antennaStatus (rf) {
  const s = rf.blocks.map(b => b.antStatusText)
  if (s.includes('short')) return 'short'
  if (s.includes('open')) return 'open'
  if (s.every(x => x === 'ok')) return 'ok'
  return s[0]
}

module.exports = { SignalKMapper, correctionSource, methodQuality }
