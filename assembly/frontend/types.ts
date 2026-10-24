export interface AgentData {
  name: string
  status: 'idle' | 'running' | 'waiting' | 'done' | 'failed'
  root: boolean
  width: number
  height: number
}
export interface ChatRow {
  role: string
  text: string
}
