import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

const { runEnvironmentSetup, approveEnvironmentSetup, assertOrdinarySetupConfig, checkEnvironmentSetup, SETUP_FIELDS } =
  await import(fileURLToPath(new URL('../scripts/env-setup.mjs', import.meta.url)))
const temporary: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true })
})
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singularity-env-setup-'))
  temporary.push(dir)
  return dir
}

it('runs only the native headless session in staging, without contacting or composing Singularity', async () => {
  const root = await temp(),
    workspace = join(root, 'new staging'),
    binary = join(root, 'native dsh'),
    patch = join(root, 'route.yml')
  await writeFile(patch, 'model route only\n')
  await writeFile(
    binary,
    `#!${process.execPath}
if (process.argv.includes('--dump-config')) {
  console.log('- id: headless-runner\\n  name: native-headless');
} else {
  let input = ''; for await (const part of process.stdin) input += part;
  const fs = await import('node:fs/promises');
  await fs.writeFile('received.json', JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), input,
    token: process.env.SINGULARITY_TOKEN ?? null, cookie: process.env.SINGULARITY_COOKIE ?? null}));
  console.log(JSON.stringify({type:'session',sessionId:'ordinary-fresh-session'}));
  console.log(JSON.stringify({type:'final',text:'Prepared setup-manifest.json for review.'}));
}
`,
    { mode: 0o700 },
  )
  const result = await runEnvironmentSetup({
    request: 'Explore only local module PPA; never run full-chip simulation.',
    workspace,
    binary,
    patch,
    env: {
      ...process.env,
      DSH_HOME: join(root, 'private-home'),
      SINGULARITY_TOKEN: 'private',
      SINGULARITY_COOKIE: 'private',
    },
  })
  expect(result).toMatchObject({
    sessionId: 'ordinary-fresh-session',
    exitCode: 0,
    approval: 'pending',
    workspace,
    manifest: join(workspace, 'setup-manifest.json'),
  })
  const received = JSON.parse(await readFile(join(workspace, 'received.json'), 'utf8'))
  expect(received).toMatchObject({
    args: ['--profile', 'headless', '--patch', patch, '--json', '-'],
    cwd: workspace,
    token: null,
    cookie: null,
  })
  expect(received.input).toContain('never run full-chip simulation')
  expect(await readFile(join(workspace, 'ENV_SETUP_CONTEXT.md'), 'utf8')).toContain(
    'assembly/src/domain-measurement.ts',
  )
  expect(JSON.parse(await readFile(join(workspace, '.env-setup/run.json'), 'utf8')).approval).toBe('pending')
  await expect(readFile(join(workspace, 'environment-approval.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([0, 7])('blocks parent Git discovery and removes native temporary files after exit %s', async exitCode => {
  const parent = await temp(),
    workspace = join(parent, 'staging'),
    binary = join(parent, 'native-dsh.mjs')
  execFileSync('git', ['init', '--quiet', parent])
  await writeFile(join(parent, 'parent-only.txt'), 'Must not enter a setup workspace snapshot.\n')
  execFileSync('git', ['-C', parent, 'add', 'parent-only.txt'])
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = await import('node:fs/promises');
const path = await import('node:path');
const cp = await import('node:child_process');
const temporary = (await import('node:os')).tmpdir();
await fs.writeFile(path.join(temporary, 'native-cache'), 'temporary tool output');
const observed = {
  temporary,
  git: cp.spawnSync('git', ['rev-parse', '--show-toplevel'], {encoding:'utf8'}).status,
  directGit: cp.spawnSync('git', ['-C', ${JSON.stringify(parent)}, 'rev-parse', '--show-toplevel'], {encoding:'utf8'}).stdout.trim(),
  ceiling: process.env.GIT_CEILING_DIRECTORIES,
  localEnv: Object.keys(process.env).filter(key => /^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_0|CONFIG_VALUE_0)$/.test(key)),
  temps: [process.env.TMPDIR, process.env.TMP, process.env.TEMP],
};
if (process.argv.includes('--dump-config')) {
  await fs.writeFile('preflight.json', JSON.stringify(observed));
  console.log('- id: headless-runner');
} else {
  for await (const part of process.stdin) {}
  await fs.writeFile('observed.json', JSON.stringify(observed));
  await fs.writeFile('SETUP_REVIEW.md', 'Review retained after native exit.');
  console.log(JSON.stringify({type:'session',sessionId:'isolated-native-session'}));
  if (${exitCode} === 0) console.log(JSON.stringify({type:'final',text:'Review package.'}));
  process.exitCode = ${exitCode};
}
`,
    { mode: 0o700 },
  )
  const running = runEnvironmentSetup({
    request: 'Prepare one local evaluator.',
    workspace,
    binary,
    env: {
      ...process.env,
      DSH_HOME: join(parent, 'private-home'),
      GIT_DIR: join(parent, '.git'),
      GIT_WORK_TREE: parent,
      GIT_COMMON_DIR: join(parent, '.git'),
      GIT_OBJECT_DIRECTORY: join(parent, '.git/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(parent, '.git/objects'),
      GIT_INDEX_FILE: join(parent, '.git/index'),
      GIT_CEILING_DIRECTORIES: '/',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: parent,
      TMPDIR: parent,
      TMP: parent,
      TEMP: parent,
    },
  })
  if (exitCode === 0) await expect(running).resolves.toMatchObject({ exitCode: 0 })
  else await expect(running).rejects.toThrow('did not complete (exit 7)')
  for (const file of ['preflight.json', 'observed.json']) {
    const observed = JSON.parse(await readFile(join(workspace, file), 'utf8'))
    expect(observed.git).not.toBe(0)
    expect(observed.directGit).toBe(await realpath(parent))
    const staging = await realpath(workspace)
    expect(observed.ceiling).toBe([staging, dirname(staging)].join(delimiter))
    expect(observed.localEnv).toEqual([])
    expect(observed.temps).toEqual([observed.temporary, observed.temporary, observed.temporary])
    expect(observed.temporary.startsWith(join(await realpath(workspace), '.env-setup/tmp-'))).toBe(true)
    await expect(readdir(observed.temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(await readFile(join(workspace, 'SETUP_REVIEW.md'), 'utf8')).toContain('retained')
  expect(await readFile(join(workspace, '.env-setup/events.jsonl'), 'utf8')).toContain('isolated-native-session')
  expect((await readdir(join(workspace, '.env-setup'))).some(file => file.startsWith('tmp-'))).toBe(false)
  expect(execFileSync('git', ['-C', parent, 'ls-files'], { encoding: 'utf8' }).trim()).toBe('parent-only.txt')
})

it('rejects effective configurations that accidentally compose a Task agent or Singularity assembly', () => {
  for (const config of [
    '- id: headless-runner\n- id: singularity-assembly',
    '- id: headless-runner\n  name: "@dangosys/dsh-singularity-next"',
    '- id: headless-runner\n  default: singularity-root',
  ])
    expect(() => assertOrdinarySetupConfig(config)).toThrow('ordinary DSH')
  expect(() => assertOrdinarySetupConfig('- id: web')).toThrow('headless runner is missing')
  expect(() => assertOrdinarySetupConfig('- id: web', true)).toThrow('user-question UI')
})

it('seeds one native interactive Web session through authenticated RPC, retaining questions in that session', async () => {
  vi.stubEnv('SINGULARITY_TOKEN', 'unrelated-host-token')
  vi.stubEnv('SINGULARITY_COOKIE', 'unrelated=host')
  const root = await temp(),
    workspace = join(root, 'interactive staging'),
    binary = join(root, 'native stub.mjs')
  await writeFile(
    binary,
    `#!${process.execPath}
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
if (process.argv.includes('--dump-config')) {
  console.log('- id: preset-env-setup\\n- id: ui-user-questions');
} else {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url==='/?token=native-launch-secret') { res.writeHead(303, {'set-cookie':'dsh=local'}); res.end(); return; }
    if(req.headers.cookie !== 'dsh=local') {res.writeHead(403);res.end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);calls.push(call);
    const request=call.payload.args.request;
    res.setHeader('content-type','application/json');
    const value=call.method==='workspace/create'?{workspace:{workspaceId:'native-workspace'}}:{sessionId:request.sessionId};
    res.end(JSON.stringify({result:{ok:true,value}}));
    if(call.method==='session/prompt') {
      await writeFile('interactive.json',JSON.stringify({args:process.argv.slice(2),calls}));
      setTimeout(()=>server.close(),50);
    }
  });
  server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=native-launch-secret'));
}
`,
    { mode: 0o700 },
  )
  let output = ''
  const result = await runEnvironmentSetup({
    request: 'User supplies tasks; ask about the missing scoring target.',
    workspace,
    binary,
    interactive: true,
    output: {
      write: (text: string) => {
        output += text
      },
    },
    env: { ...process.env, DSH_HOME: join(root, 'private-home') },
  })
  expect(result).toMatchObject({ mode: 'interactive', state: 'host-stopped', approval: 'pending', exitCode: 0 })
  const observed = JSON.parse(await readFile(join(workspace, 'interactive.json'), 'utf8'))
  expect(observed.args.slice(0, 2)).toEqual(['--profile', 'web'])
  expect(observed.args).toContain('--port')
  expect(observed.calls.map((call: any) => call.method)).toEqual([
    'workspace/create',
    'session/create',
    'session/prompt',
  ])
  expect(observed.calls[0].payload.args.request).toEqual({ path: workspace })
  expect(observed.calls[1].payload.args.request).toMatchObject({
    agentPreset: 'env-setup',
    workspaceId: 'native-workspace',
  })
  const prompt = observed.calls[2].payload.args.request.content[0].text
  expect(prompt).toContain('ask_user_question')
  expect(prompt).toContain('todo_write')
  expect(prompt).toContain('skipped/pending/cancelled is not approval')
  expect(output).toContain('Review TODOs and questions in the native Web UI')
  expect(await readFile(join(workspace, '.env-setup/diagnostics.log'), 'utf8')).not.toContain('native-launch-secret')
  expect(await readFile(join(workspace, '.env-setup/run.json'), 'utf8')).not.toContain('native-launch-secret')
  const table = JSON.parse(await readFile(join(workspace, '.env-setup/config.json'), 'utf8'))
  expect(table.items.map((row: any) => row.id)).toEqual(SETUP_FIELDS.map(([id]: string[]) => id))
  expect(table.items.every((row: any) => row.value === null)).toBe(true)
  expect((await readdir(join(workspace, '.env-setup'))).some(file => file.startsWith('tmp-'))).toBe(false)
  await expect(readFile(join(workspace, 'environment-approval.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

async function readyPackage(root: string, tools: unknown[] = [], parameters = {}) {
  await mkdir(join(root, '.env-setup'), { recursive: true })
  await mkdir(join(root, 'domain/public'), { recursive: true })
  await writeFile(
    join(root, '.env-setup/config.json'),
    JSON.stringify({
      version: 1,
      items: SETUP_FIELDS.map(([id]: string[]) => ({
        id,
        value: { scope: 'explicit smoke fixture' },
        evidence: ['recorded fixture checks'],
      })),
    }),
  )
  const contract = (goal: string) => ({
    goal,
    artifact: 'candidate.py',
    inputs: [],
    criteria: [{ criterionId: 'correct', statement: 'must match reference' }],
  })
  await writeFile(
    join(root, 'domain/suite.json'),
    JSON.stringify({
      version: 1,
      suiteId: 'smoke',
      failureQuality: 0,
      cases: ['evolve', 'validation', 'heldout'].map(split => ({
        caseId: split + '-case',
        familyId: split + '-family',
        sourceId: split + '-source',
        split,
        weight: 1,
        trials: 2,
        contract: contract(split),
        hardGuards: ['correct'],
      })),
    }),
  )
  await writeFile(
    join(root, 'domain/measurement.mjs'),
    `export const describe=()=>(${JSON.stringify({
      baseline: 1,
      digest: 'a'.repeat(64),
      tools,
      conditions: [],
      unit: 'ratio',
      direction: 'higher',
      parameters,
    })});
export const measure=async()=>1;\n`,
  )
  await writeFile(
    join(root, 'domain/task.json'),
    '{"suite":"suite.json","references":["public"],"measurement":"measurement.mjs"}\n',
  )
  await writeFile(
    join(root, 'setup-manifest.json'),
    JSON.stringify({
      version: 1,
      domain: 'domain',
      files: ['setup-manifest.json', 'domain/task.json', 'domain/suite.json', 'domain/measurement.mjs'],
    }),
  )
}

it('checks the real domain and refuses approval when a configuration row is incomplete', async () => {
  const root = await temp()
  await readyPackage(root)
  expect((await checkEnvironmentSetup(root)).ok).toBe(true)
  const path = join(root, '.env-setup/config.json'),
    table = JSON.parse(await readFile(path, 'utf8'))
  table.items[2].value = null
  await writeFile(path, JSON.stringify(table))
  const result = await checkEnvironmentSetup(root)
  expect(result.ok).toBe(false)
  expect(result.checks[0].detail).toContain('acceptance')
  await expect(approveEnvironmentSetup(root)).rejects.toThrow('readiness checks failed')
  await expect(readFile(join(root, 'environment-approval.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  {
    tools: [{ name: 'node', version: '22', implementationDigest: 'b'.repeat(64) }],
    parameters: {},
    error: 'redeclare core tool node',
  },
  { tools: [], parameters: { baselines: { 'heldout-case': 1 } }, error: 'Private case exposed' },
])('rejects a package before startup: $error', async ({ tools, parameters, error }) => {
  const root = await temp()
  await readyPackage(root, tools, parameters)
  const result = await checkEnvironmentSetup(root)
  expect(result.ok).toBe(false)
  expect(result.checks[1].detail).toContain(error)
})

it('rejects a protected input mounted in public references', async () => {
  const root = await temp()
  await readyPackage(root)
  await writeFile(join(root, 'domain/public/input.json'), '{}')
  const declaration = {
    suite: 'suite.json',
    references: ['public'],
    inputs: [{ ref: 'secret', from: 'public/input.json' }],
  }
  await writeFile(join(root, 'domain/task.json'), JSON.stringify(declaration))
  const manifestPath = join(root, 'setup-manifest.json'),
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.files.push('domain/public/input.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  const result = await checkEnvironmentSetup(root)
  expect(result.ok).toBe(false)
  expect(result.checks[1].detail).toContain('Protected input exposed')
})

it('rejects domain implementation bytes absent from the frozen manifest', async () => {
  const root = await temp()
  await readyPackage(root)
  const path = join(root, 'setup-manifest.json'),
    manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.files = manifest.files.filter((file: string) => file !== 'domain/measurement.mjs')
  await writeFile(path, JSON.stringify(manifest))
  const result = await checkEnvironmentSetup(root)
  expect(result.ok).toBe(false)
  expect(result.checks[1].detail).toContain('Unlisted domain file: domain/measurement.mjs')
})

async function packageAt(root: string, extra: string[] = [], legacy = false) {
  await mkdir(join(root, 'domain'), { recursive: true })
  await writeFile(join(root, 'domain/task.json'), '{"inputs":[],"verifiers":[],"templates":[],"suite":"suite.json"}\n')
  await writeFile(join(root, 'domain/suite.json'), '{"version":1,"suiteId":"local-design"}\n')
  if (legacy) {
    await writeFile(join(root, 'request.json'), '{"goal":"local design"}\n')
    await writeFile(join(root, 'SETUP_REVIEW.md'), 'Baseline 0.41, improvement 0.53; correctness is independent.\n')
  }
  await writeFile(join(root, 'score.json'), '{"weights":{"area":0.4,"delay":0.6}}\n')
  await writeFile(
    join(root, 'setup-manifest.json'),
    JSON.stringify({
      version: 1,
      domain: 'domain',
      ...(legacy ? { task: 'request.json', review: 'SETUP_REVIEW.md' } : {}),
      files: [
        'setup-manifest.json',
        'domain/task.json',
        'domain/suite.json',
        'score.json',
        ...(legacy ? ['request.json', 'SETUP_REVIEW.md'] : []),
        ...extra,
      ],
    }),
  )
}

it.each([false, true])(
  'freezes a suite package (legacy task/review: %s) and refuses to overwrite an existing approval',
  async legacy => {
    const root = await temp()
    await packageAt(root, [], legacy)
    const result = await approveEnvironmentSetup(root, { reviewer: 'authorized operator' })
    expect(result.reviewedBy).toBe('authorized operator')
    const score = result.files.find((file: { path: string }) => file.path === 'score.json')
    expect(score.sha256).toBe(
      createHash('sha256')
        .update(await readFile(join(root, 'score.json')))
        .digest('hex'),
    )
    expect(result.files).toHaveLength(legacy ? 6 : 4)
    if (legacy) expect(result.task).toBe('request.json')
    else expect(result).not.toHaveProperty('task')
    await writeFile(join(root, 'score.json'), '{"weights":{"area":0.8,"delay":0.2}}\n')
    expect(score.sha256).not.toBe(
      createHash('sha256')
        .update(await readFile(join(root, 'score.json')))
        .digest('hex'),
    )
    await expect(approveEnvironmentSetup(root)).rejects.toMatchObject({ code: 'EEXIST' })
  },
)

it('rejects escaped and symlinked evaluator files before approving', async () => {
  const root = await temp()
  await packageAt(root, ['../outside.json'])
  await expect(approveEnvironmentSetup(root)).rejects.toThrow('normalized relative file')
  await packageAt(root, ['linked/calculator.json'])
  const outside = await temp()
  await writeFile(join(outside, 'calculator.json'), '{}')
  await symlink(outside, join(root, 'linked'), 'dir')
  await expect(approveEnvironmentSetup(root)).rejects.toThrow('must not contain symlinks')
  await expect(readFile(join(root, 'environment-approval.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
