# signalk-ublox-x20p

Signal K plugin for the u-blox ZED-X20P (all-band, high-precision GNSS), talking the receiver's native
UBX protocol instead of NMEA 0183. It also works with other UBX generation-9+ receivers (F9P etc.), as it
discovers which settings the connected receiver supports.

## What you get

**Signal K data** (source: `signalk-ublox-x20p`), published once per navigation epoch:

| Path | Notes |
|---|---|
| `navigation.position` | High-precision (NAV-HPPOSLLH), altitude MSL |
| `navigation.speedOverGround`, `navigation.courseOverGroundTrue` | COG suppressed below a configurable speed |
| `navigation.datetime`, `navigation.magneticVariation` | optional |
| `navigation.headingTrue` | optional, from a moving-base receiver (NAV-RELPOSNED) |
| `navigation.gnss.methodQuality`, `.integrity`, `.satellites`, `.satellitesInView`, `.horizontalDilution`, `.positionDilution`, `.antennaAltitude`, `.geoidalSeparation`, `.differentialAge` | standard paths |
| `navigation.gnss.horizontalAccuracy`, `.verticalAccuracy`, `.speedAccuracy`, `.courseAccuracy`, `.timeAccuracy` | receiver accuracy estimates (custom) |
| `navigation.gnss.velocityNorth`, `.velocityEast`, `.velocityDown` | 3D velocity (custom) |
| `navigation.gnss.correctionSource`, `.carrierSolution`, `.signalsTracked`, `.signalsUsed`, `.verticalDilution`, `.timeDilution` | custom |
| `navigation.gnss.jamming`, `.spoofing`, `.osnma`, `.antennaStatus` | security state (custom) |
| `notifications.navigation.gnss.jamming` / `.spoofing` / `.antenna` / `.fix` | warn / alarm |

Custom paths are published with Signal K `meta` (units and description).

**Web app** (Signal K admin → Webapps → *u-blox X20P GNSS*):
- *Overview*: fix, accuracy, position, security and integrity, sky plot, band summary
- *Signals*: every tracked signal with C/N0, use, corrections, OSNMA authentication; RF front-end and per-band jamming
- *Settings*: plain-language receiver configuration (platform, rate, constellations and signal plan,
  corrections, security, antenna, UART/NMEA outputs). Changes can be tried (RAM only) or applied and saved
- *All settings*: searchable editor for every documented configuration key
- *Receiver*: firmware, health, hot/warm/cold restart, **Galileo OSNMA key loading**, and **configuration backup/restore**. A backup is
  a JSON file of every value the receiver loads at power-up (flash + BBR, including undocumented keys).
  Restore shows a preview first, skips keys the current firmware doesn't support, and writes the rest
  to RAM + BBR + flash.

## Galileo HAS and OSNMA

- **Galileo HAS** (free decimetre-level PPP corrections broadcast on Galileo E6) needs receiver firmware
  HPG 2.11 or later and an antenna covering E6. Enable it under *Settings → Corrections*.
- **Galileo OSNMA** (navigation message authentication against spoofing) needs current key material.
  Download the *Applicable* Merkle tree and public key **product xml** files from the European GNSS
  Service Centre (free registration: gsc-europa.eu → OSNMA), then use *Receiver → Load GSC key files*.
  The plugin checks the public key against the Merkle tree root before sending anything.
- OSNMA's anti-replay check needs **trusted time**. With the plugin option *Give the receiver trusted
  time* enabled, the host clock is sent to the receiver, but only while it is synchronised to network
  NTP (not to this GNSS). Without trusted time you can turn off *Settings → Security → Require trusted
  time for OSNMA*, which keeps authentication but without replay protection.

## Installation (on the Signal K host)

Install from the Signal K App Store (*Appstore → Available → u-blox X20P GNSS*), or manually:

1. Remove or disable any existing Signal K data connection using the receiver's port.
2. Install into the Signal K config directory:
   ```sh
   cd ~/.signalk
   npm install /path/to/signalk-ublox-x20p
   ```
3. Restart Signal K, enable the plugin under *Server → Plugin Config*, and set the serial device
   (default `/dev/serial/by-id/usb-u-blox_AG_-_www.u-blox.com_u-blox_GNSS_receiver-if00`).
4. Recommended: stop ModemManager probing the receiver for ~20 s every time it is plugged in.
   ModemManager mistakes it for a modem, holds the port and sends it AT commands:
   ```sh
   echo 'ATTRS{idVendor}=="1546", ENV{ID_MM_DEVICE_IGNORE}="1"' | sudo tee /etc/udev/rules.d/99-ublox-no-modemmanager.rules
   sudo udevadm control --reload-rules
   ```

Writing settings through the API requires a Signal K admin login when security is enabled.

## How it treats the receiver

- On connect, the plugin enables the UBX messages it needs **in RAM only**. A power cycle restores
  the receiver's saved configuration; your NMEA outputs are left alone.
- Settings changes from the UI go to RAM ("Try it"), or to RAM + BBR + flash ("Apply & save").
  The *Settings* page lists anything active but unsaved, with *Save* and *Revert* buttons.
- `CFG-SEC-CFG_LOCK*` (permanent configuration lockdown) can never be written by this plugin.

## Development

`tools/` contains helpers that run without Signal K, against a receiver on the local machine:

- `node tools/probe.js /dev/ttyACM0` is a minimal read-only probe
- `node tools/live.js /dev/ttyACM0` exercises the library layer (read-only)
- `node tools/sk-sim.js /dev/ttyACM0` runs the plugin with a mock Signal K app and prints the deltas
- `node tools/dev-server.js /dev/ttyACM0 3999` serves the web app and API standalone at
  `http://host:3999/signalk-ublox-x20p/`. **It has no authentication.**

`lib/data/cfg-keys.json` is generated by `tools/build-cfgdb.js` from u-blox's official interface
description JSON ([u-blox-X20-interface-description-json](https://github.com/u-blox/u-blox-X20-interface-description-json)),
merging HPG 2.02, 2.10 and 2.11 so every key from those firmwares is named. u-blox's README for that
repository permits use, copying, modification and distribution. To refresh it for a new firmware,
download the new JSON and rerun the script with all versions, oldest first.

## Licence

Apache-2.0. Configuration key definitions in `lib/data/cfg-keys.json` are derived from u-blox's
interface description JSON, which u-blox permits to be used, copied, modified and distributed.
