import { ProbeError, probeAppServer } from './rpc'

if (import.meta.main) {
  try { console.log(JSON.stringify(await probeAppServer(process.argv[2] ?? 'codex'), null, 2)) }
  catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, provider: 'app-server',
      status: 'failed', code: error instanceof ProbeError ? error.code : 'internal' }))
    process.exitCode = 1
  }
}
