export const CHECKOUT: string
export const HOST_LINK: string
export function hostInstall(root?: string, configured?: string): string
export function hostRequire(installed?: string): NodeRequire
export function hostFindings(installed: string, baseline?: unknown): string[]
export function configureHost(root?: string, configured?: string): Promise<string>
