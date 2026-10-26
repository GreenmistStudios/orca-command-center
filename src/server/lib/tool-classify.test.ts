import { describe, expect, it } from 'vitest'
import { createToolClassifier } from './tool-classify.js'

describe('tool classifier', () => {
  it('opencode built-ins', () => {
    const c = createToolClassifier()
    const cases: Array<[string, string]> = [
      ['bash', 'shell'], ['read', 'read'], ['lsp_hover', 'read'], ['grep', 'search'], ['edit', 'edit'],
      ['multiedit', 'edit'], ['write', 'write'], ['apply_patch', 'patch'], ['webfetch', 'web'],
      ['task', 'subagent'], ['todowrite', 'todo'], ['question', 'question'], ['skill', 'skill'],
    ]
    for (const [n, cat] of cases) expect(c.classify('opencode', n).category).toBe(cat)
  })

  it('copilot built-ins', () => {
    const c = createToolClassifier()
    const cases: Array<[string, string]> = [
      ['bash', 'shell'], ['read_bash', 'shell'], ['stop_bash', 'shell'], ['write_bash', 'shell'],
      ['view', 'read'], ['rg', 'search'], ['glob', 'search'], ['grep', 'search'], ['create', 'write'],
      ['edit', 'edit'], ['str_replace', 'edit'], ['str_replace_editor', 'edit'], ['apply_patch', 'patch'],
      ['web_fetch', 'web'], ['web_search', 'web'], ['task', 'subagent'],
    ]
    for (const [n, cat] of cases) expect(c.classify('copilot', n).category).toBe(cat)
  })

  it('known server → mcp', () => {
    const c = createToolClassifier()
    expect(c.classify('opencode', 'atlassian_jira_get_issue')).toEqual({
      category: 'mcp', mcpServer: 'atlassian', displayName: 'jira_get_issue',
    })
    expect(c.classify('opencode', 'github_request_copilot_review')).toMatchObject({ category: 'mcp', mcpServer: 'github' })
    expect(c.classify('opencode', 'chrome-devtools_take_snapshot')).toMatchObject({
      mcpServer: 'chrome-devtools', displayName: 'take_snapshot',
    })
  })

  it('bitrise is a default known server', () => {
    expect(createToolClassifier().classify('opencode', 'bitrise_get_build_log').mcpServer).toBe('bitrise')
  })

  it('extra known servers from options', () => {
    const c = createToolClassifier({ knownServers: ['acme'] })
    expect(c.classify('opencode', 'acme_do_thing')).toMatchObject({ category: 'mcp', mcpServer: 'acme' })
  })

  it('shared prefix becomes mcp (non-default server)', () => {
    const c = createToolClassifier()
    expect(c.classify('opencode', 'zorbit_get_build_log').category).toBe('plugin')
    c.observe('zorbit_get_build_log')
    c.observe('zorbit_list_apps')
    expect(c.classify('opencode', 'zorbit_get_build_log')).toEqual({
      category: 'mcp', mcpServer: 'zorbit', displayName: 'get_build_log',
    })
    expect(c.classify('opencode', 'zorbit_list_apps').mcpServer).toBe('zorbit')
  })

  it('shared prefix counts the classified name itself', () => {
    const c = createToolClassifier()
    c.observe('zeta_one')
    expect(c.classify('opencode', 'zeta_two').category).toBe('mcp')
  })

  it('verb prefixes are plugins even when shared', () => {
    const c = createToolClassifier()
    c.observe('get_goal')
    c.observe('get_goal_history')
    expect(c.classify('opencode', 'get_goal').category).toBe('plugin')
    expect(c.classify('opencode', 'get_goal_history').category).toBe('plugin')
  })

  it('unknown names are plugins', () => {
    const c = createToolClassifier()
    expect(c.classify('opencode', 'acme_toggle_builtins')).toEqual({
      category: 'plugin', mcpServer: null, displayName: 'acme_toggle_builtins',
    })
    c.observe('lonely_tool')
    expect(c.classify('opencode', 'lonely_tool').category).toBe('plugin')
    expect(c.classify('opencode', 'nounderscore').category).toBe('plugin')
  })

  it('copilot treats hyphen like underscore', () => {
    const c = createToolClassifier()
    expect(c.classify('copilot', 'github-get_file')).toMatchObject({ category: 'mcp', mcpServer: 'github' })
    expect(c.classify('copilot', 'atlassian-jira_get_issue')).toMatchObject({ category: 'mcp', mcpServer: 'atlassian', displayName: 'jira_get_issue' })
    c.observe('foo-bar')
    c.observe('foo-baz')
    expect(c.classify('copilot', 'foo-bar')).toMatchObject({ category: 'mcp', mcpServer: 'foo', displayName: 'bar' })
    expect(c.classify('opencode', 'foo-bar').category).toBe('plugin')
  })

  it('is case-insensitive for built-ins', () => {
    expect(createToolClassifier().classify('opencode', 'Bash').category).toBe('shell')
  })
})
