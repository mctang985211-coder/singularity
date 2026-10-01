const TONES: Record<string, string> = {
  verified: 'ok',
  completed: 'ok',
  approved: 'ok',
  admitted: 'ok',
  running: 'live',
  active: 'live',
  ready: 'live',
  waiting_children: 'warm',
  blocked: 'warn',
  cancelled: 'warn',
  pending_review: 'warn',
  stale: 'warn',
  expired: 'warn',
  failed: 'fail',
  rejected: 'fail',
  submitted: 'accent',
  pending: 'accent',
  decided: 'accent',
  proposed: 'accent',
  candidate: 'accent',
  prepared: 'warm',
  gated: 'warn',
  rolledback: 'warn',
  'recovery-required': 'warn',
  'needs-recovery': 'warn',
  recovering: 'live',
  'not-activated': 'muted',
  'recovery-failed': 'fail',
  pass: 'ok',
  fail: 'fail',
  inconclusive: 'muted',
  'not-worse': 'ok',
  worse: 'fail',
  PROMOTE: 'ok',
  REJECT: 'fail',
  KEEP_FOR_FURTHER_RESEARCH: 'warn',
  fixed: 'ok',
  'fixed-with-regression': 'warn',
  'not-fixed': 'fail',
  maintained: 'ok',
  regressed: 'fail',
  'both-failed': 'warn',
  applied: 'ok',
  interrupted: 'warn',
  'not-admitted': 'warn',
  delivered: 'ok',
  'already-present': 'ok',
  unavailable: 'warn',
  refused: 'warn',
  retry: 'warn',
  skipped: 'muted',
  live: 'ok',
  recovery: 'warm',
  improvement: 'accent',
}

export function statusTone(status: string): string {
  return TONES[status] ?? 'muted'
}

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className="sg-badge" data-tone={statusTone(status)}>
      {status}
    </span>
  )
}
