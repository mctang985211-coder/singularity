#!/usr/bin/env node
/**
 * Where the testbench's expected W words come from, and why they can be trusted.
 *
 * The testbench compares the graded module's `w` output against two messages' full message schedules.
 * A table of constants is only as good as the implementation that produced it, so this file is that
 * implementation plus its own proof: it computes SHA-256 from the same schedule it prints, and refuses
 * to print anything unless both published NIST digests come out of it. Run it with any argument to see
 * the digests; run it bare to regenerate the Verilog tables the testbench carries.
 *
 * Usage: node w-schedule.mjs [check]
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0
const shr = (x, n) => x >>> n
const add = (...words) => words.reduce((sum, word) => (sum + word) >>> 0, 0)
const sigma0 = x => (rotr(x, 7) ^ rotr(x, 18) ^ shr(x, 3)) >>> 0
const sigma1 = x => (rotr(x, 17) ^ rotr(x, 19) ^ shr(x, 10)) >>> 0
const bigSigma0 = x => (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0
const bigSigma1 = x => (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0
const choose = (x, y, z) => ((x & y) ^ (~x & z)) >>> 0
const majority = (x, y, z) => ((x & y) ^ (x & z) ^ (y & z)) >>> 0

/** The 80-byte tail every message gets: 0x80, zeros, and the bit length in the last eight bytes. */
function padded(bytes) {
  const length = bytes.length
  const total = Math.ceil((length + 9) / 64) * 64
  const out = new Uint8Array(total)
  out.set(bytes)
  out[length] = 0x80
  const view = new DataView(out.buffer)
  view.setUint32(total - 8, Math.floor((length * 8) / 0x100000000))
  view.setUint32(total - 4, (length * 8) >>> 0)
  return out
}

/** One 64-byte block as its 16 big-endian words, then the 64 words the graded module produces. */
function scheduleOf(block) {
  const w = new Uint32Array(64)
  for (let t = 0; t < 16; t += 1) w[t] = new DataView(block.buffer, block.byteOffset, 64).getUint32(t * 4)
  for (let t = 16; t < 64; t += 1) w[t] = add(sigma1(w[t - 2]), w[t - 7], sigma0(w[t - 15]), w[t - 16])
  return w
}

function digestOf(bytes) {
  const words = padded(bytes)
  const blocks = []
  for (let offset = 0; offset < words.length; offset += 64) blocks.push(scheduleOf(words.subarray(offset, offset + 64)))
  let [a, b, c, d, e, f, g, h] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  for (const w of blocks) {
    let [wa, wb, wc, wd, we, wf, wg, wh] = [a, b, c, d, e, f, g, h]
    for (let t = 0; t < 64; t += 1) {
      const t1 = add(wh, bigSigma1(we), choose(we, wf, wg), K[t], w[t])
      const t2 = add(bigSigma0(wa), majority(wa, wb, wc))
      ;[wh, wg, wf, we, wd, wc, wb, wa] = [wg, wf, we, add(wd, t1), wc, wb, wa, add(t1, t2)]
    }
    ;[a, b, c, d, e, f, g, h] = [add(a, wa), add(b, wb), add(c, wc), add(d, wd), add(e, we), add(f, wf), add(g, wg), add(h, wh)]
  }
  return [a, b, c, d, e, f, g, h].map(word => word.toString(16).padStart(8, '0')).join('')
}

const VECTORS = [
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
]

const bytesOf = text => new TextEncoder().encode(text)
let wrong = 0
for (const [message, expected] of VECTORS) {
  const measured = digestOf(bytesOf(message))
  if (measured !== expected) wrong += 1
  console.log(`${measured === expected ? 'ok  ' : 'WRONG'} ${measured} ${JSON.stringify(message.slice(0, 24))}${message.length > 24 ? '…' : ''}`)
}
if (wrong > 0) {
  console.error(`${wrong} of ${VECTORS.length} published digests did not reproduce; the schedule this file prints is not known-good and is not printed`)
  process.exit(1)
}
if (process.argv[2] === 'check') process.exit(0)

// The two messages the testbench drives, block by block: "abc" is one block, and the 112-byte vector is
// two, so a module that only ever sees one block's worth of state cannot pass.
const MESSAGES = [VECTORS[0][0], VECTORS[2][0]]
const blocks = MESSAGES.flatMap(message => {
  const words = padded(bytesOf(message))
  const parts = []
  for (let offset = 0; offset < words.length; offset += 64) parts.push(scheduleOf(words.subarray(offset, offset + 64)))
  return parts
})

const flat = blocks.flatMap(words => [...words])
console.log(`\n// ${blocks.length} blocks, ${flat.length} words; the testbench carries this table verbatim.`)
for (let start = 0; start < flat.length; start += 8) {
  const row = flat.slice(start, start + 8).map((word, index) => `expected[${start + index}] = 32'h${word.toString(16).padStart(8, '0')};`)
  console.log(`      ${row.join(' ')}`)
}
