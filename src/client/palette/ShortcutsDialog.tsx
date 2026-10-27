import { Dialog } from 'radix-ui'
import { useOcc } from '../state/store'
import { Kbd } from '../ui/Pills'

export const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['⌘/Ctrl', 'K'], label: 'Command palette' },
  { keys: ['o'], label: 'Oversight: all repos and agents' },
  { keys: ['1', '–', '6'], label: 'Fleet · DAG · Timeline · Stream · Changes · Overview' },
  { keys: ['j', 'k'], label: 'Next / previous root session' },
  { keys: ['J', 'K'], label: 'Next / previous session in the cast' },
  { keys: ['Esc'], label: 'Close overlay, then clear task → session → run' },
  { keys: ['/'], label: 'Focus rail search' },
  { keys: ['.'], label: 'Toggle Live only' },
  { keys: ['f'], label: 'Toggle stream follow' },
  { keys: ['Space'], label: 'Pause / resume stream (Stream view)' },
  { keys: ['t'], label: 'Toggle theme' },
  { keys: ['?'], label: 'Show this help' },
]

/** Keyboard shortcut help overlay (`ui.shortcutsOpen`). */
export function ShortcutsDialog() {
  const open = useOcc((s) => s.ui.shortcutsOpen)
  const setOpen = useOcc((s) => s.setShortcutsOpen)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content aria-describedby={undefined} data-testid="shortcuts-dialog" className="panel bg-panel-solid fixed top-[16vh] left-1/2 z-50 w-[min(28rem,calc(100vw-1.5rem))] -translate-x-1/2 p-4 outline-none">
          <Dialog.Title className="mb-3 text-sm font-semibold">Keyboard shortcuts</Dialog.Title>
          <ul className="flex flex-col gap-2 text-xs">
            {SHORTCUTS.map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-4">
                <span>{s.label}</span>
                <span className="flex shrink-0 gap-1">{s.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
