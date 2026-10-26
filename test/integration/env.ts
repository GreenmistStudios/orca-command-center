import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { Config, Logger } from '../../src/server/types.js'
import type { BootstrapPayload, StreamEvent } from '../../src/shared/contract.js'
import { createHub, type Hub } from '../../src/server/hub/hub.js'
import { createHttpServer, type HttpServer } from '../../src/server/http/server.js'
import { createStore } from '../../src/server/store/index.js'
import type { Store } from '../../src/server/types.js'
import { benchConfig } from '../../src/server/sources/opencode/bench-config.js'
import { createOpenCodeFixture, seedRealisticFleet, type OpenCodeFixture } from '../fixtures/opencode.js'
import { seedCopilotFleet, type CopilotFleet } from '../fixtures/copilot.js'
import { createOrchestrationFixture, type OrchestrationVariant } from '../fixtures/orchestration.js'
import { STATUS_JSON, TERMINAL_LIST_JSON, WORKTREE_PS_JSON, hookEntry, writeHooksFile, type RawHookEntry } from '../fixtures/orca.js'

export const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} }

export interface EnvOptions {
  opencode?: boolean
  /** 'missing' → configured path that does not exist. */
  opencodeMissing?: boolean
  copilot?: boolean
  orchestration?: OrchestrationVariant | null
  orca?: 'ok' | 'failing' | null
  hooks?: RawHookEntry[] | null
  terminalListJson?: string
  now?: number
  overrides?: Partial<Config>
}

export interface Env {
  dir: string
  now: number
  config: Config
  opencode: OpenCodeFixture | null
  copilot: CopilotFleet | null
  orchPath: string | null
  hooksPath: string | null
  orcaDir: string
  store: Store
  hub: Hub
  http: HttpServer
  base: string
  get<T = unknown>(route: string): Promise<T>
  getText(route: string): Promise<string>
  bootstrap(): Promise<BootstrapPayload>
  openStream(): StreamClient
  close(): Promise<void>
}

export interface StreamClient {
  events: StreamEvent[]
  waitFor(pred: (e: StreamEvent) => boolean, timeoutMs?: number): Promise<StreamEvent>
  close(): void
}

function fakeOrcaScript(dir: string, mode: 'ok' | 'failing', terminalJson: string): string {
  writeFileSync(path.join(dir, 'status.json'), STATUS_JSON)
  writeFileSync(path.join(dir, 'worktree.json'), WORKTREE_PS_JSON)
  writeFileSync(path.join(dir, 'terminal.json'), terminalJson)
  const script = path.join(dir, 'orca-fake')
  writeFileSync(
    script,
    mode === 'failing'
      ? '#!/bin/sh\necho "Orca runtime is not reachable" >&2\nexit 1\n'
      : '#!/bin/sh\nd="$(dirname "$0")"\ncase "$1 $2" in\n  "status --json") cat "$d/status.json";;\n  "worktree ps") cat "$d/worktree.json";;\n  "terminal list") cat "$d/terminal.json";;\n  *) echo "unknown" >&2; exit 2;;\nesac\n',
  )
  chmodSync(script, 0o755)
  return script
}

export async function createEnv(opts: EnvOptions = {}): Promise<Env> {
  const dir = mkdtempSync(path.join(tmpdir(), 'occ-int-'))
  const now = opts.now ?? Date.now()
  const orcaDir = path.join(dir, 'orca')
  mkdirSync(orcaDir)
  let opencode: OpenCodeFixture | null = null
  let opencodePath: string | null = null
  if (opts.opencode !== false) {
    if (opts.opencodeMissing) opencodePath = path.join(dir, 'nope', 'opencode.db')
    else {
      mkdirSync(path.join(dir, 'oc'))
      opencode = createOpenCodeFixture(path.join(dir, 'oc'), 'opencode.db')
      seedRealisticFleet(opencode, now)
      opencodePath = opencode.path
    }
  }
  const copilot = opts.copilot === false ? null : seedCopilotFleet(path.join(dir, 'copilot'), { now })
  let orchPath: string | null = null
  if (opts.orchestration !== null) orchPath = createOrchestrationFixture(orcaDir, opts.orchestration ?? 'rich')
  let hooksPath: string | null = null
  if (opts.hooks) {
    hooksPath = path.join(orcaDir, 'last-status.json')
    writeHooksFile(hooksPath, opts.hooks)
  } else if (opts.hooks === undefined) {
    hooksPath = path.join(orcaDir, 'last-status.json')
    writeHooksFile(hooksPath, [])
  }
  const cli = opts.orca === null ? null : fakeOrcaScript(orcaDir, opts.orca ?? 'ok', opts.terminalListJson ?? TERMINAL_LIST_JSON)

  const config: Config = {
    ...benchConfig(opencodePath, { pollMs: 100, orcaPollMs: 300 }),
    port: 0,
    orcaDir,
    orchestrationDb: orchPath,
    hooksFile: hooksPath,
    copilotDir: copilot ? copilot.fixture.root : null,
    orcaCli: cli,
    allowedHosts: [],
    ...opts.overrides,
  }
  let store!: Store
  const hub = createHub({ meta: () => store.meta(), flushMs: 40 })
  store = createStore({ config, log: quietLog, now: Date.now, hub, version: 'test' })
  const server = createHttpServer({ config, store, hub, log: quietLog, ssePingMs: 5000 })
  await store.start()
  const l = await server.listen()
  config.allowedHosts.push(`127.0.0.1:${l.port}`)
  const base = `http://127.0.0.1:${l.port}`
  const streams: StreamClient[] = []

  const env: Env = {
    dir,
    now,
    config,
    opencode,
    copilot,
    orchPath,
    hooksPath,
    orcaDir,
    store,
    hub,
    http: server,
    base,
    async get<T>(route: string) {
      const r = await fetch(base + route)
      return (await r.json()) as T
    },
    async getText(route: string) {
      return (await fetch(base + route)).text()
    },
    bootstrap: () => env.get<BootstrapPayload>('/api/bootstrap'),
    openStream() {
      const events: StreamEvent[] = []
      const waiters: Array<{ pred: (e: StreamEvent) => boolean; resolve: (e: StreamEvent) => void }> = []
      let buf = ''
      const req = http.get(`${base}/api/stream`, (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const line = frame.split('\n').find((x) => x.startsWith('data: '))
            if (!line) continue
            const ev = JSON.parse(line.slice(6)) as StreamEvent
            events.push(ev)
            for (const w of [...waiters]) {
              if (w.pred(ev)) {
                waiters.splice(waiters.indexOf(w), 1)
                w.resolve(ev)
              }
            }
          }
        })
      })
      req.on('error', () => {})
      const client: StreamClient = {
        events,
        waitFor(pred, timeoutMs = 8000) {
          const hit = events.find(pred)
          if (hit) return Promise.resolve(hit)
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`timeout waiting for stream event; got ${events.map((e) => e.type).join(',')}`)), timeoutMs)
            waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) })
          })
        },
        close: () => req.destroy(),
      }
      streams.push(client)
      return client
    },
    async close() {
      for (const s of streams) s.close()
      hub.close()
      await server.close().catch(() => {})
      await store.stop().catch(() => {})
      opencode?.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return env
}

export { hookEntry, writeHooksFile }
