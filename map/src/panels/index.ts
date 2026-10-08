import type { ComponentType } from 'react'
import type { AccessMode } from '../store'
import CanvasPanel from './canvas'
import HistoryPanel from './history'
import MethodsPanel from './methods'
import TasksPanel from './tasks'
import ViewPanel from './view'
import RecoveryPanel from './recovery'
import VerifierPanel from './verifier'

export interface PanelDef {
  readonly id: string
  readonly label: string
  readonly component: ComponentType
}

/** The panels a current-protocol graph shows: its canvas, its unified read model, its method library, its task plane. */
const CURRENT_PANELS: readonly PanelDef[] = [
  { id: 'canvas', label: 'Canvas', component: CanvasPanel },
  { id: 'view', label: 'View', component: ViewPanel },
  { id: 'methods', label: 'Methods', component: MethodsPanel },
  { id: 'tasks', label: 'Tasks', component: TasksPanel },
  { id: 'recovery', label: 'Recovery', component: RecoveryPanel },
  { id: 'verifier', label: 'Verifier', component: VerifierPanel },
]

/** The one panel a sealed legacy graph shows: its own history, and every write control with it. */
const LEGACY_PANELS: readonly PanelDef[] = [{ id: 'history', label: 'History', component: HistoryPanel }]

/** The panels one access mode shows; a sealed graph has no canvas, no settings and no method surface. */
export function panelsFor(mode: AccessMode): readonly PanelDef[] {
  return mode === 'current' ? CURRENT_PANELS : LEGACY_PANELS
}

export function panelById(id: string, mode: AccessMode): PanelDef {
  const panels = panelsFor(mode)
  return panels.find(panel => panel.id === id) ?? panels[0]!
}
