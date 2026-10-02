import type { McpServerTemplate } from '../../task-runtime/src/mcp-servers.ts'

export const DEPLOYMENT_MCP_SERVERS: Readonly<Record<string, McpServerTemplate>> = {
  bbdev: {
    serverName: 'bbdev',
    description:
      'buckyball bbdev MCP server (build/simulate/validate; submit + task_status poll) from the env checkout',
    command: '{repoRoot:buckyball}/scripts/claude/run_mcp_server.sh',
    args: [],
    cwd: '{repoRoot:buckyball}',
  },
  waveform: {
    serverName: 'waveform',
    description:
      'buckyball waveform-mcp server (VCD/FST open/read, signal hierarchy, event search) from the env checkout',
    command: '{repoRoot:buckyball}/thirdparty/waveform-mcp/target/release/waveform-mcp',
    args: [],
    cwd: '{repoRoot:buckyball}',
  },
}
