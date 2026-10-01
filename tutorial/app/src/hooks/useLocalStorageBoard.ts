import type { Dispatch } from 'react'
import type { BoardAction, BoardState } from '../types'

export interface LocalStorageBoard {
  board: BoardState
  dispatch: Dispatch<BoardAction>
}

export function useLocalStorageBoard(key: string): LocalStorageBoard {
  throw new Error(`useLocalStorageBoard: not implemented yet (key "${key}")`)
}
