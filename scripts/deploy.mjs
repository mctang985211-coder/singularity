#!/usr/bin/env node
/** Materialise the private profile only after all exports and build digests verify. */
import { existsSync } from 'node:fs'
import { checkBuild } from '../assembly/build.mjs'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The one profile this deployment owns. */
export const PROFILE_NAME = 'singularity-next-web'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templateDir = join(root, 'deployment', 'profile')
const assemblyDir = join(root, 'assembly')

/** The template tokens, in the spelling that cannot collide with a DSH or cordis interpolation. */
const CHECKOUT_TOKEN = '@@CHECKOUT@@'
const DSH_HOME_TOKEN = '@@DSH_HOME@@'

/** Stop with one named reason. The caller gets a non-zero exit and a line naming what is wrong. */
function refuse(reason) {
  process.stderr.write(`deploy: ${reason}\n`)
  process.exit(1)
}

/** Substitute explicit deployment paths, refusing a template that would keep a token. */
function materialise(text, file) {
  const out = text.replaceAll(CHECKOUT_TOKEN, root).replaceAll(DSH_HOME_TOKEN, homeDir).replaceAll('@@DOMAIN_DIR@@', domainDir)
  if (out.includes('@@')) refuse(`${file} still contains a materialisation token after substitution`)
  return out
}

const configuredHome = process.env['DSH_HOME']
if (configuredHome === undefined || configuredHome === '')
  refuse("DSH_HOME is not set; source this deployment's environment (env.sh) before deploying")
const homeDir = resolve(configuredHome)
if (homeDir === join(homedir(), '.dsh'))
  refuse(`DSH_HOME resolves to the global harness home (${homeDir}); this deployment never writes there`)

if (!process.env['SINGULARITY_DOMAIN']) refuse('SINGULARITY_DOMAIN must name the reviewed domain directory')
const domainDir = await realpath(resolve(process.env['SINGULARITY_DOMAIN']))
if (!existsSync(join(domainDir, 'task.json'))) refuse('SINGULARITY_DOMAIN has no task.json')

const assemblyManifest = JSON.parse(await readFile(join(assemblyDir, 'package.json'), 'utf8'))

await checkBuild(root)

const declaredPatch = assemblyManifest.dsh?.bundle?.patch
const patchFiles = typeof declaredPatch === 'string' ? [declaredPatch] : declaredPatch
if (!Array.isArray(patchFiles) || patchFiles.length === 0)
  refuse('assembly/package.json declares no dsh.bundle.patch, so a profile mounting it would compose nothing')
for (const file of patchFiles)
  if (typeof file !== 'string' || !existsSync(join(assemblyDir, file)))
    refuse(`assembly/package.json declares the bundle patch ${JSON.stringify(file)}, which does not exist`)

const profileDir = join(homeDir, 'profiles', PROFILE_NAME)
const profileManifest = JSON.parse(materialise(await readFile(join(templateDir, 'package.json'), 'utf8'), 'deployment/profile/package.json'))
if (profileManifest.name !== PROFILE_NAME)
  refuse(`deployment/profile/package.json is named ${JSON.stringify(profileManifest.name)}, not ${JSON.stringify(PROFILE_NAME)}`)
const bundles = profileManifest.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.includes(assemblyManifest.name))
  refuse(`deployment/profile/package.json does not mount ${assemblyManifest.name} in dsh.profile.bundles`)
const profilePatch = materialise(await readFile(join(templateDir, 'cordis.patch.yml'), 'utf8'), 'deployment/profile/cordis.patch.yml')

await rm(profileDir, { recursive: true, force: true })
const linkDir = join(profileDir, 'node_modules', '@dangosys')
await mkdir(linkDir, { recursive: true })
await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, null, 2)}\n`)
await writeFile(join(profileDir, 'cordis.patch.yml'), profilePatch)
const linkPath = join(linkDir, 'dsh-singularity-next')
await symlink(assemblyDir, linkPath, 'dir')
const workspaceRoot = join(homeDir, 'workspaces', 'singularity')
await mkdir(workspaceRoot, { recursive: true })

// Read back what the loader will read: a written file is not evidence until it parses and the link
// resolves to the tree this script meant to mount.
JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
if ((await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).includes('@@'))
  refuse(`${join(profileDir, 'cordis.patch.yml')} contains a materialisation token`)
const linked = await realpath(linkPath)
if (linked !== assemblyDir)
  refuse(`${linkPath} resolves to ${linked}, not ${assemblyDir}`)

process.stdout.write(
  [
    `deploy: profile ${PROFILE_NAME} written to ${profileDir}`,
    `deploy: linked ${linkPath} -> ${assemblyDir}`,
    `deploy: workspace root ${workspaceRoot}`,
    `deploy: verify with: dsh --profile ${PROFILE_NAME} --dump-config`,
    `deploy: boot with:   node ${join(root, 'scripts/host-runtime.mjs')} --host 127.0.0.1 --port 7331 --no-open`,
    '',
  ].join('\n'),
)
