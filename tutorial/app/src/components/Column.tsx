import type { Card as CardModel, ColumnId } from '../types'

export interface ColumnProps {
  column: { readonly id: ColumnId; readonly label: string }
  cards: CardModel[]
  onMove: (id: string, column: ColumnId) => void
  onArchive: (id: string) => void
}

export function Column({ column, cards, onMove, onArchive }: ColumnProps) {
  throw new Error('Column: not implemented yet')
}
