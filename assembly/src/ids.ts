import { createHash } from 'node:crypto'

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function taskIdOf(controlId: string, agentId: string, goal: string): string {
  return `task-${sha256(`${controlId}\u0000${agentId}\u0000${goal}`).slice(0, 16)}`
}

export function runIdOf(controlId: string, sessionId: string, callId: string): string {
  return `run-${sha256(`${controlId}\u0000${sessionId}\u0000${callId}`).slice(0, 16)}`
}
