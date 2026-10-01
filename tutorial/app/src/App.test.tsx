import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App, BOARD_STORAGE_KEY } from './App'

afterEach(cleanup)
beforeEach(() => localStorage.clear())

describe('App persistence', () => {
  it('round-trips a new card through localStorage across a remount', () => {
    const first = render(<App />)
    fireEvent.change(screen.getByLabelText('New card title'), { target: { value: 'Persist me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add card' }))
    expect(screen.getByText('Persist me')).toBeInTheDocument()

    const stored = JSON.parse(localStorage.getItem(BOARD_STORAGE_KEY) ?? 'null')
    expect(stored.cards).toEqual([{ id: 'card-1', title: 'Persist me', column: 'todo', archived: false }])
    expect(stored.nextCardNumber).toBe(2)

    first.unmount()
    render(<App />)
    expect(screen.getByText('Persist me')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Todo' })).toBeInTheDocument()
  })

  it('falls back to an empty board when the stored value is corrupt', () => {
    localStorage.setItem(BOARD_STORAGE_KEY, '{ not json')
    render(<App />)
    expect(screen.getByRole('region', { name: 'Todo' })).toBeInTheDocument()
    expect(screen.queryByText('Persist me')).toBeNull()
  })
})
