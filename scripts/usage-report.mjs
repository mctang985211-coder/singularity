#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const [path] = process.argv.slice(2)
if (path === undefined) throw new Error('Usage: node scripts/usage-report.mjs <frozen subject.json or trajectory.json>')
const { root, summary } = JSON.parse(await readFile(path, 'utf8'))
if (summary?.usage?.source !== 'token-meter/tokenUsage')
  throw new Error('The trajectory has no frozen token-meter/tokenUsage projection')
process.stdout.write(JSON.stringify({ root, usage: summary.usage, sessions: summary.sessions }, null, 2) + '\n')
