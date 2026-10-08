import { describe, expect, it } from 'vitest'
import { rebaseWorkspacePaths } from '../../src/replay-paths.ts'

describe('replay workspace path mapping', () => {
  it('moves declared paths and command arguments while keeping neighbouring roots and checks unchanged', () => {
    const source = {
      objective: 'Build /project/input and compare /project/output.',
      command: 'python3 "/project/check.py" --root=/project --input=/project/input; test -f /project-other/result',
      protectedInputs: [{ path: '/project/fixture.bin', sha256: 'same-bytes' }],
      requiredCapabilities: ['execute-task'],
    }
    const result = rebaseWorkspacePaths(source, '/project', '/experiment/baseline')
    expect(result.command).toBe('python3 "/experiment/baseline/check.py" --root=/experiment/baseline --input=/experiment/baseline/input; test -f /project-other/result')
    expect(result.protectedInputs).toEqual([{ path: '/experiment/baseline/fixture.bin', sha256: 'same-bytes' }])
    expect(result.requiredCapabilities).toEqual(source.requiredCapabilities)
    expect(source.protectedInputs[0]!.path).toBe('/project/fixture.bin')
  })

  it('refuses an ambiguous filesystem-root mapping', () => {
    expect(() => rebaseWorkspacePaths('/file', '/', '/side')).toThrow('specific source directory')
    expect(() => rebaseWorkspacePaths('/file', 'relative', '/side')).toThrow('absolute roots')
  })
})
