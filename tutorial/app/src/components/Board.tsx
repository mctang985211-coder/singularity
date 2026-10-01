import { useState } from 'react'
import type { Card as CardModel, ColumnId } from '../types'
import { Column } from './Column'
import { COLUMNS } from '../types'

export interface BoardProps {
  cards: CardModel[]
  onAdd: (title: string) => void
  onMove: (id: string, column: ColumnId) => void
  onArchive: (id: string) => void
}

export function Board({ cards, onAdd, onMove, onArchive }: BoardProps) {
  throw new Error('Board: not implemented yet')
}
