import { Circle, CircleCheck, CircleSlash, ListChecks, LoaderCircle } from 'lucide-react'
import type { TodoItem } from '../../shared/contract'
import { cn } from '../lib/cn'
import { useOcc } from '../state/store'
import { EmptyState } from '../ui'

export function TodoIcon({ status }: { status: string }) {
  switch (status) {
    case 'in_progress': return <LoaderCircle size={13} className="text-status-dispatched shrink-0 animate-spin" aria-label="in progress" />
    case 'completed': return <CircleCheck size={13} className="text-status-completed shrink-0" aria-label="completed" />
    case 'cancelled': return <CircleSlash size={13} className="text-muted-foreground shrink-0" aria-label="cancelled" />
    default: return <Circle size={13} className="text-muted-foreground shrink-0" aria-label="pending" />
  }
}

const PRIORITY: Record<string, string> = { high: 'bg-status-failed', medium: 'bg-status-blocked', low: 'bg-status-pending' }

export function TodoRow({ t }: { t: Pick<TodoItem, 'content' | 'status'> & { priority?: string } }) {
  return (
    <li className="flex items-start gap-2 text-[12px]">
      <span className="mt-0.5"><TodoIcon status={t.status} /></span>
      {t.priority && <span title={`${t.priority} priority`} className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', PRIORITY[t.priority] ?? 'bg-status-unknown')} />}
      <span className={cn('min-w-0 break-words', (t.status === 'completed' || t.status === 'cancelled') && 'text-muted-foreground line-through')}>{t.content}</span>
    </li>
  )
}

export function TodosTab({ sessionId }: { sessionId: string }) {
  const todos = useOcc((s) => s.details[sessionId]?.data?.todos) ?? []
  if (!todos.length) return <EmptyState icon={<ListChecks size={20} />} title="No todos" />
  return <ul className="m-0 flex list-none flex-col gap-2 p-3" data-testid="todos">{[...todos].sort((a, b) => a.position - b.position).map((t) => <TodoRow key={t.id} t={t} />)}</ul>
}
