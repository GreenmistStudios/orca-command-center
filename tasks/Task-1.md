# Task-1 — Scaffold, tooling, shared server libs

**Wave:** A (runs alone, first) · **Size:** M · **Depends on:** — · **Blocks:** every other task

## Goal

Turn `~/Development/orca-command-center` into a working TypeScript project (server + client +
tests) where `npm run typecheck`, `npm test` and `npm run build` all pass on an essentially empty
app. Install every dependency the whole project will need (later tasks may not add any). Implement
the small shared server libraries that every source adapter depends on, and a stub store so the
server core (Task-2) can run before the real store (Task-8) exists.

## Read first

- `Plan.md` §8 (architecture, ownership table), §11 (NFRs), §12 (testing)
- `docs/data-sources.md` §0 (safety rules) and §1.3 (tool classification), §2 (Copilot tool names)
- `src/shared/contract.ts` and `src/server/types.ts` — **do not modify these two files**; your
  setup must make them compile.

## Ownership (create/modify only these)

- `package.json`, `package-lock.json`, `.gitignore`, `.npmrc` (only if needed), `README.md` (skeleton)
- `tsconfig.json`, `tsconfig.base.json`, `tsconfig.server.json`, `tsconfig.client.json`, `tsconfig.test.json`
- `vite.config.ts`, `vitest.config.ts`
- `src/server/lib/**` (+ co-located tests)
- `src/server/store/index.ts` (stub only)
- Minimal client entry so the build works: `src/client/index.html`, `src/client/main.tsx`,
  `src/client/styles/theme.css` (Task-7 will replace these)
- `test/client/setup.ts` (jest-dom registration) — Task-7 may extend it

## Requirements

### 1. package.json

- `"name": "orca-command-center"`, `"version": "0.1.0"`, `"private": true`, `"type": "module"`,
  `"engines": { "node": ">=22.13" }`, `"bin": { "occ": "bin/occ.mjs" }`, `"files": ["bin", "dist"]`.
- **The server must have zero runtime dependencies** (Node built-ins only: `node:sqlite`,
  `node:http`, `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`,
  `node:util`, `node:url`, `node:events`, `node:timers`). Put every package in `devDependencies`
  (the client is bundled by Vite).
- Install (latest within these ranges; verify each resolves):
  - Tooling: `typescript@~5.9`, `@types/node@^22`, `tsx@^4`, `vite@^8`, `@vitejs/plugin-react@^6`,
    `vitest@^5`, `jsdom@^30`, `concurrently@^10`, `playwright@^1.64` (for Task-17; do NOT run
    `playwright install`)
  - Client: `react@^19`, `react-dom@^19`, `@types/react@^19`, `@types/react-dom@^19`,
    `tailwindcss@^4`, `@tailwindcss/vite@^4`, `@xyflow/react@^12`, `elkjs@^0.12`, `zustand@^5`,
    `@tanstack/react-virtual@^3`, `cmdk@^1`, `lucide-react@latest`, `motion@latest`,
    `radix-ui@^1.8`, `clsx@^2`, `tailwind-merge@^3`, `class-variance-authority@^0.7`
  - Testing: `@testing-library/react@^16`, `@testing-library/jest-dom@latest`,
    `@testing-library/user-event@^14`
  - If any package fails to resolve or is incompatible, pick the closest working version and
    report it.
- Scripts:
  ```json
  "dev": "concurrently -k -n server,client -c blue,magenta \"npm:dev:server\" \"npm:dev:client\"",
  "dev:server": "tsx watch src/server/main.ts --dev --no-open",
  "dev:client": "vite",
  "build": "npm run build:client && npm run build:server",
  "build:client": "vite build",
  "build:server": "tsc -p tsconfig.server.json",
  "start": "node bin/occ.mjs",
  "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.client.json && tsc -p tsconfig.test.json",
  "test": "vitest run",
  "test:watch": "vitest"
  ```
  (`src/server/main.ts` and `bin/occ.mjs` are created by Task-2; `dev:server`/`start` may fail
  until then — that is expected.)

### 2. TypeScript configs

- `tsconfig.base.json`: `strict: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`,
  `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`, `resolveJsonModule: true`,
  `noFallthroughCasesInSwitch: true`, `noImplicitOverride: true`, `useUnknownInCatchVariables: true`.
- `tsconfig.server.json`: extends base; `module`/`moduleResolution` `NodeNext`; `target`/`lib`
  `ES2023`; `types: ["node"]`; `rootDir: "src"`; `outDir: "dist"`; include
  `src/server/**/*.ts`, `src/shared/**/*.ts`; exclude `**/*.test.ts`. Relative imports in server
  and shared code use `.js` extensions.
- `tsconfig.client.json`: extends base; `module: ESNext`, `moduleResolution: Bundler`,
  `jsx: react-jsx`, `lib: ["ES2023","DOM","DOM.Iterable"]`, `types: ["vite/client"]`,
  `noEmit: true`; include `src/client/**/*`, `src/shared/**/*`; exclude `**/*.test.tsx`, `**/*.test.ts`.
- `tsconfig.test.json`: extends base; `module: ESNext`, `moduleResolution: Bundler`,
  `jsx: react-jsx`, DOM libs, `types: ["node", "vite/client"]`, `noEmit: true`; include
  `src/**/*.test.ts`, `src/**/*.test.tsx`, `test/**/*.ts`, `test/**/*.tsx`.
- `tsconfig.json` (editor convenience): `{ "files": [], "references": [...] }` or a noEmit config
  including everything — your choice, but it must not break the three explicit configs.

### 3. Vite & Vitest

- `vite.config.ts`: `root: 'src/client'`, plugins `react()` + `tailwindcss()`,
  `build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: true }`,
  `server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:4270', changeOrigin: false } } }`.
  No path aliases (use relative imports everywhere).
- `vitest.config.ts`: two projects (Vitest 5 `test.projects`; adapt to the installed API):
  - `server`: environment `node`, include `src/server/**/*.test.ts`, `src/shared/**/*.test.ts`,
    `test/integration/**/*.test.ts`, `test/fixtures/**/*.test.ts`.
  - `client`: environment `jsdom`, include `src/client/**/*.test.{ts,tsx}`,
    `test/client/**/*.test.{ts,tsx}`, `setupFiles: ['test/client/setup.ts']`, plugins `react()`.
  - `test.passWithNoTests: true`. Tests import from `vitest` explicitly (no globals).

### 4. Minimal client entry (placeholder; Task-7 replaces)

`src/client/index.html` (root `<div id="root">`, `<meta name="color-scheme" content="light dark">`,
script `./main.tsx`), `main.tsx` rendering `<h1>Orca Command Center</h1>`, `styles/theme.css` with
`@import "tailwindcss";`.

### 5. `src/server/lib/**` (Node built-ins only; each file with a co-located `*.test.ts`)

1. **`sqlite.ts`**
   ```ts
   export class DeniedTableError extends Error {}
   export const OPENCODE_DENIED_TABLES: readonly string[] // ['account','account_state','control_account','credential','permission']
   export interface ReadOnlyDb {
     readonly path: string
     all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[]
     get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined
     dataVersion(): number          // PRAGMA data_version
     userVersion(): number          // PRAGMA user_version
     tables(): Set<string>          // from sqlite_master (type='table')
     columns(table: string): Set<string>   // PRAGMA table_info; empty set if table missing
     explain(sql: string, ...params: SQLInputValue[]): string[]  // EXPLAIN QUERY PLAN detail lines
     close(): void
   }
   export function openReadOnly(path: string, options?: { deniedTables?: readonly string[]; busyTimeoutMs?: number }): ReadOnlyDb
   ```
   - Opens with `new DatabaseSync(path, { readOnly: true })`, then `PRAGMA busy_timeout = <ms>`
     (default 3000). Never writes.
   - **Denylist guard:** before preparing any SQL, strip string literals (`'...'`), then if any
     denied table name appears as a whole identifier (case-insensitive; bare, `"quoted"`,
     `` `quoted` `` or `[bracketed]`), throw `DeniedTableError`. Also reject statements that
     are not `SELECT`/`WITH`/`PRAGMA` (read-only belt and braces), and reject `PRAGMA`s other
     than `data_version`, `user_version`, `table_info`, `busy_timeout`, `query_only`.
   - Prepared statements cached per SQL string; statements are executed to completion
     (`all`/`get`) — never iterate lazily across ticks.
   - Tests: build a temp DB (writable connection in the test only) with an `account` table and a
     `session` table; assert reading `session` works, any query mentioning `account` throws
     (including `"account"`, `ACCOUNT`, joins, subqueries), a string literal `'account'` does
     not throw, `INSERT`/`UPDATE`/`DELETE`/`ATTACH` throw, `dataVersion()` increments after a
     write from another connection, `explain()` returns detail strings.
2. **`redact.ts`**
   ```ts
   export function redactText(text: string): string
   export function redactValue(value: unknown, depth?: number): unknown  // deep copy, redacted
   export const REDACTED = '[redacted]'
   export const DATA_URL_PLACEHOLDER = '[data-url omitted]'
   ```
   Patterns (replace the secret part with `[redacted]`, keep a short recognizable prefix such as
   `ghp_…`): GitHub tokens (`gh[pousr]_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`),
   OpenAI/Anthropic-style keys (`sk-[A-Za-z0-9-_]{20,}`, `sk-ant-[A-Za-z0-9-_]{20,}`), AWS access
   keys (`AKIA[0-9A-Z]{16}`, `ASIA[0-9A-Z]{16}`), Slack (`xox[abprs]-[A-Za-z0-9-]{10,}`), Google
   API keys (`AIza[0-9A-Za-z-_]{35}`), JWTs (`eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+`), `Bearer <token>`,
   `Authorization: <value>`, PEM private key blocks, URL credentials (`https://user:pass@host`),
   and assignments `(api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\s*[:=]\s*["']?<value>`.
   `redactValue` additionally replaces values of keys matching
   `/(secret|token|password|passwd|authorization|api[_-]?key|cookie|private[_-]?key|signature)/i`
   with `[redacted]`, replaces any string starting with `data:` (and length > 64) with
   `DATA_URL_PLACEHOLDER`, and stops at depth 8 (deeper → `'[depth limit]'`).
   Tests for every pattern + negative cases (ordinary words like "tokenizer", short strings).
3. **`text.ts`** — `truncate(text, max) → { text, truncated }` (cuts on code points, appends `…`),
   `clip(text, max) → string`, `stripAnsi(text)` (CSI/OSC sequences, incl. truecolor),
   `oneLine(text)` (collapse whitespace), `compactJson(value, max)` (stable, one-line JSON
   preview), `extractLinks(text, max) → string[]` (http/https, trimmed of trailing punctuation,
   deduped, ≤ max), `basename(path)`, `normalizePath(path)` (resolve `~`, strip trailing `/`).
4. **`time.ts`** — `parseTime(value: unknown): number | null`: numbers ≥ 1e12 = ms, numbers
   < 1e12 and > 1e9 = seconds → ms; ISO strings; SQL `YYYY-MM-DD HH:MM:SS(.fff)` = UTC (append
   `Z`); anything else → null.
5. **`log.ts`** — `createLogger({ verbose, prefix? }): Logger` (types.ts `Logger`); writes to
   stderr as `HH:MM:SS level message`; `debug` only when verbose.
6. **`paths.ts`** — pure functions with injectable `env`, `platform`, `homedir`:
   `defaultOrcaDirs()` → candidates (macOS `~/Library/Application Support/orca` and `orca-dev`;
   Linux `${XDG_CONFIG_HOME:-~/.config}/orca`; Windows `%APPDATA%\orca`), `defaultOpencodeDb()`
   (`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`), `defaultCopilotDir()` (`~/.copilot`),
   `resolveOrcaCli()` → `$ORCA_CLI_COMMAND` if set; else first `orca` found on `PATH`; else
   `/Applications/Orca.app/Contents/Resources/bin/orca` on macOS if it exists; else null.
7. **`tool-classify.ts`** — exactly data-sources §1.3 and §2:
   ```ts
   export interface ToolClassification { category: ToolCategory; mcpServer: string | null; displayName: string }
   export interface ToolClassifier { classify(harness: Harness, name: string): ToolClassification; observe(name: string): void }
   export function createToolClassifier(options?: { knownServers?: string[] }): ToolClassifier
   ```
   `observe` records names so "prefix shared by ≥ 2 distinct names" works over time;
   `classify` is pure given the observed set. Include the OpenCode built-in table, the Copilot
   built-in table (`bash/read_bash/stop_bash/write_bash` shell, `view` read, `rg/glob/grep`
   search, `create` write, `edit/str_replace/str_replace_editor` edit, `apply_patch` patch,
   `web_fetch/web_search` web, `task` subagent), the default known MCP servers, and the verb
   stoplist. Copilot names: treat `-` like `_` when splitting the prefix. Tests: `bash`→shell,
   `atlassian_jira_get_issue`→mcp/atlassian/`jira_get_issue`, `bitrise_get_build_log` + one more
   `bitrise_*` observed → mcp/bitrise, `get_goal` + `get_goal_history` → plugin, `acme_toggle_builtins`
   → plugin, `github_request_copilot_review` → mcp/github (known server), unknown single name → plugin.
8. **`fs-watch.ts`** — `watchPath(path, onChange, { debounceMs = 100, pollMs = 2000 }) → { close() }`:
   `fs.watch` on the parent **directory** (recursive: false), filter events to the file's
   basename, debounce; plus a `setInterval` stat poll comparing `mtimeMs`/`size` as fallback
   (unref'd timers). Missing directory → keep polling until it appears. Watch errors → log once
   (via optional logger) and continue with polling. Also `watchDirectory(dir, onChange, opts)`
   for a whole directory (used by Copilot).

### 6. `src/server/store/index.ts` (stub)

Export `createStore: CreateStore` (from `src/server/types.ts`) returning an object that satisfies
`Store`: `start/stop` no-ops; `meta()` returns a valid `ServerMeta` (version from deps,
`bootId` from `hub.bootId`, `sources: []`, `orca` = not running); `bootstrap()` returns an empty
but valid `BootstrapPayload` (`seq: hub.seq`, empty arrays, `orchestration.available: false`,
`testedSchemaVersion: 43`, stats with zeros and 60 zero histogram buckets); list methods return
`[]`; lookups return `null`; `activity()` returns `{ events: [], before: null, hasMore: false }`.
Add a header comment: "Stub — replaced by Task-8."

### 7. Other files

- `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `.DS_Store`, `*.log`, `test-results/`,
  `playwright-report/`, `.vite/`.
- `README.md` skeleton: one-paragraph description, "Status: under construction — see Plan.md",
  dev commands.
- Run `git init` **only if** the directory is not already a git repository (the coordinator may
  have initialized it). Do not commit.

## Acceptance

- `npm install` succeeds; `npm ls --depth=0` shows the dependencies above.
- `npm run typecheck` passes (server, client, tests configs).
- `npm test` passes with all lib tests (aim for thorough cases; they protect the safety rules).
- `npm run build:client` produces `dist/client/index.html`; `npm run build:server` compiles
  `src/server/lib/**`, `src/server/store/index.ts`, `src/server/types.ts`, `src/shared/contract.ts`
  into `dist/` without errors.

## Verify

```bash
cd ~/Development/orca-command-center
npm install && npm run typecheck && npm test && npm run build:client && npm run build:server
```

## Report

Summary; exact installed versions (`npm ls --depth=0`); files created; commands run with
results; any deviation (e.g. a version that had to change, a Vitest API difference).
