export type ColumnId = 'todo' | 'doing' | 'done'

export interface Card {
  id: string
  title: string
  column: ColumnId
  archived: boolean
}

export interface BoardState {
  cards: Card[]
  nextCardNumber: number
}

export type BoardAction =
  | { type: 'card/add'; title: string; column?: ColumnId }
  | { type: 'card/move'; id: string; column: ColumnId }
  | { type: 'card/archive'; id: string }

export const COLUMNS: ReadonlyArray<{ readonly id: ColumnId; readonly label: string }> = [
  { id: 'todo', label: 'Todo' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
]
