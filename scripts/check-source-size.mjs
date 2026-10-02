#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const workspace = resolve(import.meta.dirname, '..')
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.sh', '.html', '.css'])
const generatedDirectories = new Set(['node_modules', 'lib', 'dist', '.output', '.git'])
const limit = 2000
let checked = 0
let oversized = 0

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!generatedDirectories.has(entry.name)) checkDirectory(file)
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      checked += 1
      const text = readFileSync(file, 'utf8')
      const lines = text.length === 0 ? 0 : text.split('\n').length - Number(text.endsWith('\n'))
      if (lines > limit) {
        oversized += 1
        console.error(`${relative(workspace, file)}: ${lines} lines exceeds ${limit}`)
      }
    }
  }
}

checkDirectory(workspace)
if (oversized) process.exitCode = 1
else console.log(`Source size: ${checked} files checked, each at most ${limit} lines`)
