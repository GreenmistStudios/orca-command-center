# Task-2 — Server core: CLI, config, HTTP, SSE hub, security

**Wave:** B (parallel with 3, 4, 5, 6, 7) · **Size:** L · **Depends on:** Task-1

## Goal

The `occ` server process: parse flags, discover data sources, serve the SPA and the JSON API,
fan out live updates over Server-Sent Events, and enforce the loopback/DNS-rebinding safety
model. It runs end-to-end against the **stub store** from Task-1 (Task-8 swaps in the real store
behind the same `createStore` signature — do not depend on anything else from the store).

## Read first

- `Plan.md` §5, §8.1–8.3, §10 (API & streaming — the route table is normative), §11
- `src/shared/contract.ts` (`StreamEvent`, `StreamPayload`, `ApiResponses`, `ApiError`, `ServerMeta`)
- `src/server/types.ts` (`Config`, `HubPublisher`, `StoreReader`, `Store`, `CreateStore`, `Logger`)
- `src/server/lib/*` (Task-1: `paths.ts`, `log.ts`, `text.ts`)

## Ownership

`bin/occ.mjs`, `src/server/main.ts`, `src/server/cli.ts`, `src/server/config.ts`,
`src/server/version.ts`, `src/server/http/**`, `src/server/hub/**` (+ co-located tests).
Do **not** modify `src/server/store/**`, `src/server/lib/**`, sources, contract files.

## Requirements

### 1. `bin/occ.mjs` (plain JS)

Checks `process.versions.node` ≥ 22.13 (clear message + exit 1 otherwise); suppresses only the
`node:sqlite` `ExperimentalWarning` (other warnings still print); imports
`../dist/server/main.js`; if that file is missing prints "occ is not built — run `npm run build`"
and exits 1.

### 2. `cli.ts` — `parseCli(argv): CliOptions | { help: true } | { version: true }`

Use `util.parseArgs` (strict). Flags (defaults in brackets):

| Flag | |
|---|---|
| `--port <n>` [4270] | 1–65535; port in use → hard error (no port hunting) |
| `--host <h>` [127.0.0.1] | non-loopback prints a warning: no authentication, everything readable |
| `--window-hours <n>` [24] | 1–720 |
| `--poll-ms <n>` [750] | 100–60000 |
| `--orca-poll-ms <n>` [5000] | 1000–600000 |
| `--opencode-db <path>` | explicit path: if unreadable → **hard error** (never silently fall back) |
| `--orca-dir <path>` | same rule |
| `--copilot-dir <path>` | same rule |
| `--orca-cli <path>` | explicit executable |
| `--no-opencode`, `--no-copilot`, `--no-orca-cli`, `--no-orchestration`, `--no-hooks` | disable a source |
| `--mcp-servers <a,b>` | extra known MCP server names |
| `--ring-size <n>` [20000] | 1000–200000 |
| `--no-open`, `--dev`, `--verbose`, `--version`, `--help` | |

Invalid values → `CliError` with a one-line message naming the flag. `--help` prints a concise
usage block listing flags and the data sources it reads.

### 3. `config.ts` — `resolveConfig(cli, env, deps): { config: Config; notes: string[] }`

- Discovery via `src/server/lib/paths.ts`. Orca dir: first candidate containing
  `orchestration.db` or `agent-hooks/`; when several exist prefer the one whose
  `orchestration.db`/`-wal` mtime is newest. `orchestrationDb` = `<orcaDir>/orchestration.db` if
  it exists; `hooksFile` = `<orcaDir>/agent-hooks/last-status.json` (keep the path even if the
  file is absent — the hooks source waits for it).
- Disabled/missing sources → the corresponding `Config` field is `null`, and a human note is
  recorded (e.g. "Copilot CLI not found at ~/.copilot").
- `orcaCli`: `--orca-cli` > `resolveOrcaCli()` > null; `--no-orca-cli` forces null.
- `allowedHosts`: `${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`;
  with `--dev` also `localhost:5173`, `127.0.0.1:5173`.
- `staticDir`: `<package root>/dist/client` (resolve from `import.meta.url`; works from both
  `src/server` via tsx and `dist/server`), null in dev mode.
- `thresholds`: `{ liveMs: 600_000, idleMs: 1_800_000, stalledMs: 600_000, workingMs: 120_000 }`.
- Deps are injectable (`env`, `platform`, `homedir`, `exists`, `stat`) for tests.

### 4. `version.ts`

`export const VERSION: string` read from `package.json` (two levels up from this module in both
src and dist layouts).

### 5. `hub/hub.ts` — `createHub(options) → Hub`

```ts
export interface HubClient { write(frame: string): boolean; end(): void; readonly writableLength: number }
export interface Hub extends HubPublisher {
  /** Registers a client. Sends hello, then replays frames after `since` or sends resync. */
  subscribe(since: number | null, client: HubClient): () => void
  clientCount(): number
  close(): void
}
export function createHub(options: { meta: () => ServerMeta; now?: Clock; flushMs?: number; replaySize?: number; maxBufferedBytes?: number; log?: Logger }): Hub
```

- `bootId`: random (`crypto.randomUUID()`), fixed for the process.
- `publish(payload)` queues; a flush every `flushMs` (250) coalesces the queue:
  `activity` merged by `event.id` keeping the highest `rev` (ties: later publish wins);
  `sessions` merged by `session.id`, `removed` unioned (a later upsert cancels a removal);
  `orca` shallow-merged (later keys win); `attention`, `orchestration` (union `changedRunIds`),
  `stats`, `meta`: last wins. Each resulting payload gets the next `seq` and is written to all
  clients as one frame, then stored in the replay ring (last `replaySize` = 2000 frames).
- Frame format: `id: <seq>\ndata: <JSON StreamEvent>\n\n` (no `event:` line). `hello` and
  `resync` frames carry `id: <current seq>` and are not stored in the ring.
- `subscribe(since)`: always send `hello` (`{type:'hello', seq, bootId, meta: meta()}`). Then:
  `since === null` → nothing; `since === seq` → nothing; `oldest-1 ≤ since < seq` → replay
  frames with seq > since; otherwise (too old, or greater than current seq e.g. after a server
  restart) → `resync` (`reason: 'cursor-too-old' | 'cursor-ahead'`).
- Backpressure: if a client's `writableLength` exceeds `maxBufferedBytes` (4 MB) after a write,
  end it (the browser reconnects and resumes or resyncs).
- `seq` getter returns the last assigned seq. `close()` stops timers and ends clients.
- Tests (fake clock/timers ok): coalescing for each payload type, seq monotonic, replay
  window, resync both directions, backpressure drop, hello first.

### 6. `http/**`

- **`server.ts`** — `createHttpServer({ config, store, hub, log }) → { listen(): Promise<{ url }>; close(): Promise<void> }`
  using `node:http`. For every request:
  - Host check: `req.headers.host` must be in `config.allowedHosts` → else 403 JSON
    `ApiError{code:'bad_request', error:'Host not allowed'}`.
  - Only `GET`/`HEAD` → else 405.
  - Headers on all responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY`. **No CORS headers.**
  - `/api/stream` → SSE; `/api/*` → routes; everything else → static.
- **`routes.ts`** — route table implementing Plan §10.2 exactly (paths, allowed query keys,
  limits). Parse ints strictly; `kinds` csv validated against `ACTIVITY_KINDS`; `harness`
  validated against `Harness`; `state` against `AgentState`; `windowHours` → ms. Unknown query
  key → 400 `bad_request` naming the key. `null` from the store → 404 `not_found`. Thrown errors
  → 500 `internal` (log the stack, never send it). JSON with `Cache-Control: no-store`.
  Export the table so tests can assert every `ApiResponses` key is routed.
- **`static.ts`** — serve `config.staticDir`: correct `Content-Type` for html/js/css/svg/png/
  ico/json/map/woff2; `assets/*` → `Cache-Control: public, max-age=31536000, immutable`;
  `index.html` → `no-store`; SPA fallback to `index.html` for extension-less paths; path
  traversal guard (resolved path must stay inside staticDir → 403); CSP on html:
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  If `staticDir` is null or missing, `/` returns a small HTML page saying the client is not built
  (or, in dev, "open http://localhost:5173").
- **`sse.ts`** — headers `Content-Type: text/event-stream; charset=utf-8`,
  `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`; flush headers
  immediately; `since` from `Last-Event-ID` header (preferred) or `?since=`; subscribe to the
  hub; `: ping\n\n` every 15 s; unsubscribe on `close`.

### 7. `main.ts`

1. Parse CLI (print help/version and exit; `CliError` → message + exit 2).
2. Resolve config; logger (`verbose`).
3. `const hub = createHub({ meta: () => store.meta() })`; `const store = createStore({ config, log, now: Date.now, hub, version: VERSION })` (import from `./store/index.js`).
4. `await store.start()`; listen (port in use → clear error + exit 1).
5. Print a banner to stderr: URL, read-only notice, each source path or "not found/disabled"
   (from config + notes).
6. Open the browser (`open` / `xdg-open` / `start`) unless `--no-open`, `--dev`, not a TTY,
   `CI` set, or over SSH (`SSH_CONNECTION`).
7. Graceful shutdown on SIGINT/SIGTERM: stop accepting, `hub.close()`, `store.stop()`, exit 0.
   A second signal exits immediately.

## Acceptance

- `npm run build && node bin/occ.mjs --no-open --port 4271` starts, prints the banner, serves
  `/` (built placeholder client) and `/api/bootstrap` (stub store, valid JSON).
- `curl -N http://127.0.0.1:4271/api/stream` shows a `hello` frame and `: ping` every 15 s.
- `curl -H 'Host: evil.com:4271' http://127.0.0.1:4271/api/meta` → 403.
- Unit tests: cli (valid/invalid/help), config (temp dirs, explicit-path hard errors,
  allowedHosts in dev), hub (above), routes with a fake `StoreReader` (every route 200, unknown
  param 400, unknown id 404, store throw 500, POST 405, Host 403), static (content types,
  traversal 403, SPA fallback), SSE integration (listen on port 0, read frames with `fetch` +
  stream reader, assert hello → published frame → replay with `Last-Event-ID` → resync with
  stale id).
- `npm run typecheck` clean for owned files; `npx vitest run src/server/http src/server/hub src/server/cli.test.ts src/server/config.test.ts` green.

## Out of scope

Real data (stub store only), any UI, source adapters.

## Report

Summary, files, commands + results, the exact banner output from a run, deviations.
