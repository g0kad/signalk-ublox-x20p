'use strict'
/* X20P GNSS web app: live status, signals, friendly settings and a full key editor. */

const API = '/plugins/signalk-ublox-x20p/api'
const GNSS_COLOR = { GPS: 'gps', Galileo: 'gal', BeiDou: 'bds', GLONASS: 'glo', QZSS: 'qzss', SBAS: 'sbas', NavIC: 'navic' }
const FREQ_BAND = { 1575420: 'L1 / E1 / B1C', 1561098: 'B1I', 1602000: 'GLONASS L1', 1227600: 'L2', 1246000: 'GLONASS L2', 1176450: 'L5 / E5a / B2a', 1207140: 'E5b / B2I', 1278750: 'E6', 1268520: 'B3I' }

const ui = {
  tab: 'overview',
  status: null,
  settings: null, // /api/settings response
  config: null, // /api/config response
  staged: {}, // key -> value waiting to be applied
  advFilter: '',
  advGroup: '',
  busy: false
}

// ---------- helpers ----------
function h (tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c))
  return el
}
const $main = () => document.getElementById('main')
const fmt = (v, d = 1) => (v === undefined || v === null || Number.isNaN(v)) ? '–' : Number(v).toFixed(d)
function fmtDist (m) {
  if (m === undefined || m === null) return '–'
  if (m < 1) return `${Math.round(m * 100)} cm`
  if (m < 100) return `${m.toFixed(1)} m`
  return `${Math.round(m)} m`
}
function ddm (v, pos, neg) {
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60
  return `${d}° ${m.toFixed(4).padStart(7, '0')}′ ${v >= 0 ? pos : neg}`
}
function toast (msg) {
  const t = h('div', { class: 'toast' }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), 3500)
}
async function api (path, body) {
  const r = await fetch(API + path, body
    ? { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { credentials: 'include' })
  let j = {}
  try { j = await r.json() } catch (e) {}
  if (r.status === 401 || r.status === 403) throw new Error('Not authorised: log in to Signal K as an admin user to change settings')
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
  return j
}

// ---------- live status ----------
async function pollStatus () {
  try {
    ui.status = await api('/status')
    const s = ui.status
    document.getElementById('conn').textContent = s.connected ? s.status : `offline: ${s.status}`
  } catch (e) {
    document.getElementById('conn').textContent = e.message
  }
  const holdDevice = ui.tab === 'device' && (ui.picking || ui.busy || (ui.restore && (ui.restore.plan || ui.restore.result)))
  if (['overview', 'signals', 'device'].includes(ui.tab) && !holdDevice) render()
}

function fixLabel (pvt, sig) {
  if (!pvt || !pvt.gnssFixOK || pvt.fixType === 0) return ['No fix', 'bad']
  const src = corrSource(sig)
  if (pvt.carrSoln === 2) return ['RTK fixed', 'ok']
  if (pvt.carrSoln === 1) return [/HAS|SSR|SPARTN/.test(src) ? 'PPP (converging)' : 'RTK float', 'ok']
  if (pvt.diffSoln) return [`${pvt.fixTypeText} + ${src}`, 'ok']
  return [`${pvt.fixTypeText} fix`, pvt.fixType === 3 ? 'ok' : 'warn']
}
function corrSource (sig) {
  if (!sig) return 'none'
  const c = {}
  for (const s of sig.sigs) if (s.prUsed && s.corrSource !== 'none') c[s.corrSource] = (c[s.corrSource] || 0) + 1
  const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0]
  return best ? best[0] : 'none'
}
const STATE_CLASS = { none: 'ok', operational: 'ok', ok: 'ok', warning: 'warn', indicated: 'warn', test: 'warn', critical: 'bad', affirmed: 'bad', short: 'bad', open: 'bad' }
const badge = (text, cls) => h('span', { class: `badge ${cls || STATE_CLASS[text] || ''}` }, text)

function renderOverview () {
  const s = ui.status
  if (!s || !s.pvt) return h('div', { class: 'card' }, s ? s.status : 'Waiting for data…')
  const { pvt, hp, dop, sig, sec, osnma, rf } = s
  const pos = hp && !hp.invalidLlh ? hp : pvt
  const [label, cls] = fixLabel(pvt, sig)
  const used = sig ? sig.sigs.filter(x => x.prUsed).length : 0
  const accPct = Math.max(2, Math.min(100, 100 - Math.log10(Math.max(pos.hAcc, 0.01) / 0.01) * 33))
  const ant = rf && rf.blocks.length ? rf.blocks.map(b => b.antStatusText).find(x => x !== 'ok') || 'ok' : '–'
  // Columns: Fix over Accuracy, Position over Security, then Sky and Bands
  return h('div', { class: 'grid' },
    h('div', { class: 'stack' }, h('div', { class: 'card' }, h('h2', {}, 'Fix'),
      h('div', { class: 'row' }, badge(label, cls)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Satellites used'), h('dd', {}, `${pvt.numSV}`),
        h('dt', {}, 'Signals used / tracked'), h('dd', {}, sig ? `${used} / ${sig.sigs.length}` : '–'),
        h('dt', {}, 'Corrections'), h('dd', {}, corrSource(sig)),
        h('dt', {}, 'HDOP / PDOP'), h('dd', {}, dop ? `${fmt(dop.hDOP, 2)} / ${fmt(dop.pDOP, 2)}` : '–'),
        h('dt', {}, 'Update rate'), h('dd', {}, `${s.navHz} Hz`))),
    h('div', { class: 'card' }, h('h2', {}, 'Accuracy'),
      h('div', { class: 'big' }, fmtDist(pos.hAcc)), h('div', { class: 'muted small' }, 'horizontal, receiver estimate (1σ)'),
      h('div', { class: 'acc-bar' }, h('div', { style: `width:${accPct}%` })),
      h('dl', { class: 'kv', style: 'margin-top:10px' },
        h('dt', {}, 'Vertical'), h('dd', {}, fmtDist(pos.vAcc)),
        h('dt', {}, 'Speed'), h('dd', {}, `${fmt(pvt.sAcc * 1.94384, 2)} kn`),
        h('dt', {}, 'Time'), h('dd', {}, `${fmt(pvt.tAcc * 1e9, 0)} ns`)))),
    h('div', { class: 'stack' }, h('div', { class: 'card' }, h('h2', {}, 'Position'),
      h('div', { class: 'big', style: 'font-size:20px' }, ddm(pos.lat, 'N', 'S')),
      h('div', { class: 'big', style: 'font-size:20px' }, ddm(pos.lon, 'E', 'W')),
      h('dl', { class: 'kv', style: 'margin-top:8px' },
        h('dt', {}, 'SOG'), h('dd', {}, `${fmt(pvt.gSpeed * 1.94384, 2)} kn`),
        h('dt', {}, 'COG'), h('dd', {}, pvt.gSpeed > 0.25 ? `${fmt(pvt.headMot * 180 / Math.PI, 0)}° T` : '–'),
        h('dt', {}, 'Altitude (MSL)'), h('dd', {}, `${fmt(pos.hMSL, 2)} m`),
        h('dt', {}, 'Vertical speed'), h('dd', {}, `${fmt(-pvt.velD, 2)} m/s`),
        h('dt', {}, 'UTC'), h('dd', {}, pvt.time ? pvt.time.replace('T', ' ').replace(/\.\d+Z/, 'Z') : '–'))),
    h('div', { class: 'card' }, h('h2', {}, 'Security & integrity'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Jamming'), h('dd', {}, sec ? badge(sec.jamDetEnabled ? sec.jamStateText : 'disabled') : '–'),
        h('dt', {}, 'Spoofing'), h('dd', {}, sec ? badge(sec.spfDetEnabled ? sec.spfStateText : 'disabled') : '–'),
        h('dt', {}, 'Galileo OSNMA'), h('dd', {}, osnma ? badge(osnma.enabled ? osnma.nmaStatusText : 'disabled') : '–'),
        h('dt', {}, 'Galileo signals authenticated'), h('dd', {}, authenticatedSignals(sig)),
        h('dt', {}, 'Authenticated fix'), h('dd', {}, pvt.nmaFix ? badge('yes', 'ok') : badge('no')),
        h('dt', {}, 'Authenticated time'), h('dd', {}, pvt.authTime ? badge('yes', 'ok') : badge('no')),
        h('dt', {}, 'Antenna'), h('dd', {}, badge(ant))),
      sec && sec.bands.some(b => b.jammed)
        ? h('p', { class: 'small' }, 'Jammed bands: ', sec.bands.filter(b => b.jammed).map(b => FREQ_BAND[b.centFreqKHz] || `${b.centFreqKHz / 1000} MHz`).join(', '))
        : null)),
    h('div', { class: 'card sky' }, h('h2', {}, 'Sky'), skyPlot(s.sat)),
    h('div', { class: 'card' }, h('h2', {}, 'Bands'), bandSummary(sig))
  )
}

function skyPlot (sat) {
  const R = 150, C = 160
  const svg = [`<svg viewBox="0 0 320 320" role="img" aria-label="Satellite sky plot">`]
  for (const e of [0, 30, 60]) svg.push(`<circle cx="${C}" cy="${C}" r="${R * (90 - e) / 90}" fill="none" stroke="var(--line)"/>`)
  svg.push(`<line x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}" stroke="var(--line)"/><line x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}" stroke="var(--line)"/>`)
  svg.push(`<text x="${C}" y="12" text-anchor="middle" font-size="12" fill="var(--muted)">N</text>`)
  const present = new Set()
  for (const s of (sat && sat.sats) || []) {
    if (s.elev < 0 || (s.cno === 0 && !s.used)) continue
    const r = R * (90 - s.elev) / 90, a = s.azim * Math.PI / 180
    const x = C + r * Math.sin(a), y = C - r * Math.cos(a)
    const col = `var(--${GNSS_COLOR[s.gnss] || 'sbas'})`
    present.add(s.gnss)
    svg.push(`<g><title>${s.name} ${s.gnss}: elev ${s.elev}°, az ${s.azim}°, ${s.cno} dB-Hz${s.used ? ', used' : ''}</title>` +
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${s.used ? col : 'var(--panel)'}" stroke="${col}" stroke-width="2"/>` +
      `<text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" fill="${s.used ? '#fff' : col}">${s.svId}</text></g>`)
  }
  svg.push('</svg>')
  const wrap = h('div', { html: svg.join('') })
  wrap.append(h('div', { class: 'legend' }, [...present].map(g => h('span', {}, h('i', { style: `background:var(--${GNSS_COLOR[g] || 'sbas'})` }), g)),
    h('span', { class: 'muted' }, 'filled = used')))
  return wrap
}

function bandSummary (sig) {
  if (!sig) return h('div', { class: 'muted' }, 'No signal data')
  const b = {}
  for (const s of sig.sigs) {
    const k = s.band
    b[k] = b[k] || { tracked: 0, used: 0, cno: 0 }
    b[k].tracked++; if (s.prUsed) b[k].used++; b[k].cno += s.cno
  }
  const names = { L1: 'L1 / E1 / B1C', L2: 'L2 / E5b / B2I', L5: 'L5 / E5a / B2a', L6: 'E6 / B3I' }
  return h('table', {}, h('tr', {}, h('th', {}, 'Band'), h('th', {}, 'Tracked'), h('th', {}, 'Used'), h('th', {}, 'Avg C/N0')),
    Object.keys(b).sort().map(k => h('tr', {}, h('td', {}, names[k] || k), h('td', {}, b[k].tracked), h('td', {}, b[k].used), h('td', {}, `${fmt(b[k].cno / b[k].tracked, 0)} dB-Hz`))),
    b.L6 && !b.L6.used ? h('tr', {}, h('td', { colspan: 4, class: 'muted small' }, 'E6 is tracked but not used for positioning; it carries Galileo HAS corrections.')) : null)
}

function renderSignals () {
  const s = ui.status
  if (!s || !s.sig) return h('div', { class: 'card' }, 'Waiting for data…')
  const sigs = [...s.sig.sigs].sort((a, b) => a.gnssId - b.gnssId || a.svId - b.svId || a.sigId - b.sigId)
  const satBy = Object.fromEntries(((s.sat && s.sat.sats) || []).map(x => [x.name, x]))
  return h('div', {},
    h('div', { class: 'grid', style: 'margin-bottom:14px' },
      h('div', { class: 'card' }, h('h2', {}, 'RF front-end'),
        h('table', {}, h('tr', {}, h('th', {}, 'Block'), h('th', {}, 'Antenna'), h('th', {}, 'Noise'), h('th', {}, 'AGC'), h('th', {}, 'CW supp.')),
          ((s.rf && s.rf.blocks) || []).map(b => h('tr', {}, h('td', {}, b.blockId), h('td', {}, `${b.antStatusText} / ${b.antPowerText}`),
            h('td', {}, b.noisePerMS), h('td', {}, `${b.agcPercent}%`), h('td', {}, b.cwSuppression)))),
        h('p', { class: 'small muted' }, 'A sudden rise in noise or fall in AGC on one block suggests interference on that band.')),
      h('div', { class: 'card' }, h('h2', {}, 'Jamming by frequency'),
        s.sec ? h('table', {}, s.sec.bands.map(b => h('tr', {}, h('td', {}, FREQ_BAND[b.centFreqKHz] || `${b.centFreqKHz / 1000} MHz`),
          h('td', {}, badge(b.jammed ? 'jammed' : 'clear', b.jammed ? 'bad' : 'ok'))))) : '–')),
    h('div', { class: 'card scroll' }, h('h2', {}, `Signals (${sigs.length})`),
      h('table', {},
        h('tr', {}, ['SV', 'Signal', 'Elev', 'C/N0', 'Status', 'Corrections', 'Auth'].map(t => h('th', {}, t))),
        sigs.map(x => {
          const sat = satBy[x.sv] || {}
          const col = `var(--${GNSS_COLOR[x.gnss] || 'sbas'})`
          return h('tr', {},
            h('td', {}, h('span', { style: `color:${col};font-weight:600` }, x.sv)),
            h('td', {}, `${x.gnss} ${x.signal}`),
            h('td', {}, sat.elev !== undefined ? `${sat.elev}°` : ''),
            h('td', {}, h('span', { class: 'cno', style: `width:${Math.max(2, (x.cno - 15) * 2.5)}px;background:${col}` }), x.cno),
            h('td', {}, x.prUsed ? badge('used', 'ok') : h('span', { class: 'muted' }, ['no signal', 'searching', 'acquired', 'unusable', 'code lock', 'locked', 'locked', 'locked'][x.quality])),
            h('td', {}, x.corrSource === 'none' ? '' : x.corrSource),
            h('td', {}, x.authenticated ? '✓' : ''))
        }))))
}

// ---------- settings ----------
async function loadSettings () {
  try { ui.settings = await api('/settings') } catch (e) { ui.settings = { error: e.message } }
  render()
}
async function loadConfig () {
  try { ui.config = await api('/config') } catch (e) { ui.config = { error: e.message } }
  render()
}

function currentValue (key, values) { return key in ui.staged ? ui.staged[key] : values.ram[key] }
function stage (key, value, values) {
  if (value === values.ram[key]) delete ui.staged[key]; else ui.staged[key] = value
  render()
}

function control (key, def, values, opts = {}) {
  const v = currentValue(key, values)
  const supported = key in values.ram
  if (def.type === 'L') {
    return h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: !!v, disabled: !supported || opts.disabled, onchange: e => stage(key, e.target.checked, values) }),
      h('span'))
  }
  const options = opts.options || (def.consts && !/^X/.test(def.type) ? def.consts.map(c => [c.value, c.title]) : null)
  if (options) {
    const sel = h('select', { disabled: !supported, onchange: e => stage(key, Number(e.target.value), values) },
      options.map(([val, label]) => h('option', { value: val, selected: Number(val) === Number(v) }, label)))
    if (!options.some(([val]) => Number(val) === Number(v))) sel.prepend(h('option', { value: v, selected: true }, `${v} (custom)`))
    return sel
  }
  return h('span', { class: 'row' },
    h('input', { type: 'number', value: v, step: /^R/.test(def.type) ? 'any' : 1, disabled: !supported, onchange: e => stage(key, Number(e.target.value), values) }),
    opts.unit || def.unit ? h('span', { class: 'muted small' }, opts.unit || (def.scale ? `× ${def.scale} ${def.unit}` : def.unit)) : null)
}

function tags (key, values) {
  const t = []
  if (key in ui.staged) t.push(h('span', { class: 'tag changed' }, 'edited'))
  else {
    if (values.ram[key] !== values.def[key] && key in values.def) t.push(h('span', { class: 'tag' }, `default: ${fmtVal(values.def[key])}`))
    if (values.ram[key] !== values.saved[key] && key in values.saved) t.push(h('span', { class: 'tag unsaved' }, 'not saved'))
  }
  return t.length ? h('div', { class: 'tags' }, t) : null
}
const fmtVal = v => v === true ? 'on' : v === false ? 'off' : v

function settingRow (item, defs, values) {
  const def = defs[item.key]
  const supported = def && item.key in values.ram
  if (!supported && !item.unsupportedNote) return null
  return h('div', { class: `setting${item.key in ui.staged ? ' dirty' : ''}` },
    h('label', {}, item.label || def.title),
    supported ? control(item.key, def, values, item) : h('span', { class: 'badge warn' }, 'not available'),
    item.help || !supported ? h('div', { class: 'help' }, !supported ? item.unsupportedNote + ' ' : '', item.help || '') : null,
    supported ? tags(item.key, values) : null)
}

function signalsSection (sec, defs, values) {
  const info = ui.settings.info || {}
  const plans = (info.gnss && info.gnss.plans) || []
  const out = []
  if (sec.planKey && sec.planKey in values.ram && plans.length) {
    const cur = currentValue(sec.planKey, values)
    out.push(h('h3', { class: 'small muted' }, 'Signal plan'),
      h('p', { class: 'small muted' }, 'A signal plan is a tested combination of bands. Pick one, then fine-tune constellations below.'),
      plans.map(p => h('label', { class: `plan${p.id === cur ? ' active' : ''}` },
        h('input', { type: 'radio', name: 'plan', checked: p.id === cur, onchange: () => stage(sec.planKey, p.id, values) }), ' ',
        h('strong', {}, p.name), p.id === values.ram[sec.planKey] ? h('span', { class: 'tag' }, 'active') : null,
        h('div', { class: 'sig' }, Object.entries(p.signals).map(([g, s]) => `${g}: ${s.join(', ')}`).join(' · ')))),
      tags(sec.planKey, values))
  }
  for (const g of sec.groups) {
    if (!(g.master in values.ram)) continue
    const on = !!currentValue(g.master, values)
    out.push(h('div', { class: 'constellation' },
      h('div', { class: 'head' }, h('span', {}, g.title), control(g.master, defs[g.master], values)),
      h('div', { class: 'bands' }, g.items.filter(k => k in values.ram).map(k =>
        h('label', { class: k in ui.staged ? 'tag changed' : '' },
          h('input', { type: 'checkbox', checked: !!currentValue(k, values), disabled: !on, onchange: e => stage(k, e.target.checked, values) }),
          (defs[k].title || k).replace(/^(GPS|Galileo|BeiDou|GLONASS|QZSS|NavIC|SBAS) /, ''))))))
  }
  const e6 = 'CFG-SIGNAL-GAL_E6_ENA'
  if (e6 in values.ram && !currentValue(e6, values) && values.ram['CFG-NAVCOR-ENABLE_GAL_HAS']) {
    out.unshift(h('div', { class: 'banner' }, 'Galileo HAS is enabled but the E6 band is off: HAS corrections cannot be received.'))
  }
  return out
}

function actionBar (values) {
  const n = Object.keys(ui.staged).length
  if (!n) return null
  const touchesSignals = Object.keys(ui.staged).some(k => /^CFG-SIGNAL-/.test(k))
  return h('div', { class: 'actionbar' },
    h('strong', {}, `${n} change${n > 1 ? 's' : ''}`),
    touchesSignals ? h('span', { class: 'small muted' }, 'Signal changes restart satellite tracking: expect a few seconds without a fix.') : null,
    h('span', { class: 'spacer', style: 'flex:1' }),
    h('button', { class: 'btn', onclick: () => { ui.staged = {}; render() } }, 'Discard'),
    h('button', { class: 'btn', disabled: ui.busy, onclick: () => applyStaged(false) }, 'Try it (until power-off)'),
    h('button', { class: 'btn primary', disabled: ui.busy, onclick: () => applyStaged(true) }, 'Apply & save'))
}

async function applyStaged (persist) {
  const changes = Object.entries(ui.staged).map(([key, value]) => ({ key, value }))
  ui.busy = true; render()
  try {
    await api('/config', { changes, persist })
    ui.staged = {}
    toast(persist ? 'Applied and saved to the receiver' : 'Applied. Use “Save” to keep after power-off')
  } catch (e) { toast(`Failed: ${e.message}`) }
  ui.busy = false
  await (ui.tab === 'advanced' ? loadConfig() : loadSettings())
}

function pendingBanner (pending) {
  if (!pending || !pending.length) return null
  return h('div', { class: 'banner' },
    h('div', {}, h('strong', {}, `${pending.length} setting${pending.length > 1 ? 's are' : ' is'} active but not saved`),
      ' and will be lost when the receiver loses power.'),
    h('details', {}, h('summary', {}, 'Show'), h('ul', { class: 'small' }, pending.map(p => h('li', {}, `${p.title || p.key}: ${fmtVal(p.live)} (saved: ${fmtVal(p.saved)})`)))),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => doAction('/save', 'Saved to the receiver') }, 'Save'),
      h('button', { class: 'btn', onclick: () => doAction('/revert', 'Reverted to saved settings') }, 'Revert')))
}

async function doAction (path, ok, body = {}) {
  ui.busy = true; render()
  try { await api(path, body); toast(ok) } catch (e) { toast(`Failed: ${e.message}`) }
  ui.busy = false
  await (ui.tab === 'advanced' ? loadConfig() : loadSettings())
}

function renderSettings () {
  const st = ui.settings
  if (!st) { loadSettings(); return h('div', { class: 'card' }, 'Reading receiver settings…') }
  if (st.error) return h('div', { class: 'banner error' }, st.error)
  const { sections, defs, values } = st
  const fw = st.info && st.info.version
  return h('div', {},
    pendingBanner(st.pending),
    sections.map(sec => {
      let body
      if (sec.groups) body = signalsSection(sec, defs, values)
      else {
        const basic = sec.items.filter(i => !i.advanced).map(i => settingRow(i, defs, values)).filter(Boolean)
        const adv = sec.items.filter(i => i.advanced).map(i => settingRow(i, defs, values)).filter(Boolean)
        if (!basic.length && !adv.length) return null
        body = [basic, adv.length ? h('details', {}, h('summary', {}, 'More options'), adv) : null]
      }
      return h('div', { class: 'card section' }, h('h2', {}, sec.title), sec.intro ? h('p', {}, sec.intro) : null, body)
    }),
    fw ? h('p', { class: 'small muted' }, `Receiver firmware ${fw.firmware}. Settings marked “not available” need newer firmware.`) : null,
    actionBar(values))
}

function renderAdvanced () {
  const c = ui.config
  if (!c) { loadConfig(); return h('div', { class: 'card' }, 'Reading all receiver settings…') }
  if (c.error) return h('div', { class: 'banner error' }, c.error)
  const { defs, values, groups } = c
  const q = ui.advFilter.toLowerCase()
  const keys = Object.keys(defs).filter(k => (!ui.advGroup || k.split('-')[1] === ui.advGroup) &&
    (!q || k.toLowerCase().includes(q) || (defs[k].title || '').toLowerCase().includes(q)))
  const groupNames = [...new Set(Object.keys(defs).map(k => k.split('-')[1]))].sort()
  const shown = keys.slice(0, 250)
  return h('div', {},
    h('div', { class: 'banner' }, 'Every setting the receiver reports. Changes here are applied exactly as entered. If unsure, use the Settings tab.'),
    h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('input', { type: 'search', placeholder: 'Search name or description', value: ui.advFilter, oninput: e => { ui.advFilter = e.target.value; render(); refocus('search') }, 'data-focus': 'search' }),
      h('select', { onchange: e => { ui.advGroup = e.target.value; render() } },
        h('option', { value: '' }, 'All groups'),
        groupNames.map(g => h('option', { value: g, selected: g === ui.advGroup }, `${g}${groups[g] ? ' – ' + groups[g].title : ''}`))),
      h('span', { class: 'muted small' }, `${keys.length} settings${keys.length > shown.length ? `, showing ${shown.length}` : ''} · ${c.hidden} undocumented keys hidden`)),
    h('div', { class: 'card scroll' }, h('table', {},
      h('tr', {}, h('th', {}, 'Setting'), h('th', {}, 'Value'), h('th', {}, 'Default'), h('th', {}, '')),
      shown.map(k => h('tr', { class: 'adv-row' },
        h('td', {}, h('div', {}, defs[k].title || k), h('div', { class: 'muted small' }, k)),
        h('td', {}, control(k, defs[k], values)),
        h('td', { class: 'small muted' }, fmtVal(values.def[k])),
        h('td', {}, values.ram[k] !== values.saved[k] ? h('span', { class: 'tag unsaved' }, 'not saved') : null,
          k in ui.staged ? h('span', { class: 'tag changed' }, 'edited') : null))))),
    actionBar(values))
}
function refocus (name) {
  const el = document.querySelector(`[data-focus="${name}"]`)
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
}

function renderDevice () {
  const s = ui.status
  if (!s || !s.info || !s.info.version) return h('div', { class: 'card' }, s ? s.status : 'Waiting…')
  const v = s.info.version, sys = s.sys
  const restart = (type, text) => () => {
    if (confirm(`${text}\n\nThe receiver will lose its fix briefly. Continue?`)) doAction('/restart', `${type} start requested`, { type })
  }
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h2', {}, 'Receiver'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Module'), h('dd', {}, v.module || '–'),
        h('dt', {}, 'Firmware'), h('dd', {}, v.firmware || v.sw),
        h('dt', {}, 'Protocol'), h('dd', {}, v.protocol || '–'),
        h('dt', {}, 'Hardware'), h('dd', {}, v.hw),
        h('dt', {}, 'Systems'), h('dd', { class: 'wrap' }, v.gnss.join(', '))),
      /HPG 2\.(0|10)\b/.test(v.firmware || '') ? h('p', { class: 'small' }, 'Firmware HPG 2.11 or later adds Galileo HAS corrections.') : null),
    sys ? h('div', { class: 'card' }, h('h2', {}, 'Health'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'CPU load'), h('dd', {}, `${sys.cpuLoad}% (peak ${sys.cpuLoadMax}%)`),
        h('dt', {}, 'Memory'), h('dd', {}, `${sys.memUsage}%`),
        h('dt', {}, 'I/O'), h('dd', {}, `${sys.ioUsage}%`),
        h('dt', {}, 'Uptime'), h('dd', {}, `${Math.floor(sys.runTime / 3600)} h ${Math.floor(sys.runTime % 3600 / 60)} min`),
        h('dt', {}, 'Notices / warnings / errors'), h('dd', {}, `${sys.notices} / ${sys.warnings} / ${sys.errors}`))) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Restart GNSS'),
      h('p', { class: 'small muted' }, 'Restarts satellite tracking only; settings are kept.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: restart('hot', 'Hot start keeps all satellite data.') }, 'Hot'),
        h('button', { class: 'btn', onclick: restart('warm', 'Warm start clears satellite orbits (ephemeris). Fix takes ~30 s.') }, 'Warm'),
        h('button', { class: 'btn danger', onclick: restart('cold', 'Cold start clears all navigation data. Fix may take a minute or more.') }, 'Cold'))),
    osnmaCard(s),
    backupCard(),
    h('div', { class: 'card' }, h('h2', {}, 'Data link'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'UBX messages'), h('dd', {}, s.parser.ubx),
        h('dt', {}, 'NMEA sentences'), h('dd', {}, s.parser.nmea),
        h('dt', {}, 'Checksum errors'), h('dd', {}, s.parser.badChecksum)),
      h('details', {}, h('summary', {}, 'Messages received'),
        h('dl', { class: 'kv small' }, Object.entries(s.counts).map(([k, n]) => [h('dt', {}, k), h('dd', {}, n)])))))
}

// ---------- Galileo OSNMA ----------
function authenticatedSignals (sig) {
  const gal = sig ? sig.sigs.filter(x => x.gnss === 'Galileo' && x.cno > 0) : []
  return gal.length ? `${gal.filter(x => x.authenticated).length} / ${gal.length}` : '–'
}

async function uploadOsnmaKeys (fileList) {
  ui.picking = false
  if (!fileList || !fileList.length) return
  ui.busy = true; render()
  try {
    const files = await Promise.all([...fileList].map(async f => ({ name: f.name, text: await f.text() })))
    ui.osnmaResult = await api('/osnma/keys', { files })
  } catch (e) { ui.osnmaResult = { error: e.message } }
  ui.busy = false; render()
}

async function sendTrustedTime () {
  try {
    const r = await api('/osnma/time', {})
    toast(r.sent ? 'Trusted time sent to the receiver' : 'Not sent: this computer\'s clock is not synchronised to network time')
  } catch (e) { toast(`Failed: ${e.message}`) }
}

function osnmaCard (s) {
  const o = s.osnma
  const r = ui.osnmaResult
  const yes = (v, okText = 'valid', badText = 'not valid') => badge(v ? okText : badText, v ? 'ok' : 'warn')
  const tt = s.trustedTime
  return h('div', { class: 'card' }, h('h2', {}, 'Galileo OSNMA'),
    !o ? h('p', { class: 'muted small' }, 'No OSNMA status from the receiver.') : h('dl', { class: 'kv' },
      h('dt', {}, 'Service'), h('dd', {}, badge(o.enabled ? o.nmaStatusText : 'disabled')),
      h('dt', {}, 'Key in use by satellites'), h('dd', {}, o.pubKeyId ? `ID ${o.pubKeyId}` : '–'),
      h('dt', {}, 'Merkle tree root'), h('dd', {}, yes(o.merkleRootValid), h('div', { class: 'small muted' }, o.merkleRootSrc)),
      h('dt', {}, 'Public key'), h('dd', {}, yes(o.pubKeyValid), h('div', { class: 'small muted' }, o.pubKeySrc)),
      // SEC-OSNMA's own authentication counters stay at zero on HPG 2.11; the per-signal flags in
      // NAV-SIG and the NAV-PVT fix/time flags are what actually reflect authentication.
      h('dt', {}, 'Galileo signals authenticated'), h('dd', {}, authenticatedSignals(s.sig)),
      h('dt', {}, 'Authenticated fix'), h('dd', {}, s.pvt && s.pvt.nmaFix ? badge('yes', 'ok') : badge('no')),
      h('dt', {}, 'Authenticated time'), h('dd', {}, s.pvt && s.pvt.authTime ? badge('yes', 'ok') : badge('no'))),
    h('p', { class: 'small muted' }, 'Key material is free from the European GNSS Service Centre: download the Merkle tree (gsc-europa.eu/gsc-products/OSNMA/MT) and public key (…/OSNMA/PKI) files, then load them here. Select both at once.'),
    h('div', { class: 'row' },
      h('label', { class: 'btn primary', onclick: holdWhilePicking }, 'Load GSC key files…',
        h('input', { type: 'file', multiple: true, accept: '.xml,.crt,.pem,.cer', style: 'display:none', onchange: e => uploadOsnmaKeys(e.target.files) })),
      h('button', { class: 'btn', onclick: sendTrustedTime }, 'Send trusted time')),
    tt ? h('p', { class: 'small muted' }, `Trusted time ${tt.sent ? 'last sent' : 'not sent (clock not network-synchronised)'} at ${new Date(tt.at).toLocaleTimeString()}`) : null,
    r ? (r.error
      ? h('div', { class: 'banner error', style: 'margin-top:10px' }, r.error)
      : h('div', { class: 'banner', style: 'margin-top:10px' },
        `Sent ${[r.sent.merkleRoot ? 'Merkle root' : null, r.sent.pubKeyId !== null ? `public key ID ${r.sent.pubKeyId}` : null].filter(Boolean).join(' and ')}`,
        r.sent.satellitesUse && r.sent.pubKeyId !== r.sent.satellitesUse ? ` (satellites use ID ${r.sent.satellitesUse}: the files may be out of date)` : '',
        `. Receiver now reports root ${r.receiver.merkleRootValid ? 'valid' : 'not yet valid'} (${r.receiver.merkleRootSrc}), key ${r.receiver.pubKeyValid ? 'valid' : 'not yet valid'} (${r.receiver.pubKeySrc}). Authentication then takes a few minutes.`)) : null)
}

// ---------- backup / restore ----------
async function downloadBackup () {
  try {
    const b = await api('/backup')
    const name = `x20p-config-${(b.receiver.firmware || 'fw').replace(/\s+/g, '')}-${b.created.slice(0, 19).replace(/[:T]/g, '-')}.json`
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' })), download: name })
    document.body.append(a); a.click(); a.remove()
    toast(`Saved ${b.flash.length + b.bbr.length} settings to ${name}`)
  } catch (e) { toast(`Backup failed: ${e.message}`) }
}

// Live refresh would replace the file input while its dialog is open; hold it until the dialog closes
function holdWhilePicking () {
  ui.picking = true
  window.addEventListener('focus', () => setTimeout(() => { ui.picking = false }, 1000), { once: true })
}

async function pickRestoreFile (file) {
  ui.picking = false
  if (!file) return
  try {
    const backup = JSON.parse(await file.text())
    ui.restore = { backup, fileName: file.name, plan: await api('/restore', { backup, dryRun: true }) }
  } catch (e) { ui.restore = { error: e.message } }
  render()
}

async function runRestore () {
  ui.busy = true; render()
  try {
    const r = await api('/restore', { backup: ui.restore.backup })
    ui.restore = { result: r }
    toast(`Restored ${r.restored} setting${r.restored === 1 ? '' : 's'}`)
  } catch (e) { ui.restore.error = e.message }
  ui.busy = false; render()
}

function backupCard () {
  const r = ui.restore || {}
  const plan = r.plan
  return h('div', { class: 'card' }, h('h2', {}, 'Configuration backup'),
    h('p', { class: 'small muted' }, 'Saves every setting the receiver loads at power-up to a file. Do this before a firmware update or factory reset, then restore afterwards.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: downloadBackup }, 'Download backup'),
      h('label', { class: 'btn', onclick: holdWhilePicking }, 'Restore from file…',
        h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: e => pickRestoreFile(e.target.files[0]) }))),
    r.error ? h('div', { class: 'banner error', style: 'margin-top:10px' }, r.error) : null,
    plan ? h('div', { style: 'margin-top:10px' },
      h('div', { class: 'small' }, h('strong', {}, r.fileName), ` (made ${new Date(r.backup.created).toLocaleString()} on ${r.backup.receiver.firmware || '?'})`),
      plan.warnings.map(w => h('div', { class: 'banner', style: 'margin:8px 0' }, w)),
      plan.apply.length
        ? h('details', { open: plan.apply.length <= 12 }, h('summary', {}, `${plan.apply.length} setting${plan.apply.length > 1 ? 's' : ''} will change`),
          h('ul', { class: 'small' }, plan.apply.map(a => h('li', {}, `${a.title || a.name}: ${fmtVal(a.from)} → ${fmtVal(a.to)}`))))
        : h('p', { class: 'small' }, 'The receiver already matches this backup.'),
      h('p', { class: 'small muted' }, `${plan.unchanged} already match`,
        plan.unsupported.length ? `, ${plan.unsupported.length} not supported by this firmware and skipped` : '',
        plan.forbidden.length ? `, ${plan.forbidden.length} protected and skipped` : ''),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: ui.busy || !plan.apply.length, onclick: runRestore }, `Restore ${plan.apply.length} setting${plan.apply.length === 1 ? '' : 's'}`),
        h('button', { class: 'btn', onclick: () => { ui.restore = null; render() } }, 'Cancel'))) : null,
    r.result ? h('div', { class: 'banner', style: 'margin-top:10px' },
      `Restored and saved ${r.result.restored} setting${r.result.restored === 1 ? '' : 's'}.`,
      r.result.failed.length ? ` Rejected by the receiver: ${r.result.failed.join(', ')}.` : '',
      r.result.apply.some(a => /^CFG-SIGNAL-/.test(a.name)) ? ' Signal settings changed, so tracking restarted briefly.' : '') : null)
}

// ---------- shell ----------
function render () {
  const views = { overview: renderOverview, signals: renderSignals, settings: renderSettings, advanced: renderAdvanced, device: renderDevice }
  const main = $main()
  const y = window.scrollY
  // Don't rebuild a settings form under the user's cursor while they're picking from a select
  if ((ui.tab === 'settings' || ui.tab === 'advanced') && document.activeElement && document.activeElement.tagName === 'SELECT') return
  main.replaceChildren(views[ui.tab]())
  window.scrollTo(0, y)
}

document.getElementById('tabs').addEventListener('click', e => {
  const tab = e.target.dataset && e.target.dataset.tab
  if (!tab) return
  if (Object.keys(ui.staged).length && !confirm('Discard unapplied changes?')) return
  ui.staged = {}
  showTab(tab)
})

function showTab (tab) {
  ui.tab = tab
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === tab)
  if (tab === 'settings') ui.settings = null
  if (tab === 'advanced') ui.config = null
  history.replaceState(null, '', `#${tab}`)
  render()
}

const themeSel = document.getElementById('theme')
function setTheme (t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme
  try { localStorage.setItem('x20p-theme', t) } catch (e) {}
}
try { themeSel.value = localStorage.getItem('x20p-theme') || '' } catch (e) {}
setTheme(themeSel.value)
themeSel.addEventListener('change', () => setTheme(themeSel.value))

const initial = location.hash.slice(1)
if (['overview', 'signals', 'settings', 'advanced', 'device'].includes(initial)) showTab(initial); else render()
pollStatus()
setInterval(pollStatus, 1000)
