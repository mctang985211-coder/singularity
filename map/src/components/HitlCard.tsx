import { useState } from 'react'
import { useStore, type HitlPending } from '../store'

export default function HitlCard({ item, showSession = false }: { item: HitlPending; showSession?: boolean }) {
  const answerHitl = useStore(s => s.answerHitl)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (
    answer: { kind: 'ask'; text: string } | { kind: 'approve'; decision: 'approve' | 'reject' },
  ) => {
    setSubmitting(true)
    setError(null)
    try {
      await answerHitl(item.id, answer)
      setText('')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (item.kind === 'ask') {
    return (
      <form
        className="sg-hitl"
        onSubmit={e => {
          e.preventDefault()
          const value = text.trim()
          if (value.length === 0) throw new Error('map: empty hitl answer')
          void submit({ kind: 'ask', text: value })
        }}
      >
        <div className="sg-hitl-label">Ask</div>
        <div className="sg-hitl-prompt">{item.prompt}</div>
        {showSession && <div className="sg-hitl-session">{item.sessionId}</div>}
        <textarea
          value={text}
          disabled={submitting}
          onChange={e => setText(e.target.value)}
          rows={3}
          placeholder="Your answer…"
        />
        <button type="submit" disabled={submitting || text.trim().length === 0}>
          Submit
        </button>
        {error !== null && <div role="alert">{error}</div>}
      </form>
    )
  }

  return (
    <div className="sg-hitl">
      <div className="sg-hitl-label">Approve</div>
      <div className="sg-hitl-prompt">{item.prompt}</div>
      {showSession && <div className="sg-hitl-session">{item.sessionId}</div>}
      <div className="sg-hitl-actions">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void submit({ kind: 'approve', decision: 'approve' })}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={submitting}
          className="reject"
          onClick={() => void submit({ kind: 'approve', decision: 'reject' })}
        >
          Reject
        </button>
      </div>
      {error !== null && <div role="alert">{error}</div>}
    </div>
  )
}
