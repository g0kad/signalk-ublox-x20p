# Changelog

## 0.1.0 (2026-10-30)

First release.

- Reads the u-blox X20P over its native UBX protocol and publishes to Signal K: high-precision
  position, speed and course, 3D velocity, receiver accuracy estimates, DOPs, fix and correction
  state, satellites in view, and signal counts.
- Security and integrity: jamming and spoofing detection state, antenna supervision and Galileo OSNMA
  authentication (`navigation.gnss.authenticatedFix`, `.authenticatedSignals`), with Signal K
  notifications for jamming, spoofing, antenna faults and fix loss.
- Web app: live overview with sky plot, per-signal table with RF front-end and per-band jamming,
  plain-language receiver settings (try in RAM or apply and save), a searchable editor for every
  documented configuration key, and receiver health and restart.
- Configuration backup and restore, for firmware updates and factory resets.
- Galileo HAS: enable the free E6 PPP corrections (receiver firmware HPG 2.11 or later).
- Galileo OSNMA: load the Merkle tree root and public key from the European GNSS Service Centre's
  files, after checking the key against the tree root; optionally give the receiver trusted time
  from an NTP-synchronised host.
- Configuration key database generated from u-blox's official interface description JSON
  (HPG 2.02, 2.10 and 2.11).
