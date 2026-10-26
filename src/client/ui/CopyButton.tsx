import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from './Button'

/** Copies `text` to the clipboard and shows a check for 1.5 s. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])
  return (
    <IconButton
      aria-label={label}
      className={className}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setDone(true)
        if (t.current) clearTimeout(t.current)
        t.current = setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </IconButton>
  )
}
