'use strict'
// Curated, user-friendly view of the receiver configuration. Every item refers to a CFG key;
// type, range and enum values come from the key database, the text here is what the user sees.
// Items whose key the connected receiver doesn't support are hidden (or shown with `unsupported`).

const BAUD = [4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
const MSG_RATE = [[0, 'Off'], [1, 'Every fix'], [2, 'Every 2nd fix'], [5, 'Every 5th fix'], [10, 'Every 10th fix']]

const NMEA_MSGS = [
  ['GGA', 'Position and fix quality'],
  ['RMC', 'Recommended minimum (position, SOG, COG, date)'],
  ['VTG', 'Course and speed over ground'],
  ['GSA', 'Satellites used and DOP'],
  ['GSV', 'Satellites in view'],
  ['GST', 'Position error statistics'],
  ['ZDA', 'Date and time'],
  ['GNS', 'Multi-constellation fix data'],
  ['GLL', 'Geographic position'],
  ['GBS', 'Satellite fault detection']
]

function nmeaPort (port, label) {
  return {
    id: `nmea-${port.toLowerCase()}`,
    title: `NMEA output on ${label}`,
    intro: `Which NMEA 0183 sentences the receiver sends on ${label}. Useful for feeding a chart plotter, VHF/AIS or a backup NMEA connection directly.`,
    items: NMEA_MSGS.map(([m, text]) => ({
      key: `CFG-MSGOUT-NMEA_ID_${m}_${port}`, label: m, help: text, options: MSG_RATE
    }))
  }
}

const SECTIONS = [
  {
    id: 'navigation',
    title: 'Navigation',
    intro: 'How the receiver computes and filters your position.',
    items: [
      {
        key: 'CFG-NAVSPG-DYNMODEL', label: 'Platform type', recommended: 5,
        help: '"Sea" assumes zero vertical velocity on average and moderate accelerations, which suits most boats. "Automotive" or "Portable" may suit fast planing craft.'
      },
      {
        key: 'CFG-RATE-MEAS', label: 'Position update rate', recommended: 1000,
        options: [[1000, '1 per second (1 Hz)'], [500, '2 per second (2 Hz)'], [250, '4 per second (4 Hz)'], [200, '5 per second (5 Hz)'], [100, '10 per second (10 Hz)']],
        help: '1–2 Hz is plenty for navigation. Higher rates help performance instruments and autopilots but increase load on the receiver and Signal K.'
      },
      {
        key: 'CFG-NAVSPG-INFIL_MINELEV', label: 'Elevation mask', unit: '°',
        help: 'Satellites below this angle are not used. Low satellites suffer most from reflections off the water. 10–15° is a good range afloat.'
      },
      {
        key: 'CFG-NAVSPG-INFIL_MINCNO', label: 'Minimum signal strength', unit: 'dB-Hz',
        help: 'Signals weaker than this are not used for navigation. Raising it can reject reflected signals at the cost of fewer satellites.'
      },
      { key: 'CFG-NAVSPG-FIXMODE', label: 'Fix mode', help: 'Auto lets the receiver drop to a 2D fix when too few satellites are visible.' },
      { key: 'CFG-NAVHPG-DGNSSMODE', label: 'Carrier-phase ambiguity mode', advanced: true, help: 'Only relevant with RTK corrections.' }
    ]
  },
  {
    id: 'signals',
    title: 'Constellations & signals',
    intro: 'Which satellite systems and frequency bands to track. More systems usually means a more robust fix; the E6 band is required for Galileo HAS corrections.',
    planKey: 'CFG-SIGNAL-PLAN',
    groups: [
      { title: 'GPS (USA)', master: 'CFG-SIGNAL-GPS_ENA', items: ['CFG-SIGNAL-GPS_L1CA_ENA', 'CFG-SIGNAL-GPS_L2C_ENA', 'CFG-SIGNAL-GPS_L5_ENA'] },
      { title: 'Galileo (EU)', master: 'CFG-SIGNAL-GAL_ENA', items: ['CFG-SIGNAL-GAL_E1_ENA', 'CFG-SIGNAL-GAL_E5A_ENA', 'CFG-SIGNAL-GAL_E5B_ENA', 'CFG-SIGNAL-GAL_E6_ENA'] },
      { title: 'BeiDou (China)', master: 'CFG-SIGNAL-BDS_ENA', items: ['CFG-SIGNAL-BDS_B1_ENA', 'CFG-SIGNAL-BDS_B1C_ENA', 'CFG-SIGNAL-BDS_B2_ENA', 'CFG-SIGNAL-BDS_B2A_ENA', 'CFG-SIGNAL-BDS_B3_ENA'] },
      { title: 'GLONASS (Russia)', master: 'CFG-SIGNAL-GLO_ENA', items: ['CFG-SIGNAL-GLO_L1_ENA', 'CFG-SIGNAL-GLO_L2_ENA'] },
      { title: 'QZSS (Japan)', master: 'CFG-SIGNAL-QZSS_ENA', items: ['CFG-SIGNAL-QZSS_L1CA_ENA', 'CFG-SIGNAL-QZSS_L1S_ENA', 'CFG-SIGNAL-QZSS_L2C_ENA', 'CFG-SIGNAL-QZSS_L5_ENA'] },
      { title: 'NavIC (India)', master: 'CFG-SIGNAL-NAVIC_ENA', items: ['CFG-SIGNAL-NAVIC_L5_ENA'] },
      { title: 'SBAS (EGNOS / WAAS)', master: 'CFG-SIGNAL-SBAS_ENA', items: ['CFG-SIGNAL-SBAS_L1CA_ENA'] }
    ]
  },
  {
    id: 'corrections',
    title: 'Corrections',
    intro: 'Free correction services received directly from satellites. No internet needed.',
    items: [
      {
        key: 'CFG-NAVCOR-ENABLE_GAL_HAS', label: 'Galileo HAS (High Accuracy Service)',
        help: 'Free precise corrections broadcast on the Galileo E6-B signal. Covers GPS and Galileo satellites; typically decimetre accuracy after convergence (tens of minutes). Used whenever no RTCM/SPARTN corrections are available. Needs the Galileo E6 band enabled and an antenna covering E6. Not available over China, Japan and Korea.',
        unsupportedNote: 'Requires receiver firmware HPG 2.11 or later.'
      },
      { key: 'CFG-SBAS-USE_DIFFCORR', label: 'Use SBAS corrections', help: 'Apply EGNOS/WAAS differential corrections (~1 m accuracy).' },
      { key: 'CFG-SBAS-USE_RANGING', label: 'Use SBAS satellites for ranging', help: 'Use SBAS satellites as extra ranging sources.' },
      { key: 'CFG-SBAS-USE_INTEGRITY', label: 'Use SBAS integrity', help: 'Exclude satellites SBAS flags as unhealthy. Can reduce availability.' },
      { key: 'CFG-SBAS-USE_TESTMODE', label: 'Accept SBAS in test mode', advanced: true, help: 'Use SBAS data broadcast in test mode. Normally off.' }
    ]
  },
  {
    id: 'security',
    title: 'Security & integrity',
    intro: 'Protection against jamming and spoofing, increasingly common in some sea areas.',
    items: [
      {
        key: 'CFG-GAL-USE_OSNMA', label: 'Galileo OSNMA authentication',
        help: 'Cryptographically verifies Galileo navigation messages so a spoofer cannot fake them. Recommended on. Needs current key material (Receiver tab).'
      },
      {
        key: 'CFG-GAL-OSNMA_TIMESYNC', label: 'Require trusted time for OSNMA',
        help: 'Full OSNMA protection needs the receiver to know the time from an independent source, which defeats replay (delayed-signal) attacks. If no trusted time is available, turning this off still authenticates navigation data but without replay protection.'
      },
      { key: 'CFG-SEC-JAMDET_SENSITIVITY_HI', label: 'High-sensitivity jamming detection', help: 'Detects weaker jamming at the cost of more false alarms.' },
      { key: 'CFG-SEC-SPOOFDET_SIM_SIG_DIS', label: 'Disable simulated-signal spoofing detection', advanced: true, help: 'Only turn on when testing with a GNSS simulator.' }
    ]
  },
  {
    id: 'antenna',
    title: 'Antenna',
    intro: 'Active antenna supply and supervision.',
    items: [
      { key: 'CFG-HW-ANT_CFG_VOLTCTRL', label: 'Antenna power control', help: 'Lets the receiver switch antenna power (needed for short/open detection on most boards).' },
      { key: 'CFG-HW-ANT_CFG_SHORTDET', label: 'Detect short circuit', help: 'Reports a shorted antenna cable.' },
      { key: 'CFG-HW-ANT_CFG_OPENDET', label: 'Detect open circuit', help: 'Reports a disconnected antenna.' },
      { key: 'CFG-HW-ANT_CFG_RECOVER', label: 'Auto-recover after short', help: 'Re-enable antenna power automatically once a short clears.' }
    ]
  },
  {
    id: 'ports',
    title: 'Ports & NMEA',
    intro: 'The plugin talks UBX over USB. The UARTs can feed other equipment at the same time.',
    items: [
      { key: 'CFG-USBOUTPROT-NMEA', label: 'NMEA on USB', help: 'Not needed by this plugin. Turning it off saves USB bandwidth at high update rates.' },
      { key: 'CFG-UART1-BAUDRATE', label: 'UART1 baud rate', options: BAUD.map(b => [b, String(b)]) },
      { key: 'CFG-UART1OUTPROT-NMEA', label: 'UART1 NMEA output' },
      { key: 'CFG-UART1OUTPROT-UBX', label: 'UART1 UBX output', advanced: true },
      { key: 'CFG-UART1INPROT-RTCM3X', label: 'UART1 accepts RTCM3 corrections', advanced: true },
      { key: 'CFG-UART2-BAUDRATE', label: 'UART2 baud rate', options: BAUD.map(b => [b, String(b)]) },
      { key: 'CFG-UART2OUTPROT-NMEA', label: 'UART2 NMEA output' },
      { key: 'CFG-UART2INPROT-RTCM3X', label: 'UART2 accepts RTCM3 corrections', advanced: true },
      { key: 'CFG-NMEA-PROTVER', label: 'NMEA version', help: '4.11 adds signal IDs; 4.10 is the most widely compatible with chart plotters.' },
      { key: 'CFG-NMEA-HIGHPREC', label: 'High-precision NMEA', help: 'Extra decimal places in positions. Some older devices can\'t parse it.' },
      { key: 'CFG-NMEA-MAINTALKERID', label: 'Talker ID', advanced: true, help: 'Force e.g. GP for old equipment that only understands $GP sentences.' }
    ]
  },
  nmeaPort('UART1', 'UART1'),
  nmeaPort('UART2', 'UART2')
]

// All keys referenced by the curated model
function curatedKeys () {
  const keys = new Set()
  for (const s of SECTIONS) {
    for (const it of s.items || []) keys.add(it.key)
    if (s.planKey) keys.add(s.planKey)
    for (const g of s.groups || []) { keys.add(g.master); g.items.forEach(k => keys.add(k)) }
  }
  return [...keys]
}

module.exports = { SECTIONS, curatedKeys }
