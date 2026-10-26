# Task-4 — Orca live sources: CLI poller + hooks watcher

**Wave:** B (parallel with 2, 3, 5, 6, 7) · **Size:** M · **Depends on:** Task-1

## Goal

Two sources that tell the command center what Orca itself knows *right now*:

1. **OrcaCliSource** — polls the read-only commands `orca status`, `orca worktree ps`,
   `orca terminal list` → Orca liveness, worktrees, terminals.
2. **OrcaHooksSource** — watches `agent-hooks/last-status.json` → per-pane agent state
   (working/blocked/waiting/done), the session id each pane is running, and state transitions
   as activity events.

## Read first

- `docs/data-sources.md` §0 (safety), §3 (hooks), §4 (CLI), §6 (join model)
- `src/server/types.ts` (`OrcaCliSource`, `OrcaHooksSource`, `OrcaCliUpdate`, `OrcaHooksUpdate`, `CliRunner`, `SourceDeps`)
- `src/shared/contract.ts` (`OrcaStatus`, `WorktreeInfo`, `TerminalInfo`, `HookEntry`, `ActivityEvent`)
- `src/server/lib/{fs-watch,text,redact,time}.ts`

## Ownership

`src/server/sources/orca/**` (+ co-located tests), `test/fixtures/orca.ts`.

## Public API

```ts
export function createOrcaCliSource(deps: SourceDeps & { runner?: CliRunner }): OrcaCliSource   // id 'orca-cli'
export function createOrcaHooksSource(deps: SourceDeps): OrcaHooksSource                        // id 'orca-hooks'
export const defaultCliRunner: CliRunner   // child_process.execFile, no shell
```

## Requirements

### A. CLI runner & allowlist (`runner.ts`)

- `defaultCliRunner` uses `execFile` (never a shell), `timeout`, `maxBuffer`, `windowsHide`,
  env inherited, and resolves `{ stdout, stderr, exitCode }` (never rejects on non-zero).
- `createOrcaCliSource` only ever invokes exactly these argument vectors (enforce with a
  frozen allowlist; anything else throws in code):
  `['status','--json']`, `['worktree','ps','--json']`, `['terminal','list','--json']`.
  Timeout 3000 ms, maxBuffer 16 MB.

### B. Parsing (`parse.ts`, pure functions)

- Envelope `{ ok, result, error? }`; `ok:false` → error with `error.message`.
- `parseStatus(json, now) → OrcaStatus` from `result.app.running/pid` and
  `result.runtime.state/reachable/appVersion`. Ignore `capabilities`.
- `parseWorktrees(json) → WorktreeInfo[]`: fields per data-sources §4; `branch` strip
  `refs/heads/`; `links` from `linkedPR`/`linkedIssue`/`linkedGitLabMR`/`linkedGitLabIssue`/
  `linkedLinearIssue`/`linkedItems` — accept objects with `url`/`number`/`title`/`identifier`
  or plain numbers/strings, produce `{kind, label, url}`; tolerate unknown shapes (skip).
- `parseTerminals(json) → TerminalInfo[]`: `paneKey = tabId && leafId ? `${tabId}:${leafId}` : null`;
  `preview` → `stripAnsi` → `redactText` → ≤ 300 chars; `sessionId: null` (store resolves);
  `lastOutputAt` ms.
- All parsers tolerate missing/extra fields and never throw on shape drift (return what they
  can, record a warning count).

### C. OrcaCliSource behavior

- `config.orcaCli === null` → health `disabled` ("Orca CLI not found"), status
  `{running:false, reachable:false, …, error:'orca CLI not found'}`, no polling.
- Poll loop: run `status` first; if `running && reachable`, run `worktree ps` and
  `terminal list` in parallel; schedule the next poll `config.orcaPollMs` after the previous
  **finished** (no overlap). First poll immediately on `start()`.
- Emit `{type:'status'}` when the status changes (compare running/pid/version/runtimeState/
  reachable/error), `{type:'fleet'}` when worktrees or terminals change (stable JSON compare,
  ignoring `checkedAt`). Keep the last good fleet snapshot when a poll fails; health `error`
  with the message (e.g. timeout) and `detail` "showing data from <time>".
- Orca not running → status `running:false`; worktrees/terminals cleared only after 3
  consecutive non-running polls (avoid flicker during restarts).
- `health()`: `{ id:'orca-cli', label:'Orca CLI', status, path: config.orcaCli, version: <app version>, detail: '<n> worktrees · <n> terminals', lastReadAt, lastChangeAt }`.

### D. OrcaHooksSource behavior

- `config.hooksFile === null` → health `disabled`. Otherwise `watchPath(hooksFile, …)` from
  lib (directory watch + 2 s stat fallback, 100 ms debounce). **Never read any other file in
  that directory** (in particular `endpoint.env`).
- Parse `{version, entries}`: unknown `version` → still parse entries best-effort, health
  `degraded` ("hook file version N, expected 2"). Malformed JSON (partial write) → keep the
  previous entries, retry on the next change, don't log more than once per minute.
- `HookEntry` mapping: `paneKey`, `tabId`, `worktreeId`, `agent = agentPresence.agent ?? source`,
  `hookEvent = hookEventName`, `state = payload.state`, `prompt` (≤ 280, redacted),
  `lastAssistantMessage` (≤ 280, redacted), `providerSessionId = providerSession.id`,
  `receivedAt`, `stateStartedAt`. Ignore `launchTokenHash`, `hostTurn`, `authorityCommitments`.
- Transitions: diff against the previous read; for each paneKey whose
  `(hookEvent, state, receivedAt)` changed (or is new after the first read), emit an
  ActivityEvent:
  - `id: 'orca-hook:' + paneKey + ':' + receivedAt`, `rev: receivedAt`, `harness` from the
    agent (`opencode`, `copilot`, `claude`, `codex`, else `unknown`), `sessionId =
    providerSessionId`, `rootId = providerSessionId` (store may correct), `ts = receivedAt`,
    `kind: 'permission'` for `PermissionRequest`, else `'state'`; `status: null`;
    `title` by event/state: `SessionBusy|working` → "Started working", `SessionIdle|done` →
    "Finished turn", `PermissionRequest|blocked` → "Permission requested",
    `AskUserQuestion|waiting` → "Asked a question", `UserPromptSubmit` → "Prompt submitted",
    other → `"<hookEvent> · <state>"`; `summary` = prompt (busy) or lastAssistantMessage (idle);
    `source: 'orca.hooks'`; other fields empty/null.
  - The very first read after `start()` emits **no** transitions (it's the baseline) but does
    emit `entries`.
- Emit `{type:'hooks', entries, transitions}` on every change.
- `health()`: `{ id:'orca-hooks', label:'Orca hooks', status, path: hooksFile, version: 'v2', detail: '<n> panes · <n> working', … }`.

### E. Fixture — `test/fixtures/orca.ts`

- Realistic, sanitized JSON strings for `orca status --json`, `orca worktree ps --json` (≥ 3
  worktrees incl. one with a linked PR object and one archived), `orca terminal list --json`
  (≥ 4 terminals incl. one `agentIdentity: 'opencode'`, one shell, one with ANSI escape codes and
  a fake token `ghp_FAKE…` in `preview`), an `ok:false` envelope, and a non-running status.
- `fakeRunner(responses)` implementing `CliRunner` that records calls.
- `writeHooksFile(path, entries)` that writes atomically (write temp + rename) like Orca, and
  `hookEntry(partial)` builder producing the real shape (data-sources §3), including
  `launchTokenHash` and `authorityCommitments` so tests can assert they are ignored.

### F. Tests

- Parsers: field mapping, branch stripping, link normalization, ANSI/redaction in preview,
  drift tolerance.
- CLI source with `fakeRunner` + fake timers: allowlist (calls recorded are exactly the three
  vectors), no overlap when a call is slow, status/fleet change detection, last-good snapshot on
  failure, health transitions, 3-strike clearing when Orca stops, disabled when `orcaCli` null.
- Hooks source with a temp dir: baseline read emits entries but no transitions; atomic rewrite
  emits a `state` transition; PermissionRequest → `permission` kind; partial/malformed write is
  ignored then recovered; `endpoint.env` placed next to the file is never opened (spy on
  `fs.readFileSync`/`fs.promises.readFile` or check access via a wrapper).

### G. Manual check (read-only, real machine)

`npx tsx -e` (or a tiny script) that starts both sources against the real config paths
(`~/Library/Application Support/orca/agent-hooks/last-status.json`, real `orca` CLI) for ~6 s and
prints `status`, counts of worktrees/terminals/hook entries and their states. Include the output
(redact nothing sensitive is expected; do not print previews) in your report.

## Acceptance

`npx vitest run src/server/sources/orca` green; typecheck clean for owned files; manual check
shows Orca running with real worktree/terminal/hook counts.

## Report

Summary, files, tests + results, manual check output, deviations.
