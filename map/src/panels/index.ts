import type { ComponentType } from 'react'
import CanvasPanel from './canvas'
import TasksPanel from './tasks'
import ProposalsPanel from './proposals'
import EvolutionPanel from './evolution'
import RecoveryPanel from './recovery'
import VerifierPanel from './verifier'

export interface PanelDef {
  readonly id: string
  readonly label: string
  readonly component: ComponentType
}

/** Tab registry: later waves append panels here; App renders whatever this list holds. */
export const PANELS: readonly PanelDef[] = [
  { id: 'canvas', label: 'Canvas', component: CanvasPanel },
  { id: 'tasks', label: 'Tasks', component: TasksPanel },
  { id: 'proposals', label: 'Proposals', component: ProposalsPanel },
  { id: 'evolution', label: 'Evolution', component: EvolutionPanel },
  { id: 'recovery', label: 'Recovery', component: RecoveryPanel },
  { id: 'verifier', label: 'Verifier', component: VerifierPanel },
]

export function panelById(id: string): PanelDef {
  return PANELS.find(panel => panel.id === id) ?? PANELS[0]
}
