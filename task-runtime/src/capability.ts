import type { CapabilityManifest } from '@dangosys/dsh-singularity-task'

/** One capability entry as held in plugin Config (arrays optional pre-validation). */
export interface CapabilityConfig {
  skills?: string[]
  tools?: string[]
  preset?: string
}

/**
 * Resolve required capability names against the configured registry.
 * A required name that has an entry contributes its skills/tools/preset to the
 * manifest; a name without an entry lands in `missing`. Closure is `closed`
 * when nothing is missing, otherwise `gap`.
 */
export function resolveCapabilities(
  required: readonly string[],
  registry: Readonly<Record<string, CapabilityConfig>>,
): CapabilityManifest {
  const capabilities: CapabilityManifest['capabilities'] = {}
  const missing: string[] = []
  for (const name of required) {
    const entry = registry[name]
    if (entry === undefined) {
      missing.push(name)
      continue
    }
    capabilities[name] = {
      skills: [...(entry.skills ?? [])],
      tools: [...(entry.tools ?? [])],
      ...(entry.preset !== undefined ? { preset: entry.preset } : {}),
    }
  }
  return { capabilities, missing, closure: missing.length > 0 ? 'gap' : 'closed' }
}

/** Flatten a manifest's granted skills and tools into a run's capability snapshot. */
export function capabilitySnapshot(manifest: CapabilityManifest): string[] {
  const granted = new Set<string>()
  for (const entry of Object.values(manifest.capabilities)) {
    for (const skill of entry.skills) granted.add(skill)
    for (const tool of entry.tools) granted.add(tool)
  }
  return [...granted].sort()
}

/** First preset named by a matched capability, else the configured default. */
export function resolvePreset(manifest: CapabilityManifest, defaultPreset?: string): string | undefined {
  for (const entry of Object.values(manifest.capabilities)) {
    if (entry.preset !== undefined) return entry.preset
  }
  return defaultPreset
}
