// Reuse the pinned Loader runtime; never patch the application or terminate its processes.
import path from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { ResidentInjector } from './resident.mjs'
import { waitForStableDocument } from './recovery.mjs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const revision = 'b6ec28c69af12e9667f57d19823fb46d225756e4'
const pluginId = 'local.codex-usage-indicator'
export const appCandidates = () => ['/Applications/Codex.app', '/Applications/ChatGPT.app',
  path.join(homedir(), 'Applications/Codex.app'), path.join(homedir(), 'Applications/ChatGPT.app')]
// Crashpad is detached, can survive app upgrades/exits and never owns a renderer/CDP listener.
export const withoutCrashReporters = processes => processes.filter(item =>
  !/\/Helpers\/browser_crashpad_handler(?:\s|$)/u.test(item.command))
export function processFamily(roots, rows) {
  const ids = new Set(roots)
  for (let pass = 0; pass < rows.length; pass++) {
    const before = ids.size
    for (const [pid, parent] of rows) if (ids.has(parent)) ids.add(pid)
    if (ids.size === before) break
  }
  return ids
}

export async function inspectLoader(loaderRoot, dataRoot) {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('requires-macos-node22')
  const root = path.resolve(loaderRoot)
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'codex-script-loader' || pkg.version !== '0.6.0') throw new Error('loader-version')
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain', '--untracked-files=all']))
    throw new Error('loader-source')
  const load = name => import(pathToFileURL(path.join(root, 'src', name)).href)
  const platform = await load('macos-platform.mjs')
  const app = await platform.discoverMacCodex({ candidates: appCandidates() })
  if (app.bundleId !== 'com.openai.codex') throw new Error('app-identity')
  const { ScriptRegistry } = await load('registry.mjs')
  const registry = await new ScriptRegistry(path.resolve(dataRoot)).init()
  const scripts = await registry.list()
  if (scripts.filter(s => s.enabled).length !== 1 || !scripts.some(s => s.id === pluginId && s.enabled))
    throw new Error('isolated-registry')
  return { app, registry, platform: { ...platform, listMacCodexProcesses: async appInfo =>
    withoutCrashReporters(await platform.listMacCodexProcesses(appInfo)) }, load }
}

export async function main(args) {
  const [mode, loaderRoot, dataRoot, outputRoot, portText] = args
  if (!['--check', '--start', '--wait', '--watch'].includes(mode) || !loaderRoot || !dataRoot || !outputRoot)
    throw new Error('arguments')
  const { app, registry, platform, load } = await inspectLoader(loaderRoot, dataRoot)
  await mkdir(outputRoot, { recursive: true })
  const stateFile = path.join(outputRoot, 'macos-loader-state.json')
  const state = async (status, extra = {}) => {
    const value = { schemaVersion: 2, status, workerPid: process.pid, appVersion: app.version,
      at: new Date().toISOString(), persistentHost: mode !== '--check', ...extra }
    await writeFile(stateFile, JSON.stringify(value, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(value))
  }
  const previous = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null)
  if (previous?.workerPid && previous.workerPid !== process.pid && ['waiting-for-exit', 'starting', 'running', 'degraded'].includes(previous.status)) {
    try { process.kill(previous.workerPid, 0); throw new Error('worker-already-running') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  let existing = await platform.listMacCodexProcesses(app)
  if (mode === '--check') { await state('ready', { runningProcesses: existing.length, restartRequired: existing.length > 0 }); return }
  const abort = new AbortController(), stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let resident, watcher, metricsTimer, port, publishing = false, writes = Promise.resolve()
  const publish = (status, extra) => { writes = writes.then(() => state(status, extra)).catch(() => {}) }
  try {
    if (mode === '--watch') {
      port = Number(portText)
      if (!/^\d{1,5}$/.test(portText ?? '') || port < 1 || port > 65535) throw new Error('port')
      if (!existing.length) throw new Error('client-not-running')
    } else {
      if (existing.length && mode === '--start') { await state('client-running'); process.exitCode = 1; return }
      if (existing.length) {
        await state('waiting-for-exit')
        const until = Date.now() + 30 * 60_000
        while (existing.length) {
          if (Date.now() >= until) throw new Error('exit-wait-expired')
          await delay(1000, undefined, { signal: abort.signal })
          existing = await platform.listMacCodexProcesses(app)
        }
      }
      const { allocateLoopbackPort, waitForCdpReady } = await load('live-runtime.mjs')
      const { buildChromiumDebugArgs } = await load('launcher.mjs')
      port = await allocateLoopbackPort()
      await state('starting', { port })
      await platform.activateMacCodex(app, buildChromiumDebugArgs(port))
      await waitForCdpReady(port, { signal: abort.signal })
    }
    const { listTargets, pickCodexTargets, connectCdpSession, assertLoopbackEndpoint } = await load('cdp.mjs')
    const injection = await load('injection.mjs')
    const resolveTarget = async () => {
      const processes = await platform.listMacCodexProcesses(app)
      const listeners = await platform.listMacLoopbackListeners(port)
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
        .trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
      const managed = processFamily(processes.map(p => p.processId), rows)
      if (!listeners.length || listeners.some(p => !managed.has(p.processId))) throw new Error('listener-owner')
      const targets = pickCodexTargets(await listTargets(port))
      if (targets.length !== 1) throw new Error('target')
      if (Number(assertLoopbackEndpoint(targets[0].webSocketDebuggerUrl).port) !== port) throw new Error('endpoint-port')
      return targets[0]
    }
    resident = new ResidentInjector({ resolveTarget, connect: connectCdpSession, injection,
      getPlan: async () => { await registry.reloadConfig(); return (await registry.buildPlan()).descriptors },
      onState: (status, snapshot) => { if (publishing) publish(status, { port, reloadRecovery: true, ...snapshot }) } })
    // fs.watch is an optimization; the 60s plan refresh remains the fallback after watch failures.
    try {
      watcher = watch(path.resolve(dataRoot), { recursive: true }, () => resident.notify(true))
      watcher.on('error', () => { watcher?.close(); watcher = undefined })
    } catch { /* File-system watching is unavailable on some hosts. */ }
    await resident.start()
    const verified = await waitForStableDocument(() => resident.sync(), { signal: abort.signal, timeoutMs: 60000 })
    publishing = true
    await state('running', { port, reloadRecovery: true, ...resident.snapshot(), runtime: verified.runtime })
    const writeMetrics = async () => writeFile(path.join(outputRoot, 'macos-loader-metrics.json'), JSON.stringify({
      at: new Date().toISOString(), pid: process.pid, uptimeSeconds: process.uptime(),
      cpu: process.cpuUsage(), memory: process.memoryUsage(), scope: 'node-self-excludes-child-process-cpu',
      ...resident.snapshot()
    }, null, 2), { mode: 0o600 })
    await writeMetrics()
    metricsTimer = setInterval(() => { void writeMetrics().catch(() => {}) }, 15000)
    await new Promise(resolve => {
      if (abort.signal.aborted) resolve()
      else abort.signal.addEventListener('abort', resolve, { once: true })
    })
    await writeMetrics()
  } catch (error) {
    const known = ['exit-wait-expired', 'document-not-stable', 'client-not-running', 'port']
    await state(abort.signal.aborted ? 'stopped' : 'failed', { code: known.includes(error.message) ? error.message : 'loader-start-or-run' })
    if (!abort.signal.aborted) process.exitCode = 1
  } finally {
    publishing = false; clearInterval(metricsTimer); watcher?.close()
    let cleaned = false
    try { cleaned = resident ? await resident.stop() : true }
    catch { process.exitCode = 1 }
    finally {
      await writes
      process.off('SIGINT', stop); process.off('SIGTERM', stop)
      if (resident) await state('stopped', { port, cleanup: cleaned })
    }
  }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)) }
  catch { console.error(JSON.stringify({ status: 'failed', code: 'preflight' })); process.exitCode = 1 }
}
