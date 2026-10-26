import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub

/** Minimal EventSource stub; tests can drive it through `FakeEventSource.instances`. */
export class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  close() { this.readyState = 2 }
}
if (!('EventSource' in globalThis)) (globalThis as Record<string, unknown>).EventSource = FakeEventSource

Element.prototype.scrollIntoView ??= () => {}
if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true })
