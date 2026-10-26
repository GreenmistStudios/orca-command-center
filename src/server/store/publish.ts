import type { StreamPayload } from '../../shared/contract.js'
import type { HubPublisher, Logger } from '../types.js'

/** Guarded publisher: never throws into a source callback; silent until `ready`. */
export class Publisher {
  ready = false
  constructor(
    private readonly hub: HubPublisher,
    private readonly log: Logger,
  ) {}

  publish(payload: StreamPayload): void {
    if (!this.ready) return
    try {
      this.hub.publish(payload)
    } catch (e) {
      this.log.warn('store: publish failed: %s', e instanceof Error ? e.message : String(e))
    }
  }
}

/** JSON "digest" helper: returns true (and remembers) when the value differs from the last one. */
export class ChangeGate {
  private last: string | null = null
  changed(value: unknown, ignoreKeys: string[] = []): boolean {
    const json = JSON.stringify(value, (k, v) => (ignoreKeys.includes(k) ? undefined : v))
    if (json === this.last) return false
    this.last = json
    return true
  }
  reset(): void {
    this.last = null
  }
}
