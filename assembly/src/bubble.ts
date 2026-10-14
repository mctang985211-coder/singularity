import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import { SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'

export interface BubbleWorld {
  readonly root: string
  readonly writable: boolean
  readonly protected: readonly string[]
  readonly references: readonly string[]
}
const system = ['/usr', '/etc', '/nix', dirname(dirname(realpathSync(process.execPath)))].filter(existsSync)
export const containsPath = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)
export function confinedArgv(argv: readonly string[], world: BubbleWorld, cwd = world.root): string[] {
  if (!containsPath(world.root, cwd)) throw new Error(`Bubble cwd is outside its workspace: ${cwd}`)
  const args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--tmpfs', '/',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run']
  for (const path of [...system, ...world.references]) args.push('--ro-bind', path, path)
  for (const path of ['/bin', '/sbin', '/lib', '/lib64'])
    if (existsSync(path)) args.push('--ro-bind', path, path)
  args.push(world.writable ? '--bind' : '--ro-bind', world.root, world.root)
  for (const path of world.protected) args.push('--ro-bind', path, path)
  return [...args, '--chdir', cwd, '--', ...argv]
}

class BubbleFs extends FileSystem {
  readonly base: FileSystem
  readonly current: () => BubbleWorld
  readonly defaultCwd: string
  constructor(ctx: Context, base: FileSystem, current: () => BubbleWorld, defaultCwd: string) { super(ctx); this.base = base; this.current = current; this.defaultCwd = defaultCwd }
  override get sandboxMode() { return 'workspace-write' as const }
  private check(target: FsTarget, write = false): void {
    const path = this.base.processPath(target)
    const world = this.current()
    const allowed = write ? world.writable && containsPath(world.root, path) &&
      !world.protected.some(root => containsPath(root, path))
      : [world.root, ...world.references, ...system, '/bin', '/sbin', '/lib', '/lib64'].some(root => containsPath(root, path))
    if (!allowed) throw new Error(`Bubble ${write ? 'write' : 'read'} denied: ${path}`)
  }
  override async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }) {
    const world = this.current()
    const cwd = options?.cwd === undefined || options.cwd === this.defaultCwd ? world.root : options.cwd
    if (!containsPath(world.root, cwd)) throw new Error(`Bubble cwd is outside its workspace: ${cwd}`)
    const target = await this.base.resolve(path, { cwd, ...(options?.signal === undefined ? {} : { signal: options.signal }) })
    this.check(target)
    return target
  }
  override processPath(target: FsTarget) { this.check(target); return this.base.processPath(target) }
  override processPathFromHostPath(path: string) {
    const world = this.current()
    return [world.root, ...world.references, ...system].some(root => containsPath(root, path)) ? this.base.processPathFromHostPath(path) : undefined
  }
  override fileUrl(target: FsTarget) { this.check(target); return this.base.fileUrl(target) }
  override contains(parent: FsTarget, child: FsTarget) { return this.base.contains(parent, child) }
  override stat(...args: Parameters<FileSystem['stat']>) { this.check(args[0]); return this.base.stat(...args) }
  override async lstat(path: string, options?: { cwd?: string }, signal?: AbortSignal) {
    const world = this.current()
    const cwd = options?.cwd === undefined || options.cwd === this.defaultCwd ? world.root : options.cwd
    const target = world.references.includes(resolve(cwd, path)) ? path : dirname(path)
    await this.resolve(target, { ...options, ...(signal === undefined ? {} : { signal }) })
    return this.base.lstat(path, { cwd }, signal)
  }
  override readText(...args: Parameters<FileSystem['readText']>) { this.check(args[0]); return this.base.readText(...args) }
  override streamText(...args: Parameters<FileSystem['streamText']>) { this.check(args[0]); return this.base.streamText(...args) }
  override readBytes(...args: Parameters<FileSystem['readBytes']>) { this.check(args[0]); return this.base.readBytes(...args) }
  override readByteRange(...args: Parameters<FileSystem['readByteRange']>) { this.check(args[0]); return this.base.readByteRange(...args) }
  override listDir(...args: Parameters<FileSystem['listDir']>) { this.check(args[0]); return this.base.listDir(...args) }
  override watch(...args: Parameters<FileSystem['watch']>) { this.check(args[0]); return this.base.watch(...args) }
  override writeText(...args: Parameters<FileSystem['writeText']>) {
    this.check(args[0], true)
    return this.base.writeText(args[0], args[1], args[2], args[3], { mode: 'workspace-write', workspaceRoot: this.current().root })
  }
  override editText(...args: Parameters<FileSystem['editText']>) {
    this.check(args[0], true)
    return this.base.editText(args[0], args[1], args[2], args[3], { mode: 'workspace-write', workspaceRoot: this.current().root })
  }
}
class BubbleSubprocess extends SubprocessRuntime {
  readonly base: SubprocessRuntime
  readonly current: () => BubbleWorld
  readonly defaultCwd: string
  constructor(ctx: Context, base: SubprocessRuntime, current: () => BubbleWorld, defaultCwd: string) { super(ctx); this.base = base; this.current = current; this.defaultCwd = defaultCwd }
  override resolveExecutable(...args: Parameters<SubprocessRuntime['resolveExecutable']>) { return this.base.resolveExecutable(...args) }
  override terminalEnvironment(...args: Parameters<SubprocessRuntime['terminalEnvironment']>) { return this.base.terminalEnvironment(...args) }
  override spawn(spec: SubprocessSpawnSpec) {
    const world = this.current()
    const cwd = spec.cwd === this.defaultCwd ? world.root : spec.cwd
    return this.base.spawn({ ...spec, argv: confinedArgv(spec.argv, world, cwd), cwd,
      env: { ...spec.env, HOME: world.root, TMPDIR: '/tmp' } })
  }
  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): never { throw new Error('Bubble uses managed process execution') }
}
export async function mountBubbleWorld(agent: Agent, current: () => BubbleWorld): Promise<void> {
  const baseFs = agent.ctx.get('fs') as FileSystem
  const baseProcess = agent.ctx.get('subprocess') as SubprocessRuntime
  const local = agent.ctx.isolate('fs').isolate('subprocess').isolate('shell').isolate('sandboxPolicy')
  await local.plugin({ name: 'singularity-bubble-world', apply: (ctx: Context) => {
    new BubbleFs(ctx, baseFs, current, agent.session.header.cwd!)
    new BubbleSubprocess(ctx, baseProcess, current, agent.session.header.cwd!)
    ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({
      mode: current().writable ? 'workspace-write' : 'read-only', workspaceRoot: current().root, sessionId: agent.session.id,
    }) })
  } })
  await local.plugin(LocalBashExecutor, { cwd: current().root, timeoutMs: 60_000, maxTimeoutMs: 900_000,
    maxOutputBytes: 1024 * 1024, maxSpillBytes: 32 * 1024 * 1024, graceMs: 1000 })
  await local.plugin(ToolFs, {})
  await local.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
  await local.plugin(ToolBash, {})
}
