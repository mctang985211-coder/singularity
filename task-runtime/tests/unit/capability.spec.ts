import { describe, expect, test } from 'vitest'
import { capabilitySnapshot, resolveCapabilities, resolvePreset } from '../../src/capability.ts'
import { DEFAULT_CAPABILITIES } from '../../src/index.ts'

describe('resolveCapabilities', () => {
  test('closed closure when every required capability has an entry', () => {
    const manifest = resolveCapabilities(['design-chip', 'verify-ball-functional'], DEFAULT_CAPABILITIES)
    expect(manifest.closure).toBe('closed')
    expect(manifest.missing).toEqual([])
    expect(manifest.capabilities['design-chip']).toEqual({ skills: ['chip-designer'], tools: [] })
    expect(manifest.capabilities['verify-ball-functional']).toEqual({ skills: ['verify'], tools: [], preset: 'bb-verify' })
  })

  test('gap closure lists every missing name and keeps the hits', () => {
    const manifest = resolveCapabilities(['design-chip', 'no-such-cap', 'also-missing'], DEFAULT_CAPABILITIES)
    expect(manifest.closure).toBe('gap')
    expect(manifest.missing).toEqual(['no-such-cap', 'also-missing'])
    expect(Object.keys(manifest.capabilities)).toEqual(['design-chip'])
  })

  test('an empty requirement list is trivially closed', () => {
    const manifest = resolveCapabilities([], DEFAULT_CAPABILITIES)
    expect(manifest).toEqual({ capabilities: {}, missing: [], closure: 'closed' })
  })

  test('the buckyball defaults ship the plan-mandated mapping', () => {
    expect(DEFAULT_CAPABILITIES['design-ball']).toEqual({ skills: ['ball-align'], tools: ['filesystem', 'bash'] })
    expect(DEFAULT_CAPABILITIES['check-ball-registration']).toEqual({ skills: ['check'] })
    expect(DEFAULT_CAPABILITIES['run-bemu-regression']).toEqual({ skills: ['verify'], preset: 'bb-verify' })
    expect(DEFAULT_CAPABILITIES['run-verilator-regression']).toEqual({ skills: ['verify'], preset: 'bb-verify' })
    expect(DEFAULT_CAPABILITIES['analyze-waveform']).toEqual({ skills: ['waveform'] })
    expect(DEFAULT_CAPABILITIES['research']).toEqual({ preset: 'default' })
  })

  test('a config override replaces the default registry', () => {
    const manifest = resolveCapabilities(['research'], { research: { skills: ['web'] } })
    expect(manifest.capabilities['research']).toEqual({ skills: ['web'], tools: [] })
  })
})

describe('manifest flattening', () => {
  test('capabilitySnapshot dedupes and sorts granted skills and tools', () => {
    const manifest = resolveCapabilities(['design-ball', 'design-chip'], DEFAULT_CAPABILITIES)
    expect(capabilitySnapshot(manifest)).toEqual(['ball-align', 'bash', 'chip-designer', 'filesystem'])
  })

  test('resolvePreset prefers the first capability preset, then the default', () => {
    const withPreset = resolveCapabilities(['design-chip', 'verify-ball-functional'], DEFAULT_CAPABILITIES)
    expect(resolvePreset(withPreset, 'fallback')).toBe('bb-verify')
    const withoutPreset = resolveCapabilities(['design-chip'], DEFAULT_CAPABILITIES)
    expect(resolvePreset(withoutPreset, 'fallback')).toBe('fallback')
    expect(resolvePreset(withoutPreset)).toBeUndefined()
  })
})
