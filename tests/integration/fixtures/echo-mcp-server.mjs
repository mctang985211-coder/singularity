/**
 * Minimal stdio MCP fixture server for tests/integration/worker-mcp.spec.ts.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio transport):
 * `initialize` (echoing the client's protocolVersion), `ping`, `tools/list`,
 * and `tools/call`, exposing a single `echo` tool. Notifications (no `id`)
 * get no answer. It exists so the spec exercises the harness-side mount seam
 * (mcp__<server>__<tool> visibility, fail-loud startup, serverName collision)
 * without depending on any production MCP server.
 */

import readline from 'node:readline'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function fail(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n')
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined || msg.id === null) return
  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-fixture', version: '0.0.0' },
      })
      break
    case 'ping':
      reply(msg.id, {})
      break
    case 'tools/list':
      reply(msg.id, { tools: TOOLS })
      break
    case 'tools/call':
      reply(msg.id, { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] })
      break
    default:
      fail(msg.id, `unknown method ${msg.method}`)
  }
})
