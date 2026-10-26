import { describe, expect, it } from 'vitest'
import { DATA_URL_PLACEHOLDER, REDACTED, redactText, redactValue } from './redact.js'

const a20 = 'A1b2C3d4E5f6G7h8I9j0'

describe('redactText', () => {
  it.each([
    ['ghp token', `token ghp_${a20}xyz`, `ghp_${a20}`],
    ['gho token', `gho_${a20}`, a20],
    ['fine-grained pat', `github_pat_${a20}_abc`, a20],
    ['openai key', `key sk-${a20}abcd`, a20],
    ['anthropic key', `sk-ant-api03-${a20}-_x`, a20],
    ['aws akia', 'AKIA' + 'IOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['aws asia', 'ASIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['slack', 'xoxb-1234567890-abcdef', '1234567890-abcdef'],
    ['google', `AIza${'a'.repeat(35)}`, 'a'.repeat(35)],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV', 'SflKxwRJ'],
    ['bearer', 'curl -H "x" Bearer abcdefghijklmnop123', 'abcdefghijklmnop123'],
    ['authorization header', 'Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['url creds', 'git clone https://bob:s3cr3t@github.com/x/y', 's3cr3t'],
    ['api_key assign', 'api_key=abcdef12345', 'abcdef12345'],
    ['password colon', 'password: hunter2', 'hunter2'],
    ['quoted json', '{"client_secret": "zzz999"}', 'zzz999'],
    ['env style', 'ACCESS_KEY="qwerty"', 'qwerty'],
    ['pwd', 'pwd = letmein', 'letmein'],
  ])('redacts %s', (_n, input, secret) => {
    const out = redactText(input)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----'
    const out = redactText(`before\n${pem}\nafter`)
    expect(out).not.toContain('MIIabc')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('keeps recognizable prefixes', () => {
    expect(redactText(`ghp_${a20}xyz`)).toBe(`ghp_${REDACTED}`)
    expect(redactText('Bearer abcdefghijkl')).toBe(`Bearer ${REDACTED}`)
  })

  it('redacts all of an Authorization value including scheme', () => {
    expect(redactText('Authorization: Bearer abcdefghijkl')).toBe(`Authorization: ${REDACTED}`)
  })

  it('leaves ordinary text alone', () => {
    for (const s of [
      'the tokenizer splits words',
      'sk-short',
      'ghp_short',
      'use a token for auth',
      'password reset page',
      'https://github.com/a/b',
      'Bearer of bad news',
      'AKIA',
      'tokens: 12',
    ]) {
      expect(redactText(s)).toBe(s)
    }
  })

  it('is idempotent', () => {
    const once = redactText(`password=abc123 ghp_${a20}xyz`)
    expect(redactText(once)).toBe(once)
  })
})

describe('redactValue', () => {
  it('redacts sensitive keys and nested strings', () => {
    const out = redactValue({
      name: 'x',
      apiKey: 'plain',
      headers: { Authorization: 'whatever', cookie: 'a=b' },
      list: [{ password: 'p' }, 'ghp_' + a20 + 'xyz'],
      nothing: null,
    }) as Record<string, any>
    expect(out.name).toBe('x')
    expect(out.apiKey).toBe(REDACTED)
    expect(out.headers.Authorization).toBe(REDACTED)
    expect(out.headers.cookie).toBe(REDACTED)
    expect(out.list[0].password).toBe(REDACTED)
    expect(out.list[1]).toBe(`ghp_${REDACTED}`)
    expect(out.nothing).toBeNull()
  })

  it('keeps numeric counters under token-like keys', () => {
    expect(redactValue({ tokens: 5, maxTokens: 10 })).toEqual({ tokens: 5, maxTokens: 10 })
  })

  it('replaces long data URLs only', () => {
    expect(redactValue('data:image/png;base64,' + 'A'.repeat(100))).toBe(DATA_URL_PLACEHOLDER)
    expect(redactValue('data:text/plain,hi')).toBe('data:text/plain,hi')
  })

  it('does not mutate input and limits depth', () => {
    const input = { password: 'x', a: { b: 1 } }
    redactValue(input)
    expect(input.password).toBe('x')
    let deep: any = { v: 'leaf' }
    for (let i = 0; i < 12; i++) deep = { n: deep }
    expect(JSON.stringify(redactValue(deep))).toContain('[depth limit]')
  })
})
