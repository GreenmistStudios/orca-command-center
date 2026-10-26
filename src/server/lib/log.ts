import { format } from 'node:util'
import type { Logger } from '../types.js'

export function createLogger(options: { verbose: boolean; prefix?: string; write?: (line: string) => void }): Logger {
  const write = options.write ?? ((line: string) => void process.stderr.write(line + '\n'))
  const prefix = options.prefix ? `[${options.prefix}] ` : ''
  const emit = (level: string, message: string, rest: unknown[]) => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    write(`${ts} ${level.padEnd(5)} ${prefix}${format(message, ...rest)}`)
  }
  return {
    debug: (m, ...r) => {
      if (options.verbose) emit('debug', m, r)
    },
    info: (m, ...r) => emit('info', m, r),
    warn: (m, ...r) => emit('warn', m, r),
    error: (m, ...r) => emit('error', m, r),
  }
}
