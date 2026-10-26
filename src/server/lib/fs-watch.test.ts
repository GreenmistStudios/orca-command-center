import { mkdtempSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { watchDirectory, watchPath, type Watcher } from './fs-watch.js'

let dir: string
let watchers: Watcher[]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(20)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-watch-'))
  watchers = []
})
afterEach(() => {
  watchers.forEach((w) => w.close())
  rmSync(dir, { recursive: true, force: true })
})

describe('watchPath', () => {
  it('fires on write and atomic replace, debounced', async () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '1')
    let n = 0
    watchers.push(watchPath(file, () => n++, { debounceMs: 30, pollMs: 200 }))
    writeFileSync(file, '22')
    writeFileSync(file, '333')
    await until(() => n >= 1)
    expect(n).toBeGreaterThanOrEqual(1)
    await sleep(100)
    const after = n
    writeFileSync(join(dir, 'tmp'), 'xxxx')
    renameSync(join(dir, 'tmp'), file)
    await until(() => n > after)
    expect(n).toBeGreaterThan(after)
  })

  it('ignores other files in the directory (events)', async () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '1')
    let n = 0
    await sleep(150) // let events from the setup write settle
    watchers.push(watchPath(file, () => n++, { debounceMs: 20, pollMs: 60_000 }))
    writeFileSync(join(dir, 'other.txt'), 'x')
    await sleep(250)
    expect(n).toBe(0)
  })

  it('picks up a file whose directory appears later (poll)', async () => {
    const sub = join(dir, 'later')
    const file = join(sub, 'f.json')
    let n = 0
    watchers.push(watchPath(file, () => n++, { debounceMs: 20, pollMs: 50 }))
    await sleep(100)
    mkdirSync(sub)
    writeFileSync(file, 'hi')
    await until(() => n >= 1)
    expect(n).toBeGreaterThanOrEqual(1)
  })

  it('stops after close', async () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, '1')
    let n = 0
    const w = watchPath(file, () => n++, { debounceMs: 10, pollMs: 30 })
    w.close()
    writeFileSync(file, '2222')
    await sleep(200)
    expect(n).toBe(0)
  })
})

describe('watchDirectory', () => {
  it('fires when entries are added', async () => {
    let n = 0
    watchers.push(watchDirectory(dir, () => n++, { debounceMs: 20, pollMs: 100 }))
    writeFileSync(join(dir, 'x'), 'x')
    await until(() => n >= 1)
    expect(n).toBeGreaterThanOrEqual(1)
  })
})
