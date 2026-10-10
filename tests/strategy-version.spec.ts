/**
 * `strategy@3` at the version gate: a fact of the previous version is refused by name, not re-read.
 *
 * The bump at version 3 moved the **accepted language** of `round/decided` — a decision accounts for
 * every slot the round declared, where version 2 accepted one that accounted only for the submitted
 * ones — so a version 2 fact is not reinterpreted under version 3's reading of a complete decision.
 * The refusal is `version-mismatch` and it names the version that *is* declared, which is the
 * actionable half: replay the log with the build that wrote it, or re-record the round.
 *
 * Both sides read `STRATEGY_VERSION`, so the next bump re-points nothing here: the assertion stays
 * "the version before this one is refused", which is the property every bump in this stack keeps.
 */

import { describe, expect, it } from 'vitest'

import { MemoryLog } from '../src/protocol/memory-log.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { declareStrategyProtocol, STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_ROLE, STRATEGY_VERSION } from '../src/strategy/protocol.ts'
import { asyncRefusalOf } from './fixtures.ts'

const SUBJECTS: Readonly<Record<string, string>> = { [STRATEGY_ROLE]: 'strategy-service' }

describe('a fact of the previous strategy version is refused by name', async () => {
  it('refuses the version before this one, naming the version that is declared', async () => {
    const registry = new ProtocolRegistry()
    declareStrategyProtocol(registry)
    const log = new MemoryLog(registry, { subjects: SUBJECTS, now: () => '2026-10-09T00:00:00.000Z' })
    const previous = STRATEGY_VERSION - 1
    const refusal = await asyncRefusalOf(() =>
      log.emit({ commandId: 'old-version', protocol: STRATEGY_PROTOCOL, version: previous, kind: STRATEGY_KINDS.roundDecided, subject: 'round-1', payload: {} }),
    )
    expect([refusal.code, refusal.detail.includes(`declared at ${STRATEGY_VERSION}`)]).toEqual(['version-mismatch', true])
  })
})
