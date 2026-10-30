# u-blox X20P GNSS for Signal K

Get everything your u-blox ZED-X20P all-band GNSS receiver knows into Signal K, and configure the
receiver from a friendly web page instead of u-center.

The plugin talks to the receiver in its native UBX protocol rather than NMEA 0183. That gives you
the receiver's real accuracy estimates (not just HDOP), free decimetre-level corrections from
**Galileo HAS**, **jamming and spoofing alarms**, **Galileo OSNMA** signal authentication, and
every signal on every band, none of which NMEA can carry.

![Overview: fix, accuracy, position, security and integrity, sky plot and bands](https://raw.githubusercontent.com/g0kad/signalk-ublox-x20p/main/doc/screenshots/overview.png)

## Features

- **Precise position and real accuracy.** High-precision position, speed and course, 3D velocity,
  and the receiver's own horizontal, vertical, speed and time accuracy estimates, published to Signal K.
- **Galileo HAS.** Switch on the free High Accuracy Service broadcast on Galileo E6: typically
  around 10 cm horizontal after a few minutes' convergence, with no internet connection or subscription.
- **Jamming and spoofing protection.** The receiver's interference and spoofing detectors, antenna
  supervision and Galileo OSNMA authentication, as Signal K values and notifications (warn/alarm).
- **Friendly receiver settings.** Platform type, update rate, elevation mask, signal plans,
  constellations and bands, SBAS and HAS corrections, OSNMA, antenna supervision, UART baud rates
  and NMEA sentences, each with a short explanation. Try a change until power-off, or apply and save it.
- **Every setting, if you need it.** A searchable editor for all documented configuration keys.
- **Backup and restore.** Save the receiver's configuration to a file before a firmware update or
  factory reset and put it back afterwards, with a preview of what will change.
- **Signals view.** Every tracked signal with strength, use, corrections and authentication, plus RF
  front-end noise and per-band jamming state.
- **Works afloat.** Responsive layout for phones and tablets, with day, dusk and red night modes.

![Signals: RF front-end, jamming by frequency and every tracked signal](https://raw.githubusercontent.com/g0kad/signalk-ublox-x20p/main/doc/screenshots/signals.png)

![Receiver: firmware, health, Galileo OSNMA keys and configuration backup](https://raw.githubusercontent.com/g0kad/signalk-ublox-x20p/main/doc/screenshots/receiver.png)

## Requirements

- A **u-blox ZED-X20P** receiver connected to the Signal K host by USB, for example the EVK-X20P
  kit or a breakout board. Developed and tested on an EVK-X20P with firmware HPG 2.02 and 2.11, on
  a Raspberry Pi 5. Other u-blox receivers that use the same configuration interface (such as the
  ZED-F9P) may work but are untested.
- **Signal K server 2.x.**
- For **Galileo HAS**: receiver firmware **HPG 2.11** or later, and an antenna that covers the
  **E6 / L6** band. Many "multi-band" antennas only cover L1/L2 or L1/L5.
- For **Galileo OSNMA**: a free account with the European GNSS Service Centre (GSC) to download
  the current key files.

## Quick start

1. In the Signal K admin UI, remove any existing *Data Connection* that reads the receiver's port.
   The plugin needs the port to itself.
2. Install **u-blox X20P GNSS** from the *Appstore*, then restart Signal K.
3. Under *Server → Plugin Config → u-blox X20P GNSS*, enable the plugin. The default serial device,
   `/dev/serial/by-id/usb-u-blox_AG_-_www.u-blox.com_u-blox_GNSS_receiver-if00`, finds the receiver
   wherever it is plugged in. `/dev/ttyACM0` also works.
4. Open *Webapps → u-blox X20P GNSS*. The *Overview* fills in within a few seconds.
5. Go to *Receiver → Download backup* and keep the file safe before changing anything.

If you have another GNSS source, set Signal K's *Data → Source Priorities* so that
`signalk-ublox-x20p` comes first for `navigation.position` and the `navigation.gnss` paths.

Changing receiver settings needs a Signal K **admin** login when security is enabled. Anyone who can
read Signal K data can view the live status.

## Using Galileo HAS

1. Check *Receiver → Firmware* shows HPG 2.11 or later. Update the receiver with u-center 2 if not,
   after downloading a configuration backup, which you can restore afterwards.
2. In *Settings → Constellations & signals*, make sure Galileo **E6** is enabled.
3. In *Settings → Corrections*, turn on **Galileo HAS** and choose **Apply & save**.

Within a minute *Overview → Corrections* should show **Galileo HAS**, and the fix shows
*PPP (converging)* while accuracy tightens over the following minutes. HAS corrects GPS and Galileo
satellites, and is used whenever no RTCM or SPARTN corrections are being supplied. Coverage is
global except around China, Japan and Korea.

## Using Galileo OSNMA

OSNMA lets the receiver cryptographically verify Galileo navigation messages, so a spoofer can't
fake them. It is free, but the receiver needs the current key material.

1. Log in at the European GNSS Service Centre (gsc-europa.eu), and from **OSNMA → Merkle tree** and
   **OSNMA → Public key**, *Applicable* tab, download the **product xml** file from each page.
2. In *Receiver → Galileo OSNMA*, choose **Load GSC key files** and select both files. The plugin
   checks that the public key belongs to the Merkle tree before sending anything to the receiver.
3. Turn on the plugin option **Give the receiver trusted time for OSNMA**. OSNMA's protection against
   replay (delayed-signal) attacks needs time from a source independent of GNSS. The plugin sends the
   host clock **only while it is synchronised to network NTP**. If the clock was set from GNSS, or NTP
   has been out of reach for some hours, nothing is sent.

*Overview → Galileo signals authenticated* then rises over a few minutes. *Authenticated fix* can
drop briefly to *no* when satellites start broadcasting new navigation data, because each batch can
only be verified once Galileo releases its key, typically 30 seconds or more later.

Without trusted time you can turn off *Settings → Security → Require trusted time for OSNMA*. Galileo
data is still authenticated, but without replay protection.

## Signal K data

Published once per navigation epoch with source `signalk-ublox-x20p`. Custom paths carry Signal K
`meta` with units and descriptions.

| Path | Notes |
|---|---|
| `navigation.position` | High-precision; altitude above mean sea level |
| `navigation.speedOverGround`, `navigation.courseOverGroundTrue` | COG held back below a configurable speed |
| `navigation.datetime`, `navigation.magneticVariation` | optional |
| `navigation.headingTrue` | optional, from a second, moving-base receiver (NAV-RELPOSNED) |
| `navigation.gnss.methodQuality`, `.integrity`, `.satellites`, `.satellitesInView`, `.horizontalDilution`, `.positionDilution`, `.antennaAltitude`, `.geoidalSeparation`, `.differentialAge` | Signal K standard paths |
| `navigation.gnss.horizontalAccuracy`, `.verticalAccuracy`, `.speedAccuracy`, `.courseAccuracy`, `.timeAccuracy` | receiver accuracy estimates |
| `navigation.gnss.velocityNorth`, `.velocityEast`, `.velocityDown` | 3D velocity |
| `navigation.gnss.correctionSource`, `.carrierSolution` | e.g. `Galileo HAS`, `float` |
| `navigation.gnss.signalsTracked`, `.signalsUsed`, `.verticalDilution`, `.timeDilution` | |
| `navigation.gnss.jamming`, `.spoofing`, `.antennaStatus` | detector and antenna state |
| `navigation.gnss.osnma`, `.authenticatedFix`, `.authenticatedSignals` | Galileo OSNMA |
| `notifications.navigation.gnss.jamming`, `.spoofing`, `.antenna`, `.fix` | warn / alarm |

`navigation.gnss.integrity` follows the security state: *Safe*, *Caution* (jamming warning) or
*Unsafe* (critical jamming or spoofing), so existing Signal K apps benefit without knowing the new paths.

## Plugin options

| Option | Default | |
|---|---|---|
| Serial device | `/dev/serial/by-id/…-if00` | the receiver's USB port |
| Publish navigation.datetime | on | |
| Publish magnetic variation | off | from the receiver's model |
| Minimum speed for COG | 0.25 m/s | COG is noise when stationary |
| Satellites-in-view interval | 5 s | |
| Notifications | on | jamming, spoofing, antenna faults, fix loss |
| Heading from moving-base receiver | off | with a heading offset in degrees |
| Trusted time for OSNMA | off | see *Using Galileo OSNMA* |

## How the plugin treats the receiver

- On connect it enables the UBX messages it needs **in RAM only**, so a power cycle returns the
  receiver to its saved configuration. NMEA outputs are left alone.
- Settings go to RAM (*Try it*) or to RAM, battery-backed RAM and flash (*Apply & save*). The
  *Settings* page lists anything active but not saved, with *Save* and *Revert* buttons.
- The configuration-lock settings (`CFG-SEC-CFG_LOCK*`), which can permanently prevent further
  changes, can never be written by this plugin.

## Troubleshooting

- **"waiting for /dev/…: Cannot lock port" or "busy".** Another program has the port open, often a
  Signal K data connection on the same device. Remove that connection.
- **The receiver is busy for about 20 seconds after plugging in (Linux).** ModemManager mistakes it
  for a modem and probes it. Stop that with:
  ```sh
  echo 'ATTRS{idVendor}=="1546", ENV{ID_MM_DEVICE_IGNORE}="1"' | sudo tee /etc/udev/rules.d/99-ublox-no-modemmanager.rules
  sudo udevadm control --reload-rules
  ```
- **Galileo HAS shows "not available".** The receiver's firmware is older than HPG 2.11.
- **Corrections stay on SBAS with HAS enabled.** Check that E6 is enabled and that the *Bands* panel
  shows E6 signals being tracked. If none are, the antenna probably doesn't cover E6.
- **OSNMA keys show "not valid".** Load current files from the GSC; Galileo changes keys from time to time.
- **"Not authorised" on the Settings page.** Log in to Signal K as an admin user.

## Development

```sh
npm install
npm test
```

`tools/` contains helpers that run against a receiver without Signal K:

- `node tools/probe.js /dev/ttyACM0` is a minimal read-only probe
- `node tools/live.js /dev/ttyACM0` exercises the library layer (read-only)
- `node tools/sk-sim.js /dev/ttyACM0` runs the plugin with a mock Signal K app and prints the deltas
- `node tools/dev-server.js /dev/ttyACM0 3999` serves the web app and API standalone at
  `http://host:3999/signalk-ublox-x20p/`. **It has no authentication.**

`lib/data/cfg-keys.json` is generated by `tools/build-cfgdb.js` from u-blox's official interface
description JSON ([u-blox-X20-interface-description-json](https://github.com/u-blox/u-blox-X20-interface-description-json)),
merging HPG 2.02, 2.10 and 2.11. To support a new firmware, download its JSON and rerun the script
with all versions, oldest first.

## Licence

Apache-2.0. The configuration key definitions in `lib/data/cfg-keys.json` are derived from u-blox's
interface description JSON, which u-blox permits to be used, copied, modified and distributed.
u-blox, ZED-X20P and u-center are trademarks of u-blox AG; this project is not affiliated with u-blox.
