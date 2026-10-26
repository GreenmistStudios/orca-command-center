import { Fragment, type ReactNode } from 'react'
import { cn } from '../lib/cn'

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>)]+)/g

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const tok = m[0]
    const key = `${keyBase}-${i++}`
    if (m[1]) out.push(<code key={key} className="bg-muted rounded px-1 font-mono text-[11px]">{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    else if (m[3]) out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    else if (m[4]) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(tok)!
      out.push(<a key={key} href={mm[2]} target="_blank" rel="noreferrer" className="text-selection underline underline-offset-2">{mm[1]}</a>)
    } else out.push(<a key={key} href={tok} target="_blank" rel="noreferrer" className="text-selection break-all underline underline-offset-2">{tok}</a>)
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Safe minimal markdown: paragraphs, fenced code (with language label), inline code, bold, italic,
 * links (http/https only, `target=_blank rel=noreferrer`) and `-`/`*`/`1.` lists. Never uses
 * `dangerouslySetInnerHTML`; everything is React text nodes.
 */
export function Markdownish({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++])
      i++
      blocks.push(
        <div key={k++} className="my-1.5">
          {fence[1] && <div className="text-muted-foreground/70 mb-0.5 font-mono text-[10px]">{fence[1]}</div>}
          <pre className="pre-block m-0">{code.join('\n')}</pre>
        </div>,
      )
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      const Tag = ordered ? 'ol' : 'ul'
      blocks.push(
        <Tag key={k++} className={cn('my-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}>
          {items.map((it, j) => <li key={j}>{inline(it, `l${k}-${j}`)}</li>)}
        </Tag>,
      )
      continue
    }
    if (line.trim() === '') { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++])
    blocks.push(
      <p key={k++} className="my-1">
        {para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `p${k}-${j}`)}</Fragment>)}
      </p>,
    )
  }
  return <div className={cn('text-[12.5px] leading-relaxed break-words', className)}>{blocks}</div>
}
