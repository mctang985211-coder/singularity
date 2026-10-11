import { readFileSync } from 'node:fs'

const [artifactPath, inputPath] = process.argv.slice(2)
if (artifactPath === undefined || inputPath === undefined) throw new Error('extract: expected artifact and input paths')
const expected = Buffer.from((readFileSync(inputPath, 'utf8').match(/[A-Za-z]/g) ?? []).join(''))
if (!readFileSync(artifactPath).equals(expected)) {
  console.error('extraction must contain exactly the ASCII letters in source order, without a trailing newline')
  process.exit(1)
}
