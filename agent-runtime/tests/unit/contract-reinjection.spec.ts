import { describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import {
  carriesContract,
  contractSection,
  installWorkerContract,
  WORKER_CONTRACT_ORDER,
  WORKER_CONTRACT_SECTION,
} from '../../src/contract-reinjection.ts'

const CONTRACT = 'worker-contract task="c1"\nimplement the feature'

/** The seam `installWorkerContract` writes through, with nothing else on it. */
function registry(): { ctx: Context; sections: PromptSection[] } {
  const sections: PromptSection[] = []
  return { ctx: { systemPrompt: { section: (section: PromptSection) => sections.push(section) } } as unknown as Context, sections }
}

describe('carriesContract', () => {
  test('a spawn only carries a contract when there is text to project', () => {
    expect(carriesContract(undefined)).toBe(false)
    expect(carriesContract('')).toBe(false)
    expect(carriesContract(' \n\t ')).toBe(false)
    expect(carriesContract(CONTRACT)).toBe(true)
  })
})

describe('contractSection', () => {
  test('names one dedicated section at the worker-contract order, with interpolation off', () => {
    const section = contractSection(CONTRACT)
    expect(section.name).toBe(WORKER_CONTRACT_SECTION)
    expect(section.order).toBe(WORKER_CONTRACT_ORDER)
    expect(section.interpolate).toBe(false)
    expect(section.text).toBe(CONTRACT)
  })

  test('sits after the root persona section and before the composition tool guidance', () => {
    expect(WORKER_CONTRACT_ORDER).toBeGreaterThan(70)
    expect(WORKER_CONTRACT_ORDER).toBeLessThan(500)
  })
})

describe('installWorkerContract', () => {
  test('registers nothing for a contract-less spawn', () => {
    for (const contract of [undefined, '', '   ']) {
      const { ctx, sections } = registry()
      expect(installWorkerContract(ctx, contract), String(contract)).toBe(false)
      expect(sections).toHaveLength(0)
    }
  })

  test('registers exactly one section carrying the contract verbatim', () => {
    const { ctx, sections } = registry()
    expect(installWorkerContract(ctx, CONTRACT)).toBe(true)
    expect(sections).toEqual([contractSection(CONTRACT)])
  })

  test('registers into the agent scope it is handed, not a global registry', () => {
    const section = vi.fn()
    installWorkerContract({ systemPrompt: { section } } as unknown as Context, CONTRACT)
    // `section()` files into the CALLING context's scope, so this call is what
    // keeps the contract on the worker's plane and off the root's.
    expect(section).toHaveBeenCalledOnce()
  })
})

describe('the registered section in a real assembly', () => {
  test('reaches the rendered system prompt as literal text, braces and all', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      // An objective or a criterion may contain `{{…}}`; with interpolation on,
      // `renderPrompt` would read those as prompt variables and throw on an
      // unknown name. The contract is data, so it must arrive untouched.
      const literal = 'objective: keep {{cwd}} and {{not_a_variable}} verbatim'
      expect(installWorkerContract(ctx, literal)).toBe(true)
      const rendered = renderPrompt(await ctx.systemPrompt.assemble({}))
      expect(rendered).toContain(literal)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  test('renders byte-identically on a second assembly', async () => {
    // The loop only skips a system-prompt write when the rendered text equals
    // what node 0 already holds, so determinism here is what makes the
    // projection idempotent rather than a per-step append.
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      installWorkerContract(ctx, CONTRACT)
      const first = renderPrompt(await ctx.systemPrompt.assemble({}))
      const second = renderPrompt(await ctx.systemPrompt.assemble({}))
      expect(first).toBe(second)
      expect(first).toContain(CONTRACT)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
