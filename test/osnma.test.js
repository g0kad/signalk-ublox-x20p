'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const o = require('../lib/osnma')

// Public OSNMA key material published by the European GNSS Service Centre on 2025-12-10
// (OSNMA_MerkleTree_20251210100000_newPKID_2.xml), reduced to the elements the plugin reads.
const ROOT = '832E15EDE55655EAC6E399A539477B7C034CCE24C3C93FFC904ACD9BF842F04E'
const POINT = '02219204B5CA6C46B623EEED6CDD2CDDB1F7D6A7532767E5B8DA0DE1EBD695FC99'
const node = (j, i, x) => `<TreeNode><j>${j}</j><i>${i}</i><lengthInBits>256</lengthInBits><x_ji>${x}</x_ji></TreeNode>`
const MERKLE_XML = '<?xml version="1.0" encoding="UTF-8"?><signalData><body><MerkleTree><N>16</N><HashFunction>SHA-256</HashFunction>' +
  `<PublicKey><i>1</i><PKID>2</PKID><lengthInBits>264</lengthInBits><point>${POINT}</point><PKType>ECDSA P-256/SHA-256</PKType></PublicKey>` +
  node(4, 0, ROOT) +
  node(3, 1, '84DE3669E6DA551292979E5B8D045787FA967C57CC23638A30237614EDD9171A') +
  node(2, 1, 'DE73D209E4C5BCDC34CD117F2FE40FD08B110009997AD2B3291D3A2CF29943F9') +
  node(1, 1, '6AAFDE28017BF0744D42819CE40E3A0CDA1ECA3F7A4EA67E134E7AA714C1E843') +
  node(0, 0, '7B944FA20915C7931D48DD016D94F9C6381FD37DC6C125D97015272FDDE41393') +
  '</MerkleTree></body></signalData>'

test('parses a GSC Merkle tree file', () => {
  const r = o.parseGscFile(MERKLE_XML)
  assert.equal(r.merkleRoot, ROOT.toLowerCase())
  assert.deepEqual(r.publicKeys, [{ pkid: 2, leaf: 1, point: POINT.toLowerCase(), type: 1 }])
})

test('verifies the published public key against the Merkle tree root', () => {
  const r = o.parseGscFile(MERKLE_XML)
  const key = r.publicKeys[0]
  assert.equal(o.verifyKeyInTree(key, r.treeNodes, r.merkleRoot), true)
  assert.equal(o.verifyKeyInTree({ ...key, point: key.point.slice(0, -2) + '98' }, r.treeNodes, r.merkleRoot), false)
  assert.equal(o.verifyKeyInTree({ ...key, pkid: 1 }, r.treeNodes, r.merkleRoot), false)
  assert.equal(o.verifyKeyInTree({ ...key, leaf: undefined }, r.treeNodes, r.merkleRoot), null)
})

test('builds UBX-MGA-GAL OSNMA payloads to the documented sizes', () => {
  const m = o.merklePayload(ROOT.toLowerCase())
  assert.equal(m.length, 36)
  assert.equal(m[0], 0x08)
  assert.equal(m.subarray(4).toString('hex'), ROOT.toLowerCase())
  const k = o.pubKeyPayload({ pkid: 2, point: POINT.toLowerCase(), type: 1 })
  assert.equal(k.length, 72)
  assert.deepEqual([k[0], k[2]], [0x07, 0x12])
  assert.throws(() => o.pubKeyPayload({ pkid: 2, point: POINT.slice(0, -2), type: 1 }), /compressed point/)
})

test('trusted time payload is flagged as trusted', () => {
  const t = o.trustedTimePayload(new Date(Date.UTC(2026, 9, 30, 1, 20, 5, 250)), 1000)
  assert.equal(t.length, 24)
  assert.equal(t[0], 0x10)
  assert.equal(t.readUInt16LE(4), 2026)
  assert.equal(t[11] & 1, 1)
  assert.equal(t.readUInt32LE(12), 250e6)
  assert.equal(t.readUInt16LE(16), 1)
})

test('rejects files that are not OSNMA key material', () => {
  assert.throws(() => o.parseGscFile('hello'), /Not a GSC OSNMA/)
  assert.throws(() => o.parseGscFile('<?xml version="1.0"?><signalData></signalData>'), /No Merkle tree root/)
})
