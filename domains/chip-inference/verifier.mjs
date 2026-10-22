import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const [artifact, input] = process.argv.slice(2)
const configuration = JSON.parse(await readFile(input, 'utf8'))
const manifest = JSON.parse(await readFile(new URL('../external-tools.json', import.meta.url), 'utf8'))
try {
  // The protected workload bytes are the test identity: pass the file, not a
  // case name that would let the verifier read a different hidden seed table.
  const { stdout } = await promisify(execFile)(manifest.python,
    [fileURLToPath(new URL('../public/evaluate.py', import.meta.url)), artifact, configuration.caseId, '--workload', input, '--functional-only'],
    { timeout: 55000, maxBuffer: 1024 * 1024 })
  process.stderr.write(stdout)
} catch (error) {
  process.stderr.write(error.stdout ?? error.message)
  process.exitCode = error.code === 4 ? 4 : 1
}
