import { watch, statSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { Logger } from '../types.js'

export interface WatchOptions {
  debounceMs?: number
  pollMs?: number
  log?: Pick<Logger, 'warn' | 'debug'>
}

export interface Watcher {
  close(): void
}

function signature(p: string): string | null {
  try {
    const s = statSync(p)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

function dirSignature(p: string): string | null {
  // Directory mtime changes on entry add/remove/rename; content edits are caught by fs.watch.
  return signature(p)
}

function start(
  dir: string,
  filter: ((filename: string) => boolean) | null,
  sig: () => string | null,
  onChange: () => void,
  opts: WatchOptions,
): Watcher {
  const debounceMs = opts.debounceMs ?? 100
  const pollMs = opts.pollMs ?? 2000
  let closed = false
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let warned = false
  let last = sig()

  const fire = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (closed) return
      last = sig()
      onChange()
    }, debounceMs)
    timer.unref()
  }

  const attach = () => {
    if (closed || watcher) return
    try {
      const w = watch(dir, { recursive: false, persistent: false }, (_event, filename) => {
        if (!filter || !filename || filter(String(filename))) fire()
      })
      w.on('error', (err) => {
        if (!warned) {
          warned = true
          opts.log?.warn(`fs.watch error on ${dir}: ${err.message}; falling back to polling`)
        }
        try {
          w.close()
        } catch {
          /* ignore */
        }
        if (watcher === w) watcher = null
      })
      watcher = w
    } catch (err) {
      if (!warned && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warned = true
        opts.log?.warn(`fs.watch failed on ${dir}: ${(err as Error).message}; polling only`)
      }
    }
  }

  attach()
  const poll = setInterval(() => {
    if (closed) return
    if (!watcher) attach()
    const now = sig()
    if (now !== last) {
      last = now
      fire()
    }
  }, pollMs)
  poll.unref()

  return {
    close() {
      closed = true
      clearInterval(poll)
      if (timer) clearTimeout(timer)
      try {
        watcher?.close()
      } catch {
        /* ignore */
      }
      watcher = null
    },
  }
}

/** Watch one file via its parent directory (survives atomic replace), with a stat-poll fallback. */
export function watchPath(file: string, onChange: () => void, opts: WatchOptions = {}): Watcher {
  const dir = path.dirname(file)
  const base = path.basename(file)
  return start(dir, (f) => f === base, () => signature(file), onChange, opts)
}

/** Watch every entry of a directory (non-recursive events + dir stat poll). */
export function watchDirectory(dir: string, onChange: () => void, opts: WatchOptions = {}): Watcher {
  return start(dir, null, () => dirSignature(dir), onChange, opts)
}
