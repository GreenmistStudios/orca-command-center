import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DiffView } from './DiffView'
import { Markdownish } from './Markdownish'
import { Segmented, TabList } from './Segmented'
import { AgentMonogram } from './Monogram'
import { IconButton } from './Button'
import { Duration } from './Time'
import { TokenMeter } from './TokenMeter'
import { tokenRates } from '../lib/tokens'
import type { SessionSummary } from '../../shared/contract'

describe('TokenMeter', () => {
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const sess = (o: Partial<SessionSummary>) => ({ id: 'tm', state: 'working', tokens: zero, ...o }) as SessionSummary

  it('renders nothing without tokens', () => {
    const { container } = render(<TokenMeter s={sess({})} now={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows in/out and the output rate only while working', () => {
    tokenRates.forget('tm')
    tokenRates.record('tm', 0, 0)
    tokenRates.record('tm', 60_000, 1500)
    const tokens = { input: 2000, output: 1200, reasoning: 300, cacheRead: 40_000, cacheWrite: 500 }
    const { rerender } = render(<TokenMeter s={sess({ tokens })} now={60_000} />)
    expect(screen.getByTestId('token-meter')).toHaveTextContent('↑42.5k↓1.5k· 1.5k/m')
    expect(screen.getByTestId('token-meter')).toHaveAttribute('title', expect.stringContaining('Cache read 40,000'))
    rerender(<TokenMeter s={sess({ tokens, state: 'idle' })} now={60_000} />)
    expect(screen.queryByTestId('token-rate')).toBeNull()
    tokenRates.forget('tm')
  })
})

describe('ui primitives', () => {
  it('Markdownish renders safe markup without raw HTML', () => {
    const { container } = render(<Markdownish text={'Hello **bold** and `code` <script>alert(1)</script>\n\n```ts\nconst a = 1\n```\n\n- one\n- two\n\nsee https://example.com/x'} />)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(screen.getByText('ts')).toBeInTheDocument()
    expect(container.querySelectorAll('li')).toHaveLength(2)
    const a = container.querySelector('a')!
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noreferrer')
  })

  it('DiffView renders unified diff lines and caps with show-all', async () => {
    const text = '--- a/x\n+++ b/x\n@@ -1,1 +1,3 @@\n a\n+b\n+c\n'
    render(<DiffView diff={{ id: '1', path: 'x', format: 'unified', text, note: null, truncated: false }} maxLines={2} />)
    expect(document.querySelectorAll('[data-line]')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: /show all/i }))
    expect(document.querySelectorAll('[data-line="add"]')).toHaveLength(2)
  })

  it('DiffView shows the note for format none', () => {
    render(<DiffView diff={{ id: '1', path: 'x', format: 'none', text: null, note: 'Binary file', truncated: false }} />)
    expect(screen.getByText('Binary file')).toBeInTheDocument()
  })

  it('Segmented and TabList call onChange', async () => {
    const onChange = vi.fn()
    render(<Segmented options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="a" onChange={onChange} />)
    await userEvent.click(screen.getByRole('radio', { name: 'B' }))
    expect(onChange).toHaveBeenCalledWith('b')
    const tabChange = vi.fn()
    render(<TabList tabs={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }]} value="x" onChange={tabChange} />)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Y' }))
    expect(tabChange).toHaveBeenCalledWith('y')
  })

  it('AgentMonogram, IconButton, Duration', () => {
    render(<><AgentMonogram agent="sonnet-coder" /><IconButton aria-label="Close" /><Duration start={0} end={125 * 60_000} /></>)
    expect(screen.getByText('SC')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.getByText('2h 5m')).toBeInTheDocument()
  })
})
