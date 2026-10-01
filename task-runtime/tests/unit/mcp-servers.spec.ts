import { describe, expect, test } from 'vitest'
import {
  MCP_SERVER_REGISTRY,
  manifestMcpServers,
  resolveMcpServerSpecs,
  type McpEnvBinding,
} from '../../src/mcp-servers.ts'

const BINDING: McpEnvBinding = {
  envRoot: '/env/project1',
  checkout: repo => (repo === 'buckyball' ? '/env/project1/mctang985211-coder/buckyball' : undefined),
}

function manifest(...servers: string[]) {
  return { capabilities: { 'cap-x': { mcpServers: [...servers] } } }
}

describe('manifestMcpServers', () => {
  test('collects server names across capabilities, first-declaration order, duplicates dropped', () => {
    const m = {
      capabilities: {
        a: { mcpServers: ['bbdev', 'other'] },
        b: { mcpServers: ['bbdev'] },
        c: {},
      },
    }
    expect(manifestMcpServers(m)).toEqual(['bbdev', 'other'])
  })

  test('no declarations means an empty list', () => {
    expect(manifestMcpServers({ capabilities: { a: {} } })).toEqual([])
    expect(manifestMcpServers({ capabilities: {} })).toEqual([])
  })
})

describe('resolveMcpServerSpecs against the shipped registry', () => {
  test('bbdev binds the env checkout into command and cwd, forks included', () => {
    const specs = resolveMcpServerSpecs(manifest('bbdev'), BINDING)
    expect(specs).toEqual([
      {
        serverName: 'bbdev',
        command: '/env/project1/mctang985211-coder/buckyball/scripts/claude/run_mcp_server.sh',
        args: [],
        env: {},
        cwd: '/env/project1/mctang985211-coder/buckyball',
      },
    ])
  })

  test('two capabilities naming the same server mount it once', () => {
    const specs = resolveMcpServerSpecs(
      { capabilities: { a: { mcpServers: ['bbdev'] }, b: { mcpServers: ['bbdev'] } } },
      BINDING,
    )
    expect(specs.map(spec => spec.serverName)).toEqual(['bbdev'])
  })

  test('an unknown server name throws, naming the registry vocabulary', () => {
    expect(() => resolveMcpServerSpecs(manifest('ghost'), BINDING)).toThrow(
      'unknown MCP server "ghost"; known servers: bbdev, waveform',
    )
  })

  test('an env-needing server with no binding fails loudly', () => {
    expect(() => resolveMcpServerSpecs(manifest('bbdev'), undefined)).toThrow(
      'MCP server "bbdev" needs an env binding ({envRoot}/{repoRoot} template) but this run\'s session has none',
    )
  })

  test('a repo the env does not contain fails loudly, naming the repo and the env', () => {
    expect(() =>
      resolveMcpServerSpecs(manifest('bbdev'), { envRoot: '/env/project9', checkout: () => undefined }),
    ).toThrow(
      'MCP server "bbdev" binds {repoRoot:buckyball} but this run\'s env (/env/project9) has no "buckyball" checkout',
    )
  })
})

describe('resolveMcpServerSpecs template mechanics', () => {
  const envFree = {
    serverName: 'static',
    description: 'test double',
    command: '/bin/true',
    args: ['--flag', '{envRoot}'],
    env: { MARKER: '{envRoot}' },
  }

  test('{envRoot} substitutes in args and env; a placeholder in any field makes the server env-bound', () => {
    const specs = resolveMcpServerSpecs(manifest('static'), BINDING, { static: envFree })
    expect(specs[0]).toEqual({
      serverName: 'static',
      command: '/bin/true',
      args: ['--flag', '/env/project1'],
      env: { MARKER: '/env/project1' },
      cwd: '/env/project1',
    })
    // The command carries no placeholder, but args do: the binding is required.
    expect(() => resolveMcpServerSpecs(manifest('static'), undefined, { static: envFree })).toThrow(
      /needs an env binding/,
    )
  })

  test('a fully placeholder-free template mounts with an empty cwd even without a binding', () => {
    const plain = { serverName: 'plain', description: 'test double', command: '/bin/true' }
    const specs = resolveMcpServerSpecs(manifest('plain'), undefined, { plain })
    expect(specs).toEqual([{ serverName: 'plain', command: '/bin/true', args: [], env: {}, cwd: '' }])
  })

  test('a placeholder outside the vocabulary is a template bug and throws', () => {
    const bad = { serverName: 'bad', description: 'test double', command: '{workspace}/bin/x' }
    expect(() => resolveMcpServerSpecs(manifest('bad'), BINDING, { bad })).toThrow(
      'template "{workspace}/bin/x" carries a placeholder outside {envRoot}/{repoRoot:<repo>}',
    )
  })

  test('a per-call timeout declared on the template rides the spec', () => {
    const timed = { ...envFree, serverName: 'timed', toolCallTimeoutMs: 5000 }
    const specs = resolveMcpServerSpecs(manifest('timed'), BINDING, { timed })
    expect(specs[0]!.toolCallTimeoutMs).toBe(5000)
  })
})

describe('the shipped registry', () => {
  test('every template resolves against a buckyball-bearing env without throwing', () => {
    for (const name of Object.keys(MCP_SERVER_REGISTRY)) {
      expect(() => resolveMcpServerSpecs(manifest(name), BINDING), name).not.toThrow()
    }
  })

  test("server names satisfy mcp-client's namespace pattern", () => {
    for (const template of Object.values(MCP_SERVER_REGISTRY)) {
      expect(template.serverName).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    }
  })
})
