import { describe, expect, it } from 'vitest'
import { parsePatchText, parseUnifiedDiff } from './diff'

const UNIFIED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export {}
`

describe('parseUnifiedDiff', () => {
  it('parses files, hunks, line numbers and totals', () => {
    const d = parseUnifiedDiff(UNIFIED)
    expect(d.files).toHaveLength(1)
    expect(d.files[0].newPath).toBe('src/a.ts')
    expect(d.additions).toBe(2)
    expect(d.deletions).toBe(1)
    const lines = d.files[0].hunks[0].lines
    expect(lines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
    expect(lines[1]).toMatchObject({ oldNo: 2, newNo: null })
    expect(lines[3]).toMatchObject({ oldNo: null, newNo: 3 })
    expect(lines[4]).toMatchObject({ oldNo: 3, newNo: 4 })
  })
  it('handles plain ---/+++ headers without git header', () => {
    const d = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
    expect(d.files[0].oldPath).toBe('x')
    expect(d.additions + d.deletions).toBe(2)
  })
})

describe('parsePatchText', () => {
  it('parses apply_patch bodies', () => {
    const d = parsePatchText('*** Begin Patch\n*** Update File: src/x.ts\n@@\n ctx\n-old\n+new\n*** Add File: y.ts\n+hi\n*** End Patch')
    expect(d.files.map((f) => f.newPath)).toEqual(['src/x.ts', 'y.ts'])
    expect(d.additions).toBe(2)
    expect(d.deletions).toBe(1)
  })
})
