import {
  Activity, Bot, Brain, CircleDashed, CircleX, Check, FileDiff, FilePenLine, FilePlus, FileText, Footprints,
  Globe, ListChecks, LoaderCircle, MessageCircleQuestion, MessageSquare, MessageSquareText, Plug, Puzzle,
  Search, ShieldAlert, Sparkles, SquareTerminal, Waypoints, Wrench, X, type LucideIcon,
} from 'lucide-react'
import type { ActivityKind, ActivityStatus, ToolCallInfo, ToolCategory } from '../../shared/contract'
import { cn } from '../lib/cn'
import { activityStatusTone, kindColorVar, toneClasses } from './tones'

export const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  prompt: MessageSquareText, thinking: Brain, text: MessageSquare, tool: Wrench, mcp: Plug,
  'file-change': FileDiff, subagent: Bot, todo: ListChecks, step: Footprints, state: Activity,
  permission: ShieldAlert, error: CircleX, orchestration: Waypoints,
}

export const TOOL_ICON: Record<ToolCategory, LucideIcon> = {
  shell: SquareTerminal, read: FileText, search: Search, edit: FilePenLine, write: FilePlus, patch: FileDiff,
  web: Globe, subagent: Bot, todo: ListChecks, question: MessageCircleQuestion, skill: Sparkles, mcp: Plug,
  plugin: Puzzle, other: Wrench,
}

/** Kind icon in the kind color; for `tool` kinds pass `category` to pick the category glyph. */
export function KindIcon({ kind, category, size = 14, className }: { kind: ActivityKind; category?: ToolCategory | null; size?: number; className?: string }) {
  const Icon = kind === 'tool' && category ? TOOL_ICON[category] : KIND_ICON[kind]
  return <Icon size={size} className={cn('shrink-0', className)} style={{ color: kindColorVar(kind) }} data-kind={kind} aria-hidden />
}

/** Tool name with category icon; MCP calls get a server badge. */
export function ToolBadge({ tool, className }: { tool: ToolCallInfo; className?: string }) {
  const Icon = TOOL_ICON[tool.category]
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-testid="tool-badge">
      <Icon size={13} className="shrink-0" style={{ color: kindColorVar(tool.category === 'mcp' ? 'mcp' : 'tool') }} aria-hidden />
      {tool.mcpServer && (
        <span
          className="shrink-0 rounded px-1.5 font-mono text-[9.5px] font-bold"
          style={{ color: 'var(--kind-mcp)', background: 'color-mix(in oklch, var(--kind-mcp) 14%, transparent)' }}
        >
          {tool.mcpServer}
        </span>
      )}
      <span className="truncate font-mono text-[11px]">{tool.mcpServer ? tool.displayName : tool.name}</span>
    </span>
  )
}

/** Status → spinner / check / x / dashed circle. */
export function StatusGlyph({ status, size = 13, className }: { status: ActivityStatus | null; size?: number; className?: string }) {
  const color = status ? toneClasses(activityStatusTone(status)).text : 'text-muted-foreground'
  const cls = cn('shrink-0', status === 'completed' ? 'text-status-completed' : status === 'error' ? 'text-status-failed' : status === 'running' ? 'text-status-dispatched' : color, className)
  switch (status) {
    case 'running': return <LoaderCircle size={size} className={cn(cls, 'animate-spin')} aria-label="running" />
    case 'completed': return <Check size={size} className={cls} aria-label="completed" />
    case 'error': return <X size={size} className={cls} aria-label="error" />
    default: return <CircleDashed size={size} className={cls} aria-label={status ?? 'unknown'} />
  }
}
