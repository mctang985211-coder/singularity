import { Board } from './components/Board'
import { useLocalStorageBoard } from './hooks/useLocalStorageBoard'

export const BOARD_STORAGE_KEY = 'tutorial-kanban.board'

export function App() {
  const { board, dispatch } = useLocalStorageBoard(BOARD_STORAGE_KEY)
  return (
    <main>
      <h1>Tutorial Kanban</h1>
      <Board
        cards={board.cards}
        onAdd={title => dispatch({ type: 'card/add', title })}
        onMove={(id, column) => dispatch({ type: 'card/move', id, column })}
        onArchive={id => dispatch({ type: 'card/archive', id })}
      />
    </main>
  )
}
