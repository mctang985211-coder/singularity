import type { Card as CardModel, ColumnId } from '../types'

export interface CardProps {
  card: CardModel
  onMove: (id: string, column: ColumnId) => void
  onArchive: (id: string) => void
}

export function Card({ card, onMove, onArchive }: CardProps) {
  throw new Error('Card: not implemented yet')
}
