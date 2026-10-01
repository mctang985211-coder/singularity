#!/usr/bin/env node
/**
 * Seed the tutorial-kanban environment for the singularity workspace.
 * Usage (from the harness root): node packages/singularity/tutorial/seed-env.mjs [--id projectN] [--label name] [--no-install]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tutorialRoot = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(tutorialRoot, '../../..')
const envRoot = join(harnessRoot, 'environment')
const appSource = join(tutorialRoot, 'app')
const skillsSource = join(tutorialRoot, 'skills')
const componentDir = 'tutorial/kanban'
const DEFAULT_LABEL = 'tutorial-kanban'

const args = process.argv.slice(2)
let requestedId
let label = DEFAULT_LABEL
let install = true

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  const value = () => {
    const next = args[i + 1]
    if (next === undefined) fail(`${arg} needs a value`)
    i += 1
    return next
  }
  if (arg === '--id') requestedId = value()
  else if (arg.startsWith('--id=')) requestedId = arg.slice('--id='.length)
  else if (arg === '--label') label = value()
  else if (arg.startsWith('--label=')) label = arg.slice('--label='.length)
  else if (arg === '--no-install') install = false
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: node packages/singularity/tutorial/seed-env.mjs [--id projectN] [--label name] [--no-install]')
    process.exit(0)
  } else {
    fail(`unknown argument: ${arg}`)
  }
}

function fail(message) {
  console.error(`seed-env: ${message}`)
  process.exit(1)
}

function readManifest() {
  const path = join(envRoot, 'manifest.json')
  if (!existsSync(path)) return { path, manifest: { version: 1, environments: [] } }
  const raw = readFileSync(path, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    fail(`manifest is not valid JSON: ${path}`)
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.environments)) {
    fail(`manifest has an unsupported shape: ${path}`)
  }
  return { path, manifest }
}

function writeManifest(path, manifest) {
  mkdirSync(envRoot, { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function seedComponent(target) {
  if (existsSync(join(target, componentDir, '.git'))) return
  mkdirSync(join(target, componentDir), { recursive: true })
  cpSync(appSource, join(target, componentDir), {
    recursive: true,
    filter: source => !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(source),
  })
  execFileSync('git', ['-C', join(target, componentDir), 'init', '-q'], { stdio: 'inherit' })
  execFileSync('git', ['-C', join(target, componentDir), 'add', '-A'], { stdio: 'inherit' })
  execFileSync(
    'git',
    [
      '-C',
      join(target, componentDir),
      '-c',
      'user.name=tutorial-seed',
      '-c',
      'user.email=tutorial-seed@localhost',
      'commit',
      '-q',
      '-m',
      'tutorial-kanban: red baseline (tests are the spec)',
    ],
    { stdio: 'inherit' },
  )
}

function seedSkills(target) {
  for (const entry of readdirSync(skillsSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const destination = join(target, '.agents', 'skills', entry.name)
    mkdirSync(destination, { recursive: true })
    cpSync(join(skillsSource, entry.name), destination, { recursive: true })
  }
}

function runInstall(target) {
  execFileSync('pnpm', ['install'], { cwd: join(target, componentDir), stdio: 'inherit' })
}

function nextFreeId(manifest) {
  const taken = new Set(manifest.environments.map(env => env.id))
  let n = 1
  while (taken.has(`project${n}`) || existsSync(join(envRoot, `project${n}`))) n += 1
  return `project${n}`
}

function isOurs(env) {
  return env.components?.some(component => component.dir === componentDir && component.repo === 'kanban') === true
}

function report(id, created) {
  const path = join(envRoot, id)
  console.log(created ? `seed-env: created ${id}` : `seed-env: ${id} already seeded (idempotent re-run)`)
  console.log(`seed-env: env path    = ${path}`)
  console.log(`seed-env: component   = ${join(path, componentDir)}`)
  console.log(`seed-env: skills      = ${join(path, '.agents/skills')}`)
  console.log(`seed-env: label       = ${label}`)
  console.log(`seed-env: root prompt = ${join(tutorialRoot, 'root-prompt.md')}`)
  console.log('seed-env: next step   = build a graph on this env, then paste that root prompt:')
  console.log(`          UI: 图谱切换器 New → env ${id}`)
  console.log(`          API: POST /singularity/graphs {"name":"tutorial","envId":"${id}"}`)
}

const { path: manifestPath, manifest } = readManifest()
const existing = requestedId === undefined ? undefined : manifest.environments.find(env => env.id === requestedId)

if (requestedId !== undefined && requestedId.length === 0) fail('--id needs a value')
if (requestedId !== undefined && (requestedId.includes('/') || requestedId.includes('\\'))) fail('--id must not contain path separators')

let id
let created

if (requestedId !== undefined) {
  if (existing !== undefined) {
    if (!isOurs(existing)) fail(`${requestedId} already exists and is not a tutorial-kanban env; pick another --id`)
    id = requestedId
    created = false
  } else if (existsSync(join(envRoot, requestedId))) {
    fail(`${join(envRoot, requestedId)} already exists without a manifest entry; pick another --id`)
  } else {
    id = requestedId
    created = true
  }
} else {
  id = nextFreeId(manifest)
  created = true
}

if (created) {
  const target = join(envRoot, id)
  mkdirSync(target, { recursive: true })
  seedComponent(target)
  seedSkills(target)
  const entry = {
    id,
    path: target,
    // Local-only component: no remote url, but the schema requires the field and
    // findByRepos() trims it, so "" (never null/undefined) is the safe value.
    components: [{ owner: 'tutorial', repo: 'kanban', url: '', dir: componentDir, status: 'ready' }],
    running: false,
    sessionIds: [],
    label,
  }
  manifest.environments.push(entry)
  writeManifest(manifestPath, manifest)
} else {
  const target = join(envRoot, id)
  seedComponent(target)
  seedSkills(target)
  if (existing.label !== label) {
    existing.label = label
    writeManifest(manifestPath, manifest)
  }
}

if (install) runInstall(join(envRoot, id))
report(id, created)
