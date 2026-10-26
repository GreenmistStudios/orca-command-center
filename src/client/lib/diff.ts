export type DiffLineType = 'add' | 'del' | 'ctx' | 'meta'
export interface DiffLine {
  type: DiffLineType
  text: string
  oldNo: number | null
  newNo: number | null
}
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export interface ParsedFileDiff {
  oldPath: string
  newPath: string
  hunks: DiffHunk[]
}
export interface ParsedDiff {
  files: ParsedFileDiff[]
  additions: number
  deletions: number
}

const stripPrefix = (p: string) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '')

/** Parse a unified diff (git or plain `---`/`+++`). Tolerant of missing headers. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: ParsedFileDiff[] = []
  let additions = 0
  let deletions = 0
  let file: ParsedFileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const ensureFile = () => {
    if (!file) {
      file = { oldPath: '', newPath: '', hunks: [] }
      files.push(file)
    }
    return file
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      file = { oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (line.startsWith('--- ') && !hunk) {
      if (!file || file.hunks.length > 0) {
        file = null
      }
      ensureFile().oldPath = stripPrefix(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ') && !hunk) {
      ensureFile().newPath = stripPrefix(line.slice(4))
      continue
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hm) {
      oldNo = Number(hm[1])
      newNo = Number(hm[2])
      hunk = { header: line, lines: [] }
      ensureFile().hunks.push(hunk)
      continue
    }
    if (!hunk) continue // index/mode/similarity headers before the first hunk
    if (line.startsWith('\\')) {
      hunk.lines.push({ type: 'meta', text: line, oldNo: null, newNo: null })
    } else if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
      additions++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
      deletions++
    } else if (line.startsWith(' ') || line === '') {
      if (line === '' && hunk.lines.length === 0) continue
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  // Drop trailing empty context line produced by a final newline.
  for (const f of files) {
    for (const h of f.hunks) {
      const last = h.lines[h.lines.length - 1]
      if (last && last.type === 'ctx' && last.text === '' && text.endsWith('\n')) h.lines.pop()
    }
  }
  return { files, additions, deletions }
}

/**
 * Parse the `*** Begin Patch` format used by codex/opencode apply_patch. Each
 * `*** Update/Add/Delete File:` section becomes a file with one hunk.
 */
export function parsePatchText(text: string): ParsedDiff {
  const files: ParsedFileDiff[] = []
  let additions = 0
  let deletions = 0
  let file: ParsedFileDiff | null = null
  let hunk: DiffHunk | null = null
  let n = 0

  const open = (path: string, header: string) => {
    file = { oldPath: path, newPath: path, hunks: [] }
    hunk = { header, lines: [] }
    file.hunks.push(hunk)
    files.push(file)
    n = 0
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    let m: RegExpExecArray | null
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.*)$/.exec(line))) {
      open(m[2], `*** ${m[1]} File`)
      continue
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch') || line.startsWith('*** End of File')) continue
    if (line.startsWith('*** Move to: ')) {
      if (file) (file as ParsedFileDiff).newPath = line.slice(13)
      continue
    }
    if (!hunk) continue
    const h = hunk as DiffHunk
    if (line.startsWith('@@')) {
      h.lines.push({ type: 'meta', text: line, oldNo: null, newNo: null })
    } else if (line.startsWith('+')) {
      h.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: ++n })
      additions++
    } else if (line.startsWith('-')) {
      h.lines.push({ type: 'del', text: line.slice(1), oldNo: ++n, newNo: null })
      deletions++
    } else if (line.startsWith(' ')) {
      h.lines.push({ type: 'ctx', text: line.slice(1), oldNo: ++n, newNo: n })
    }
  }
  return { files, additions, deletions }
}
