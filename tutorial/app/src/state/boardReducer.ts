import type { BoardAction, BoardState } from '../types'

export function initialBoard(): BoardState {
  return { cards: [], nextCardNumber: 1 }
}

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  throw new Error(`boardReducer: action "${action.type}" is not implemented yet`)
}
