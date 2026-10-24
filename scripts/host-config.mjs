import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECKOUT = fileURLToPath(new URL('..', import.meta.url))
export const HOST_LINK = '.singularity/dsh'

/** Explicit private installation only. Never fall back to a registry or a global DSH. */
export function hostInstall(root = CHECKOUT, configured = process.env['DSH_CONTROL_INSTALLED']) {
  const target = configured || join(root, HOST_LINK)
  if (!existsSync(target))
    throw new Error(
      'Private DSH is not configured. Run pnpm setup:host /path/to/dsh/node_modules/@deepseek-ai; see docs/standalone-dsh.md',
    )
  return realpathSync(target)
}

export function hostRequire(installed = hostInstall()) {
  return createRequire(join(installed, 'resolve.cjs'))
}

export function hostFindings(
  installed,
  baseline = JSON.parse(readFileSync(join(CHECKOUT, 'dsh-baseline.json'), 'utf8')),
) {
  const findings = []
  for (const item of baseline.packages) {
    const path = join(installed, item.name.replace('@deepseek-ai/', ''), 'package.json')
    try {
      const actual = JSON.parse(readFileSync(path, 'utf8'))
      if (actual.version !== item.version)
        findings.push(`${item.name}: expected ${item.version}, found ${actual.version}`)
    } catch {
      findings.push(`${item.name}: missing or unreadable package.json`)
    }
  }
  for (const [file, expected] of Object.entries(baseline.artifacts)) {
    try {
      const actual = createHash('sha256')
        .update(readFileSync(join(installed, file)))
        .digest('hex')
      if (actual !== expected) findings.push(`${file}: private host patch/build digest differs from dsh-baseline.json`)
    } catch {
      findings.push(`${file}: required patched host artifact is missing`)
    }
  }
  return findings
}

/** Materialize one ignored relative type-resolution link after validating the host. */
export async function configureHost(root = CHECKOUT, configured = hostInstall()) {
  const installed = hostInstall(root, configured)
  const findings = hostFindings(installed)
  if (findings.length) throw new Error(findings.join('\n'))
  const link = join(root, HOST_LINK)
  await mkdir(dirname(link), { recursive: true })
  try {
    const entry = await lstat(link)
    if (!entry.isSymbolicLink())
      throw new Error(`${link} exists and is not a symlink; leave it intact and choose a clean checkout`)
    if (resolve(dirname(link), await readlink(link)) !== installed) await rm(link)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!existsSync(link)) await symlink(installed, link, 'dir')
  // Resolve real paths once so declaration merging and transitive host types share module identity.
  // TypeScript cannot expand environment variables in paths; this generated file stays local.
  const paths = {}
  for (const name of (await readdir(installed)).sort()) {
    const manifestPath = join(installed, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.types === 'string') paths[`@deepseek-ai/${name}`] = [join(installed, name, manifest.types)]
    for (const [face, entry] of Object.entries(manifest.exports ?? {})) {
      if (!face.startsWith('.') || typeof entry?.types !== 'string') continue
      paths[`@deepseek-ai/${name}${face === '.' ? '' : face.slice(1)}`] = [join(installed, name, entry.types)]
    }
  }
  await writeFile(
    join(root, '.singularity/tsconfig.host.json'),
    JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n',
  )
  return installed
}
