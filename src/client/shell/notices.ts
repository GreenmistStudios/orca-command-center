import { useSyncExternalStore } from 'react'

/** Tiny inline-notice store (shown in the banner area), e.g. for unknown ids in the URL. */
let notices: Array<{ key: string; text: string }> = []
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function addNotice(key: string, text: string): void {
  if (notices.some((n) => n.key === key)) return
  notices = [...notices, { key, text }]
  emit()
}
export function dismissNotice(key: string): void {
  notices = notices.filter((n) => n.key !== key)
  emit()
}
export function clearNotices(): void { notices = []; emit() }
export function useNotices() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => notices, () => notices)
}
