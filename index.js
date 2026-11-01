'use strict'
// Signal K plugin for u-blox X20P GNSS receivers (UBX protocol).

const { Receiver, MANAGED } = require('./lib/receiver')
const { SignalKMapper } = require('./lib/signalk')
const { SECTIONS, curatedKeys } = require('./lib/settings-model')
const cfg = require('./lib/cfg')
const { TimeServer } = require('./lib/timeserver')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-ublox-x20p',
    name: 'u-blox X20P GNSS',
    description: 'Reads position, accuracy, signal and security data from a u-blox X20P over UBX, and configures the receiver'
  }
  let receiver = null
  let mapper = null
  let timeServer = null
  let opts = {}
  const corrections = [] // recent RXM-COR, newest first

  plugin.schema = {
    type: 'object',
    required: ['device'],
    properties: {
      device: {
        type: 'string',
        title: 'Serial device',
        default: '/dev/serial/by-id/usb-u-blox_AG_-_www.u-blox.com_u-blox_GNSS_receiver-if00',
        description: 'Receiver USB port. The /dev/serial/by-id path survives replugging; /dev/ttyACM0 or an OpenPlotter alias also work. Remove any other Signal K connection using this port.'
      },
      baudRate: { type: 'number', title: 'Baud rate (ignored for USB)', default: 38400 },
      publishDatetime: { type: 'boolean', title: 'Publish navigation.datetime', default: true },
      publishMagvar: { type: 'boolean', title: 'Publish magnetic variation from the receiver model', default: false },
      cogMinSpeed: { type: 'number', title: 'Minimum speed for course over ground (m/s)', default: 0.25, description: 'Below this speed, COG is not published (it is just noise when stationary).' },
      satelliteInterval: { type: 'number', title: 'Satellites-in-view update interval (s)', default: 5 },
      notifications: { type: 'boolean', title: 'Raise notifications for jamming, spoofing, antenna faults and fix loss', default: true },
      headingFromRelposned: { type: 'boolean', title: 'Publish headingTrue from a moving-base receiver (NAV-RELPOSNED)', default: false },
      headingOffset: { type: 'number', title: 'Heading offset (degrees) between antenna baseline and bow', default: 0 },
      allowOtherReceivers: {
        type: 'boolean',
        title: 'Allow configuration changes on receivers other than the ZED-X20P',
        default: false,
        description: 'Data from other u-blox receivers is always read. Settings, restore and OSNMA key loading are built and tested for the X20P only, so they are blocked on other receivers unless this is on.'
      },
      trustedTime: {
        type: 'boolean',
        title: 'Give the receiver trusted time for Galileo OSNMA',
        default: false,
        description: 'Sends this computer\'s clock as a trusted time source, only while it is synchronised to network NTP (not to this GNSS). Lets OSNMA apply its anti-replay time check.'
      },
      timeServer: {
        type: 'boolean',
        title: 'Serve GNSS time to chrony (NTP on localhost)',
        default: false,
        description: 'Answers NTP requests on 127.0.0.1 with the receiver\'s time, so chrony can keep this computer\'s clock right without a network. Add "server 127.0.0.1 port 12300 minpoll 4 maxpoll 4" to chrony.conf. Accuracy is milliseconds, not PPS-grade.'
      },
      timeServerPort: { type: 'number', title: 'Time server UDP port', default: 12300 },
      timeServerDelay: {
        type: 'number',
        title: 'Receiver message delay (ms)',
        default: 0,
        description: 'How long after its epoch a NAV-PVT reaches this computer. Measure it while chrony also has network servers: the offset chronyc reports for 127.0.0.1 (positive when the computer is ahead of the GNSS time).'
      }
    }
  }

  plugin.start = function (options) {
    opts = { ...defaults(), ...options }
    mapper = new SignalKMapper(app, plugin.id, opts)
    receiver = new Receiver({
      path: opts.device,
      baudRate: opts.baudRate,
      headingFromRelposned: opts.headingFromRelposned,
      trustedTime: opts.trustedTime,
      debug: app.debug
    })
    receiver.on('status', (s, error) => error ? app.setPluginError(s) : app.setPluginStatus(s))
    receiver.on('epoch', state => { try { mapper.epoch(state) } catch (e) { app.error(e) } })
    receiver.on('correction', c => { corrections.unshift({ ...c, time: Date.now() }); corrections.length = Math.min(corrections.length, 50) })
    if (opts.timeServer) {
      timeServer = new TimeServer({ port: opts.timeServerPort, delayMs: opts.timeServerDelay, debug: app.debug })
      receiver.on('pvt', pvt => timeServer.sample(pvt, pvt._received))
      timeServer.start().catch(e => app.error(`time server on port ${opts.timeServerPort}: ${e.message}`))
    }
    receiver.start()
  }

  plugin.stop = function () {
    if (receiver) receiver.stop()
    if (timeServer) timeServer.stop()
    receiver = null
    timeServer = null
  }

  plugin.registerWithRouter = function (router) {
    const api = fn => async (req, res) => {
      if (!receiver || !receiver.device.connected) return res.status(503).json({ error: receiver ? receiver.status : 'plugin not running' })
      try { res.json(await fn(req)) } catch (e) { res.status(400).json({ error: e.message }) }
    }
    // Routes that change the receiver's configuration
    const write = fn => api(req => { assertWritable(); return fn(req) })

    // Signal K requires admin for plugin routes by default; live status is safe for any logged-in user.
    // router.access exists from Signal K 2.x with plugin route permissions.
    const readonly = router.access ? router.access('readonly') : router
    readonly.get('/api/status', (req, res) => {
      if (!receiver) return res.status(503).json({ error: 'plugin not running' })
      const s = receiver.state
      res.json({
        connected: receiver.device.connected,
        status: receiver.status,
        info: receiver.info,
        configLocked: configLocked(),
        navHz: receiver.navHz,
        pvt: s['NAV-PVT'], hp: s['NAV-HPPOSLLH'], dop: s['NAV-DOP'],
        sat: s['NAV-SAT'], sig: s['NAV-SIG'], sec: s['SEC-SIG'], osnma: s['SEC-OSNMA'],
        rf: s['MON-RF'], sys: s['MON-SYS'], relpos: s['NAV-RELPOSNED'],
        corrections: corrections.slice(0, 10),
        trustedTime: receiver.trustedTime,
        timeServer: timeServer ? timeServer.status() : null,
        counts: receiver.counts,
        parser: receiver.device.parser.stats
      })
    })

    // Curated settings: model + key definitions + current values in each layer
    router.get('/api/settings', api(async () => {
      const keys = curatedKeys()
      const values = await receiver.readConfig(keys)
      const defs = {}
      for (const k of keys) {
        const d = cfg.lookup(k)
        if (d) defs[k] = { type: d.type, title: d.title, desc: d.desc, unit: d.unit, scale: d.scale, consts: d.consts }
      }
      return { sections: SECTIONS, defs, values, info: receiver.info, configLocked: configLocked(), pending: await pendingChanges() }
    }))

    // Every key the receiver reports, for the advanced editor
    router.get('/api/config', api(async () => {
      const values = await receiver.readConfig()
      const keys = Object.keys(values.ram).filter(k => !k.startsWith('0x'))
      const defs = {}
      for (const k of keys) {
        const d = cfg.lookup(k)
        defs[k] = { type: d.type, title: d.title, desc: d.desc, unit: d.unit, scale: d.scale, consts: d.consts }
      }
      return { groups: cfg.db.groups, defs, values, info: receiver.info, configLocked: configLocked(), hidden: Object.keys(values.ram).length - keys.length }
    }))

    router.post('/api/config', write(async req => {
      const { changes, persist } = req.body || {}
      if (!Array.isArray(changes) || !changes.length) throw new Error('changes must be a non-empty array of {key, value}')
      for (const c of changes) {
        const d = cfg.lookup(c.key)
        if (!d) throw new Error(`Unknown key ${c.key}`)
        if (cfg.FORBIDDEN.has(d.name)) throw new Error(`${c.key} cannot be changed from here`)
      }
      await receiver.writeConfig(changes, !!persist)
      return { ok: true, values: await receiver.readConfig(changes.map(c => c.key)), pending: await pendingChanges() }
    }))

    router.get('/api/pending', api(pendingChanges))

    router.post('/api/save', write(async () => {
      const keys = (await pendingChanges()).map(p => p.key)
      return { saved: await receiver.saveToFlash(keys), pending: await pendingChanges() }
    }))

    router.post('/api/revert', write(async () => {
      const keys = (await pendingChanges()).map(p => p.key)
      return { reverted: await receiver.revertRam(keys), pending: await pendingChanges() }
    }))

    router.post('/api/reset-default', write(async req => {
      const keys = (req.body && req.body.keys) || []
      if (!keys.length) throw new Error('keys required')
      return { reset: await receiver.resetToDefault(keys), pending: await pendingChanges() }
    }))

    router.get('/api/backup', api(() => receiver.backup()))

    // Body: {backup, dryRun}. dryRun returns the plan without writing anything.
    router.post('/api/restore', api(async req => {
      const { backup, dryRun } = req.body || {}
      if (dryRun) return receiver.restorePlan(backup)
      assertWritable()
      return receiver.restore(backup)
    }))

    // Body: {files: [{name, text}]} — GSC Merkle tree and/or public key files
    router.post('/api/osnma/keys', write(async req => {
      const files = (req.body && req.body.files) || []
      if (!files.length) throw new Error('No files')
      return receiver.loadOsnmaKeys(files)
    }))

    router.post('/api/osnma/time', api(() => receiver.sendTrustedTime()))

    router.post('/api/restart', api(async req => {
      await receiver.restart(req.body && req.body.type)
      return { ok: true }
    }))
  }

  // Configuration writes are blocked on receivers other than the X20P unless the user opts in
  function configLocked () {
    return !!receiver && receiver.info.supported === false && !opts.allowOtherReceivers
  }
  function assertWritable () {
    if (configLocked()) throw new Error(`This receiver is a ${receiver.info.version.module || 'model other than the ZED-X20P'}. Configuration changes are only enabled for the ZED-X20P: see "Allow configuration changes on receivers other than the ZED-X20P" in the plugin settings.`)
  }

  // Settings whose live (RAM) value differs from what the receiver will load at power-up.
  // Excludes the UBX outputs this plugin manages itself.
  async function pendingChanges () {
    const { ram, saved } = await receiver.readConfig()
    return Object.keys(ram)
      .filter(k => !k.startsWith('0x') && !MANAGED.has(k))
      .map(k => ({ key: k, live: ram[k], saved: saved[k] }))
      .filter(p => p.saved !== undefined && p.live !== p.saved)
      .map(p => ({ ...p, title: (cfg.lookup(p.key) || {}).title }))
  }

  function defaults () {
    return Object.fromEntries(Object.entries(plugin.schema.properties).map(([k, v]) => [k, v.default]))
  }

  return plugin
}
