import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Board } from './Board'
import type { Card } from '../types'

afterEach(cleanup)

function card(overrides: Partial<Card> = {}): Card {
  return { id: 'card-1', title: 'Write tests', column: 'todo', archived: false, ...overrides }
}

function renderBoard(cards: Card[] = []) {
  const onAdd = vi.fn()
  const onMove = vi.fn()
  const onArchive = vi.fn()
  render(<Board cards={cards} onAdd={onAdd} onMove={onMove} onArchive={onArchive} />)
  return { onAdd, onMove, onArchive }
}

describe('Board', () => {
  it('renders the three columns in order', () => {
    renderBoard()
    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
      'Todo',
      'Doing',
      'Done',
    ])
  })

  it('shows each card in its own column and hides archived cards', () => {
    renderBoard([
      card(),
      card({ id: 'card-2', title: 'Ship it', column: 'done' }),
      card({ id: 'card-3', title: 'Old news', archived: true }),
    ])
    const todo = screen.getByRole('region', { name: 'Todo' })
    expect(within(todo).getByText('Write tests')).toBeInTheDocument()
    expect(within(todo).queryByText('Ship it')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Ship it')).toBeInTheDocument()
    expect(screen.queryByText('Old news')).toBeNull()
  })

  it('submits a trimmed title and clears the input', () => {
    const { onAdd } = renderBoard()
    const input = screen.getByLabelText('New card title') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  Write tests  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('Write tests')
    expect(input.value).toBe('')
  })

  it('ignores an empty or whitespace-only title', () => {
    const { onAdd } = renderBoard()
    const input = screen.getByLabelText('New card title')
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('moves a card through its column selector', () => {
    const { onMove } = renderBoard([card()])
    const select = screen.getByRole('combobox', { name: 'Move Write tests' })
    fireEvent.change(select, { target: { value: 'doing' } })
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith('card-1', 'doing')
  })

  it('archives a card from its own button', () => {
    const { onArchive } = renderBoard([card()])
    fireEvent.click(screen.getByRole('button', { name: 'Archive Write tests' }))
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onArchive).toHaveBeenCalledWith('card-1')
  })
})
