import { ProbeError, probeAppServer } from './rpc'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await probeAppServer(process.argv[2] ?? 'codex'), null, 2)) }
  catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, provider: 'app-server',
      status: 'failed', code: error instanceof ProbeError ? error.code : 'internal' }))
    process.exitCode = 1
  }
}
