import type { Config } from '../../types.js'

export const DEFAULT_THRESHOLDS_FOR_BENCH = { liveMs: 600_000, idleMs: 1_800_000, stalledMs: 600_000, workingMs: 120_000 }

/** Minimal Config for the bench script / tests. */
export function benchConfig(opencodeDb: string | null, overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 4270,
    open: false,
    verbose: false,
    dev: false,
    windowMs: 24 * 3600_000,
    pollMs: 750,
    orcaPollMs: 5000,
    orcaTimeoutMs: 15_000,
    orcaDir: null,
    orchestrationDb: null,
    hooksFile: null,
    opencodeDb,
    copilotDir: null,
    orcaCli: null,
    mcpServers: [],
    ringSize: 20_000,
    staticDir: null,
    allowedHosts: [],
    thresholds: DEFAULT_THRESHOLDS_FOR_BENCH,
    ...overrides,
  }
}
