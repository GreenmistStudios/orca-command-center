import type { SessionSummary } from '../../shared/contract'
import { cn } from '../lib/cn'
import { formatTokens } from '../lib/format'
import { tokenBreakdown, tokenIO, tokenRates } from '../lib/tokens'

/**
 * `↑1.3k ↓250` (tokens in / out) for a session, plus `· 600/m` output tokens per minute while it is
 * working and generating. Renders nothing when the harness reported no tokens.
 */
export function TokenMeter({ s, now, className }: { s: SessionSummary; now: number; className?: string }) {
  const { input, output } = tokenIO(s.tokens)
  if (input + output === 0) return null
  const rate = s.state === 'working' ? tokenRates.rate(s.id, now) : null
  const title = `${tokenBreakdown(s.tokens)}${rate != null ? `\nGenerating ~${formatTokens(rate)} output tokens/min` : ''}`
  return (
    <span data-testid="token-meter" title={title} className={cn('inline-flex items-baseline gap-1 tabular-nums whitespace-nowrap', className)}>
      <span aria-label={`${input} input tokens`}>↑{formatTokens(input)}</span>
      <span aria-label={`${output} output tokens`}>↓{formatTokens(output)}</span>
      {rate != null && (
        <span data-testid="token-rate" className="text-status-dispatched-ink" aria-label={`${Math.round(rate)} output tokens per minute`}>
          · {formatTokens(rate)}/m
        </span>
      )}
    </span>
  )
}
