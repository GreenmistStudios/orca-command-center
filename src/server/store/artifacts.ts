import type { ActivityEvent, Artifact, FileChange } from '../../shared/contract.js'
import { baseName } from './join.js'

const DOC_EXT = /\.(md|mdx|txt|html|pdf|csv|json|ya?ml)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i
const PR_RE = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/
const MAX_URLS_PER_ROOT = 50

export interface ArtifactScope {
  rootOf: (sessionId: string) => string
}

/** Plan §9.4. Pure: derives artifacts from activity events + file changes. Newest first. */
export function deriveArtifacts(events: readonly ActivityEvent[], changes: readonly FileChange[], scope: ArtifactScope, cap = 500): Artifact[] {
  const out: Artifact[] = []
  const seenUrl = new Set<string>()
  const urlsPerRoot = new Map<string, number>()
  const seenPath = new Set<string>()

  for (const c of changes) {
    if (c.status === 'error') continue
    if (c.kind !== 'write' && c.kind !== 'create') continue
    const key = `${c.kind}:${c.path}:${c.sessionId}`
    if (seenPath.has(key)) continue
    let kind: Artifact['kind'] | null = null
    if (DOC_EXT.test(c.path)) kind = /report/i.test(c.path) ? 'report' : 'document'
    else if (c.kind === 'create') kind = 'new-file'
    if (!kind) continue
    seenPath.add(key)
    out.push({
      id: `artifact:${kind}:${c.id}`,
      kind,
      label: baseName(c.path),
      path: c.path,
      url: null,
      sessionId: c.sessionId,
      rootId: scope.rootOf(c.sessionId),
      ts: c.ts,
      source: `${c.harness} file change${c.tool ? ` · ${c.tool}` : ''}`,
    })
  }

  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  for (const e of sorted) {
    if (!e.sessionId) continue
    const rootId = scope.rootOf(e.sessionId)
    if (e.kind === 'prompt' && e.title.startsWith('Attachment · ')) {
      const name = e.title.slice('Attachment · '.length)
      if (IMAGE_EXT.test(name)) {
        out.push({ id: `artifact:image:${e.id}`, kind: 'image', label: name, path: null, url: null, sessionId: e.sessionId, rootId, ts: e.ts, source: e.source })
      }
      continue
    }
    if (e.kind !== 'tool' && e.kind !== 'mcp' && e.kind !== 'text') continue
    for (const url of e.links) {
      if (seenUrl.has(url)) continue
      const pr = PR_RE.exec(url)
      if (pr) {
        seenUrl.add(url)
        out.push({
          id: `artifact:pull-request:${url}`,
          kind: 'pull-request',
          label: `PR #${pr[3]} · ${pr[1]}/${pr[2]}`,
          path: null,
          url,
          sessionId: e.sessionId,
          rootId,
          ts: e.ts,
          source: e.source,
        })
      } else if (e.kind === 'text') {
        const n = urlsPerRoot.get(rootId) ?? 0
        if (n >= MAX_URLS_PER_ROOT) continue
        urlsPerRoot.set(rootId, n + 1)
        seenUrl.add(url)
        out.push({ id: `artifact:url:${url}`, kind: 'url', label: url.replace(/^https?:\/\//, '').slice(0, 80), path: null, url, sessionId: e.sessionId, rootId, ts: e.ts, source: e.source })
      }
    }
  }

  out.sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1))
  return out.slice(0, cap)
}
