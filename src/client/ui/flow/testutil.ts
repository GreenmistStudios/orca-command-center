import { vi } from 'vitest'

/** Spy 2D context recording draw calls. */
export function stubCanvas() {
  const calls: string[] = []
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, k: string) {
      if (k in t) return t[k]
      return (..._a: unknown[]) => { calls.push(k) }
    },
    set(t, k: string, v) { t[k] = v; return true },
  }
  const ctx = new Proxy({} as Record<string, unknown>, handler)
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return { calls, ctx, spy }
}

/** Manual requestAnimationFrame queue. */
export function stubRaf() {
  let id = 0
  const q = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { q.set(++id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (i: number) => { q.delete(i) })
  return {
    pending: () => q.size,
    tick(ts: number) {
      const cbs = [...q.values()]
      q.clear()
      for (const cb of cbs) cb(ts)
    },
  }
}

export function setHidden(v: boolean) {
  Object.defineProperty(document, 'hidden', { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}
