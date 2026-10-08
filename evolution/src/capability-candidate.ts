/**
 * The capability row vocabulary: the shape one whole `CapabilityConfig` row
 * carries, validated at the one door both the capability adapter and a revision
 * manifest read it through.
 *
 * @module dsh-singularity-evolution/capability-candidate
 */

import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { codedRefusal, isRecord } from './shared.ts'

/** The keys a capability row may declare — the whole vocabulary `CapabilityConfig` has. */
const ROW_KEYS: readonly string[] = ['skills', 'tools', 'preset', 'permission', 'mcpServers']

/** The refusal of one rule, carrying its machine-readable code as the message's second word. */
export function capabilityRefusal(code: string, detail: string): Error {
  return codedRefusal(code, detail)
}

/** The same refusal, as the one function every rule in this module reports through. */
function refusal(code: string, detail: string): Error {
  return capabilityRefusal(code, detail)
}

/** Validate one capability row's shape and return it normalized — the whole row, no inherited field and no unknown key. */
export function assertCapabilityRow(where: string, value: unknown): CapabilityConfig {
  if (!isRecord(value)) {
    throw refusal(
      'capability-row-invalid',
      `${where} must be an object carrying the row's own fields (${ROW_KEYS.join(', ')})`,
    )
  }
  for (const key of Object.keys(value)) {
    if (!ROW_KEYS.includes(key)) {
      throw refusal(
        'capability-row-invalid',
        `${where} declares unknown field ${JSON.stringify(key)}; a capability row carries ${ROW_KEYS.join(', ')}`,
      )
    }
  }
  const names = (field: string, list: unknown, minItems: number): string[] | undefined => {
    if (list === undefined) return undefined
    if (!Array.isArray(list)) throw refusal('capability-row-invalid', `${where}.${field} must be an array`)
    const seen = new Set<string>()
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw refusal('capability-row-invalid', `${where}.${field} must hold non-empty strings`)
      }
      if (seen.has(item))
        throw refusal('capability-row-invalid', `${where}.${field} lists ${JSON.stringify(item)} twice`)
      seen.add(item)
    }
    if (list.length < minItems)
      throw refusal('capability-row-invalid', `${where}.${field} must name at least ${minItems} entry`)
    return [...list]
  }
  const skills = names('skills', value.skills, 0)
  const entry: CapabilityConfig = skills === undefined ? {} : { skills }
  const tools = names('tools', value.tools, 0)
  if (tools !== undefined) entry.tools = tools
  const mcpServers = names('mcpServers', value.mcpServers, 0)
  if (mcpServers !== undefined) entry.mcpServers = mcpServers
  for (const field of ['preset', 'permission'] as const) {
    const declared = value[field]
    if (declared === undefined) continue
    if (typeof declared !== 'string' || declared.trim().length === 0) {
      throw refusal('capability-row-invalid', `${where}.${field} must be a non-empty string`)
    }
    entry[field] = declared
  }
  if ((skills?.length ?? 0) + (tools?.length ?? 0) + (mcpServers?.length ?? 0) === 0)
    throw refusal('capability-row-invalid', `${where} must grant a skill, native tool or MCP server`)
  return entry
}
