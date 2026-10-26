export const REDACTED = '[redacted]'
export const DATA_URL_PLACEHOLDER = '[data-url omitted]'

const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|api[_-]?key|cookie|private[_-]?key|signature)/i
const MAX_DEPTH = 8

type Rule = [RegExp, string | ((...m: string[]) => string)]

const RULES: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `[redacted private key]`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_m, scheme: string) => `${scheme}${REDACTED}@`],
  [/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, `eyJ…${REDACTED}`],
  [/(\bAuthorization\s*:\s*)[^\r\n]+/gi, (_m, p: string) => `${p}${REDACTED}`],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, p: string) => `${p}${REDACTED}`],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, `$1${REDACTED}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, `$1${REDACTED}`],
  [/\b(sk-ant-)[A-Za-z0-9\-_]{20,}/g, `$1${REDACTED}`],
  [/\b(sk-)[A-Za-z0-9\-_]{20,}/g, `$1${REDACTED}`],
  [/\b(AKIA)[0-9A-Z]{16}\b/g, `$1${REDACTED}`],
  [/\b(ASIA)[0-9A-Z]{16}\b/g, `$1${REDACTED}`],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, `$1${REDACTED}`],
  [/\b(AIza)[0-9A-Za-z\-_]{35}/g, `$1${REDACTED}`],
  [
    /((?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi,
    (_m, p: string) => `${p}${REDACTED}`,
  ],
]

const DATA_URL_BASE64 = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^,;\s"'`<>)\]]*)*;base64,[^\s"'`<>)\]]*/gi
const DATA_URL_PLAIN = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^,;\s"'`<>)\]]*)*,[^\s"'`<>)\]]{16,}/gi

export function redactText(text: string): string {
  let out = text.replace(DATA_URL_BASE64, DATA_URL_PLACEHOLDER).replace(DATA_URL_PLAIN, DATA_URL_PLACEHOLDER)
  for (const [re, rep] of RULES) {
    out = out.replace(re, rep as string)
  }
  return out
}

/** Deep copy with secrets redacted. Numbers/booleans/null under sensitive keys are preserved (e.g. token counts). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth limit]'
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return DATA_URL_PLACEHOLDER
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && v !== null && v !== undefined && typeof v !== 'number' && typeof v !== 'boolean') {
        out[k] = REDACTED
      } else {
        out[k] = redactValue(v, depth + 1)
      }
    }
    return out
  }
  return value
}
