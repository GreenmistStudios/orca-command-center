#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`occ requires Node.js >= 22.13 (found ${process.versions.node}).`)
  process.exit(1)
}

// Suppress only the node:sqlite ExperimentalWarning; everything else still prints.
const originalEmit = process.emit
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    typeof data.message === 'string' &&
    data.message.includes('SQLite')
  ) {
    return false
  }
  return originalEmit.call(process, name, data, ...rest)
}

const main = fileURLToPath(new URL('../dist/server/main.js', import.meta.url))
if (!existsSync(main)) {
  console.error('occ is not built — run `npm run build`')
  process.exit(1)
}
await import(pathToFileURL(main).href)
