#!/usr/bin/env node
/**
 * Materialise the deployment's DSH profile: one profile directory in the deployment's
 * `$DSH_HOME`, holding the two files `dsh --profile <name>` reads plus the linked root that
 * mounts this checkout's assembly package.
 *
 * **Why a script and not `dsh plugin add`.** The plugin manager shells out to pnpm against a
 * registry. This deployment must never fetch anything: the assembly is this checkout, and every
 * `@deepseek-ai/*` package it imports is provided by the running DSH installation. So the profile is
 * written by hand — the profile manifest, the deployment's patch layer, and a symlink under the
 * profile's `node_modules` pointing at `assembly/`. That symlink is what DSH calls a **linked root**:
 * it resolves the plugin's own `@deepseek-ai/*` imports against the installation instead of against
 * anything downloaded, which is why the assembly's `peerDependencies` must list every package it
 * imports.
 *
 * **What is written.** `deployment/profile/` is the template; two tokens in it (`@@CHECKOUT@@`,
 * `@@DSH_HOME@@`) are substituted with this checkout and this home, because neither path can be
 * committed. The profile directory is removed and rewritten whole: it is generated, so a stale copy is
 * a profile that boots last week's composition.
 *
 * **What it refuses.** A missing `$DSH_HOME`, the global `~/.dsh` home, a template that would not
 * mount this package, a bundle patch or exported face the manifest promises and the tree does not
 * have, and any token left unsubstituted. Each refusal names the one thing that is wrong and exits
 * non-zero; nothing here is repaired by a fallback.
 *
 * Usage: node scripts/deploy.mjs   (after `node assembly/build.mjs`)
 *
 * @module singularity-core/scripts/deploy
 */

import { existsSync } from 'node:fs'
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

/** Substitute the two deployment paths, refusing a template that would keep a token. */
function materialise(text, file) {
  const out = text.replaceAll(CHECKOUT_TOKEN, root).replaceAll(DSH_HOME_TOKEN, homeDir)
  if (out.includes('@@')) refuse(`${file} still contains a materialisation token after substitution`)
  return out
}

const configuredHome = process.env['DSH_HOME']
if (configuredHome === undefined || configuredHome === '')
  refuse("DSH_HOME is not set; source this deployment's environment (env.sh) before deploying")
const homeDir = resolve(configuredHome)
if (homeDir === join(homedir(), '.dsh'))
  refuse(`DSH_HOME resolves to the global harness home (${homeDir}); this deployment never writes there`)

const assemblyManifest = JSON.parse(await readFile(join(assemblyDir, 'package.json'), 'utf8'))

// Every face the package exports must be built, and every patch the bundle declares must be on disk:
// DSH skips a bundle whose patch file is unreadable, and it says so only on the boot's stderr.
for (const face of ['.', './agent']) {
  const artifact = assemblyManifest.exports?.[face]
  if (typeof artifact !== 'string') refuse(`assembly/package.json does not export ${face}`)
  if (!existsSync(join(assemblyDir, artifact)))
    refuse(`assembly${artifact.replace(/^\./, '')} is missing for export ${face}; run 'node assembly/build.mjs' first`)
}
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
    `deploy: boot with:   dsh --profile ${PROFILE_NAME} --host 127.0.0.1 --port 7331 --no-open`,
    '',
  ].join('\n'),
)
