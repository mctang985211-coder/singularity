import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const artifact = JSON.parse(await readFile(process.argv[2], 'utf8'))
const bytes = await readFile(process.argv[3])
const digest = createHash('sha256').update(bytes).digest('hex')
if (artifact.subjectDigest !== digest || typeof artifact.detail !== 'string' || artifact.detail.trim().length === 0)
  throw new Error('Review must bind the exact subject and explain the judgement')
if (!['pass', 'fail', 'partial', 'unknown'].includes(artifact.verdict)) throw new Error('Unknown review verdict')
process.exit({ pass: 0, fail: 1, partial: 3, unknown: 4 }[artifact.verdict])
