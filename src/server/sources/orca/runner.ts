import { execFile } from 'node:child_process'
import type { CliRunner } from '../../types.js'

/** Runs an executable without a shell. Never rejects on non-zero exit. */
export const defaultCliRunner: CliRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout: options.timeoutMs, maxBuffer: options.maxBuffer, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0 })
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
        const exitCode = typeof e.code === 'number' ? e.code : null
        const msg = e.killed ? `timed out after ${options.timeoutMs} ms` : String(e.message ?? e)
        resolve({ stdout: stdout ?? '', stderr: (stderr ?? '') || msg, exitCode })
      },
    )
  })

export const CLI_ALLOWLIST: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(['status', '--json']),
  Object.freeze(['worktree', 'ps', '--json']),
  Object.freeze(['terminal', 'list', '--json']),
])

export function assertAllowed(args: readonly string[]): void {
  const ok = CLI_ALLOWLIST.some((a) => a.length === args.length && a.every((x, i) => x === args[i]))
  if (!ok) throw new Error(`orca CLI command not allowed: ${args.join(' ')}`)
}
