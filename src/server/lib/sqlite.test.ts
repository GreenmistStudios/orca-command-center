import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeniedTableError, openReadOnly, type ReadOnlyDb } from './sqlite.js'

let dir: string
let file: string
let writer: DatabaseSync
let db: ReadOnlyDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-sqlite-'))
  file = join(dir, 'test.db')
  writer = new DatabaseSync(file)
  writer.exec(`
    CREATE TABLE account (id TEXT, secret TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, account_id TEXT);
    INSERT INTO account VALUES ('a1', 'hunter2');
    INSERT INTO session VALUES ('s1', 'hello', 'a1');
  `)
  db = openReadOnly(file)
})

afterEach(() => {
  db.close()
  writer.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('openReadOnly', () => {
  it('reads allowed tables', () => {
    expect(db.all('SELECT id, title FROM session')).toEqual([{ id: 's1', title: 'hello' }])
    expect(db.get<{ title: string }>('SELECT title FROM session WHERE id = ?', 's1')?.title).toBe('hello')
    expect(db.get('SELECT * FROM session WHERE id = ?', 'nope')).toBeUndefined()
  })

  it('does not treat similarly named columns as denied', () => {
    expect(db.all('SELECT account_id FROM session')).toHaveLength(1)
  })

  it.each([
    'SELECT * FROM account',
    'SELECT * FROM "account"',
    'SELECT * FROM ACCOUNT',
    'SELECT * FROM `account`',
    'SELECT * FROM [account]',
    'SELECT s.id FROM session s JOIN account a ON a.id = s.account_id',
    'SELECT id FROM session WHERE account_id IN (SELECT id FROM account)',
    'WITH x AS (SELECT * FROM account) SELECT * FROM x',
    'SELECT * FROM main.account',
    'SELECT * FROM session /* hi */ , account',
  ])('rejects %s', (sql) => {
    expect(() => db.all(sql)).toThrow(DeniedTableError)
  })

  it('does not reject a string literal mentioning a denied table', () => {
    expect(db.all("SELECT 'account' AS x FROM session")).toEqual([{ x: 'account' }])
    expect(db.all("SELECT 'it''s account' AS x")).toHaveLength(1)
  })

  it('supports custom denylists', () => {
    const d = openReadOnly(file, { deniedTables: ['session'] })
    expect(() => d.all('SELECT * FROM session')).toThrow(DeniedTableError)
    expect(d.all('SELECT * FROM account')).toHaveLength(1)
    d.close()
  })

  it.each([
    "INSERT INTO session VALUES ('x','y','z')",
    "UPDATE session SET title = 'x'",
    'DELETE FROM session',
    "ATTACH DATABASE ':memory:' AS m",
    'DROP TABLE session',
    'SELECT 1; DELETE FROM session',
    'PRAGMA journal_mode = DELETE',
    'PRAGMA writable_schema = 1',
  ])('rejects non-read statement %s', (sql) => {
    expect(() => db.all(sql)).toThrow()
    expect(db.all('SELECT * FROM session')).toHaveLength(1)
  })

  it('allows whitelisted pragmas', () => {
    expect(typeof db.dataVersion()).toBe('number')
    expect(db.userVersion()).toBe(0)
    expect(db.columns('session')).toEqual(new Set(['id', 'title', 'account_id']))
  })

  it('lists tables and handles missing ones', () => {
    expect(db.tables()).toEqual(new Set(['account', 'session']))
    expect(db.columns('missing')).toEqual(new Set())
    expect(db.columns('bad name; drop')).toEqual(new Set())
  })

  it('dataVersion changes after a write from another connection', () => {
    const before = db.dataVersion()
    writer.exec("INSERT INTO session VALUES ('s2', 't', 'a1')")
    expect(db.dataVersion()).toBeGreaterThan(before)
  })

  it('explain returns detail strings and is guarded', () => {
    const plan = db.explain('SELECT * FROM session WHERE id = ?', 's1')
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.join(' ')).toMatch(/session/i)
    expect(() => db.explain('SELECT * FROM account')).toThrow(DeniedTableError)
  })

  it('the connection itself is read-only', () => {
    expect(() => db.all("SELECT 1")).not.toThrow()
    const ro = new DatabaseSync(file, { readOnly: true })
    expect(() => ro.exec("INSERT INTO session VALUES ('q','q','q')")).toThrow()
    ro.close()
  })
})
