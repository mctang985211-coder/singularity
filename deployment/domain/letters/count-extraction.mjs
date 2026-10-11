import { readFileSync } from 'node:fs'

const [artifactPath, inputPath] = process.argv.slice(2)
if (artifactPath === undefined || inputPath === undefined) throw new Error('count extraction: expected artifact and input paths')
const letters = readFileSync(inputPath, 'utf8')
const report = readFileSync(artifactPath, 'utf8')
if (!/^[A-Za-z]*$/.test(letters) || !/^(0|[1-9][0-9]*)(?:\n)?$/.test(report) || Number(report) !== letters.length) {
  console.error('count must be decimal and equal the length of an input containing only ASCII letters')
  process.exit(1)
}
