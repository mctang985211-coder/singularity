import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('gives scripts the same frozen usage disclosure supplied to the RSI agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-script-'))
  try {
    const report = {
      root: { taskId: 'root', runId: 'run' },
      summary: {
        usage: {
          source: 'token-meter/tokenUsage',
          tokens: 13,
        },
        sessions: [
          {
            sessionId: 'session',
            eventCount: 10,
            tokenUsage: { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        ],
      },
    }
    const path = join(root, 'subject.json')
    await writeFile(path, JSON.stringify(report))
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../scripts/usage-report.mjs', import.meta.url)),
      path,
    ])
    expect(JSON.parse(stdout)).toEqual({
      root: report.root,
      usage: report.summary.usage,
      sessions: report.summary.sessions,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
