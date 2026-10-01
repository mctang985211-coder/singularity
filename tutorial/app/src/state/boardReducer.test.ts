import { describe, expect, it } from 'vitest'
import { boardReducer, initialBoard } from './boardReducer'
import type { BoardState, Card } from '../types'

function card(overrides: Partial<Card> = {}): Card {
  return { id: 'card-1', title: 'Write tests', column: 'todo', archived: false, ...overrides }
}

function withCards(...titles: string[]): BoardState {
  return titles.reduce((state, title) => boardReducer(state, { type: 'card/add', title }), initialBoard())
}

describe('initialBoard', () => {
  it('starts empty with the first card number ready', () => {
    expect(initialBoard()).toEqual({ cards: [], nextCardNumber: 1 })
  })
})

describe('card/add', () => {
  it('appends a todo card with a sequential id and bumps the counter', () => {
    const first = boardReducer(initialBoard(), { type: 'card/add', title: 'Write tests' })
    expect(first.cards).toEqual([card()])
    expect(first.nextCardNumber).toBe(2)

    const second = boardReducer(first, { type: 'card/add', title: 'Ship it' })
    expect(second.cards.map(c => c.id)).toEqual(['card-1', 'card-2'])
    expect(second.cards[1]).toEqual(card({ id: 'card-2', title: 'Ship it' }))
  })

  it('honours an explicit target column', () => {
    const next = boardReducer(initialBoard(), { type: 'card/add', title: 'Deploy', column: 'done' })
    expect(next.cards[0]).toEqual(card({ title: 'Deploy', column: 'done' }))
  })

  it('does not mutate the previous state', () => {
    const state = initialBoard()
    boardReducer(state, { type: 'card/add', title: 'Write tests' })
    expect(state).toEqual(initialBoard())
  })
})

describe('card/move', () => {
  it('moves only the named card and keeps the card order stable', () => {
    const state = withCards('Write tests', 'Ship it')
    const next = boardReducer(state, { type: 'card/move', id: 'card-1', column: 'doing' })
    expect(next.cards).toEqual([card({ column: 'doing' }), card({ id: 'card-2', title: 'Ship it' })])
    expect(state.cards[0].column).toBe('todo')
  })

  it('returns the same state for an unknown id', () => {
    const state = withCards('Write tests', 'Ship it')
    expect(boardReducer(state, { type: 'card/move', id: 'missing', column: 'done' })).toBe(state)
  })

  it('returns the same state when the card is already in the target column', () => {
    const state = withCards('Write tests', 'Ship it')
    expect(boardReducer(state, { type: 'card/move', id: 'card-1', column: 'todo' })).toBe(state)
  })
})

describe('card/archive', () => {
  it('marks the card archived without removing it', () => {
    const state = withCards('Write tests', 'Ship it')
    const next = boardReducer(state, { type: 'card/archive', id: 'card-1' })
    expect(next.cards).toHaveLength(2)
    expect(next.cards[0]).toEqual(card({ archived: true }))
    expect(next.cards[1]).toEqual(card({ id: 'card-2', title: 'Ship it' }))
    expect(state.cards[0].archived).toBe(false)
  })

  it('is a no-op for an unknown or already archived card', () => {
    const state = withCards('Write tests', 'Ship it')
    const archived = boardReducer(state, { type: 'card/archive', id: 'card-1' })
    expect(boardReducer(archived, { type: 'card/archive', id: 'card-1' })).toBe(archived)
    expect(boardReducer(state, { type: 'card/archive', id: 'missing' })).toBe(state)
  })
})
