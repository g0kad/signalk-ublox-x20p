'use strict'
// Galileo OSNMA key material from the European GNSS Service Centre (GSC) and the UBX-MGA messages
// that load it into the receiver, plus trusted-time assistance.
// GSC downloads: Merkle tree (https://www.gsc-europa.eu/gsc-products/OSNMA/MT, XML) and public key
// (https://www.gsc-europa.eu/gsc-products/OSNMA/PKI, XML or X.509 certificate).

const crypto = require('crypto')

const PK_TYPE = { 'ECDSA P-256': 1, 'ECDSA P-521': 3 }

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i')); return m ? m[1] : null }
const hex = s => (s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()

function pkTypeCode (s) {
  if (!s) return null
  for (const [k, v] of Object.entries(PK_TYPE)) if (s.toUpperCase().includes(k.split(' ')[1])) return v
  return null
}

// Returns { merkleRoot?, publicKeys: [{pkid, point, type}] } from any GSC file we understand
function parseGscFile (text, fileName = '') {
  const out = { publicKeys: [] }
  if (/-----BEGIN CERTIFICATE-----/.test(text)) {
    const cert = new crypto.X509Certificate(text)
    const jwk = cert.publicKey.export({ format: 'jwk' })
    const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url')
    const point = Buffer.concat([Buffer.from([(y[y.length - 1] & 1) ? 0x03 : 0x02]), x]).toString('hex')
    const pkid = Number((fileName.match(/PKID[_-]?(\d+)/i) || [])[1])
    out.publicKeys.push({ pkid: Number.isFinite(pkid) ? pkid : null, point, type: jwk.crv === 'P-521' ? 3 : 1 })
    return out
  }
  if (!/<\?xml|<signalData|<MerkleTree|<PublicKey/i.test(text)) throw new Error('Not a GSC OSNMA XML or certificate file')
  for (const m of text.matchAll(/<PublicKey>([\s\S]*?)<\/PublicKey>/gi)) {
    const b = m[1]
    const point = hex(tag(b, 'point'))
    if (point) out.publicKeys.push({ pkid: Number(tag(b, 'PKID')), leaf: Number(tag(b, 'i')), point, type: pkTypeCode(tag(b, 'PKType')) || 1 })
  }
  out.treeNodes = {}
  for (const m of text.matchAll(/<TreeNode>([\s\S]*?)<\/TreeNode>/gi)) {
    out.treeNodes[`${Number(tag(m[1], 'j'))},${Number(tag(m[1], 'i'))}`] = hex(tag(m[1], 'x_ji'))
  }
  out.merkleRoot = out.treeNodes['4,0']
  if (!out.merkleRoot && !out.publicKeys.length) throw new Error('No Merkle tree root or public key found in file')
  if (out.merkleRoot && out.merkleRoot.length !== 64) throw new Error('Merkle tree root is not 256 bits')
  return out
}

// Check a public key against the Merkle tree root using the sibling nodes GSC publishes with the tree
// (OSNMA SIS ICD: leaf = SHA-256(NPKT<<4 | NPKID || NPK), parent = SHA-256(left || right)).
// Returns true/false, or null if the nodes needed for the proof are not available.
function verifyKeyInTree (key, treeNodes, root) {
  if (!Number.isInteger(key.leaf) || !root) return null
  const sha = b => crypto.createHash('sha256').update(b).digest()
  let h = sha(Buffer.concat([Buffer.from([(key.type << 4) | key.pkid]), Buffer.from(key.point, 'hex')]))
  let idx = key.leaf
  for (let j = 0; j < 4; j++) {
    const sib = treeNodes[`${j},${idx ^ 1}`]
    if (!sib) return null
    const s = Buffer.from(sib, 'hex')
    h = sha(idx & 1 ? Buffer.concat([s, h]) : Buffer.concat([h, s]))
    idx >>= 1
  }
  return h.toString('hex') === root
}

// UBX-MGA-GAL-OSNMA_MERKLE payload (class 0x13 id 0x02, type 0x08)
function merklePayload (rootHex, future = false) {
  const p = Buffer.alloc(36)
  p[0] = 0x08; p[1] = 0; p[2] = future ? 1 : 0
  Buffer.from(rootHex, 'hex').copy(p, 4)
  return p
}

// UBX-MGA-GAL-OSNMA_PUBKEY payload (class 0x13 id 0x02, type 0x07); point is padded to 67 bytes
function pubKeyPayload ({ pkid, point, type }) {
  const pt = Buffer.from(point, 'hex')
  const want = { 1: 33, 3: 67 }[type] // compressed point sizes for P-256 and P-521
  if (!want) throw new Error(`Unsupported public key type ${type}`)
  if (pt.length !== want || (pt[0] !== 0x02 && pt[0] !== 0x03)) throw new Error(`Public key ID ${pkid} is not a valid compressed point`)
  if (!Number.isInteger(pkid) || pkid < 0 || pkid > 15) throw new Error('Public key ID missing or out of range')
  const p = Buffer.alloc(72)
  p[0] = 0x07; p[1] = 0; p[2] = (pkid & 0x0f) | ((type & 0x0f) << 4)
  pt.copy(p, 4)
  return p
}

// UBX-MGA-INI-TIME_UTC payload (class 0x13 id 0x40, type 0x10) flagged as from a trusted source
function trustedTimePayload (date, accuracyMs) {
  const p = Buffer.alloc(24)
  p[0] = 0x10; p[1] = 0
  p[2] = 0 // ref: time valid on receipt of the message
  p.writeInt8(-128, 3) // leap seconds unknown: the receiver knows them
  p.writeUInt16LE(date.getUTCFullYear(), 4)
  p[6] = date.getUTCMonth() + 1; p[7] = date.getUTCDate()
  p[8] = date.getUTCHours(); p[9] = date.getUTCMinutes(); p[10] = date.getUTCSeconds()
  p[11] = 0x01 // trustedSource
  p.writeUInt32LE(date.getUTCMilliseconds() * 1e6, 12)
  p.writeUInt16LE(Math.floor(accuracyMs / 1000), 16)
  p.writeUInt32LE(Math.round((accuracyMs % 1000) * 1e6), 20)
  return p
}

module.exports = { parseGscFile, verifyKeyInTree, merklePayload, pubKeyPayload, trustedTimePayload }
