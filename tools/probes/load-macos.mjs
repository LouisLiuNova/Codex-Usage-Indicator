// Reuse the pinned Loader runtime; never patch the application or terminate its processes.
import path from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises'
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
  if (!['--check', '--start', '--wait', '--once', '--wait-once', '--inject-once'].includes(mode) || !loaderRoot || !dataRoot || !outputRoot)
    throw new Error('arguments')
  const { app, registry, platform, load } = await inspectLoader(loaderRoot, dataRoot)
  await mkdir(outputRoot, { recursive: true })
  const stateFile = path.join(outputRoot, 'macos-loader-state.json')
  const state = async (status, extra = {}) => {
    const value = { schemaVersion: 1, status, workerPid: process.pid, appVersion: app.version,
      at: new Date().toISOString(), ...extra }
    await writeFile(stateFile, JSON.stringify(value, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(value))
  }
  // A second worker must not start a second managed instance or replace the first worker's state.
  const previous = await readFile(stateFile, 'utf8').then(JSON.parse).catch(() => null)
  if (previous?.workerPid && previous.workerPid !== process.pid && ['waiting-for-exit', 'starting', 'running'].includes(previous.status)) {
    try { process.kill(previous.workerPid, 0); throw new Error('worker-already-running') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  let existing = await platform.listMacCodexProcesses(app)
  if (mode === '--inject-once') {
    const port = Number(portText)
    if (!/^\d{1,5}$/.test(portText ?? '') || port < 1 || port > 65535) throw new Error('port')
    const listeners = await platform.listMacLoopbackListeners(port)
    // macOS child helpers outside the app bundle can inherit the listening descriptor.
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      .trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    const managed = processFamily(existing.map(p => p.processId), rows)
    if (!listeners.length || listeners.some(p => !managed.has(p.processId))) throw new Error('listener-owner')
    const { listTargets, pickCodexTargets, connectCdpSession, CdpInjector, assertLoopbackEndpoint } = await load('cdp.mjs')
    const targets = pickCodexTargets(await listTargets(port))
    if (targets.length !== 1) throw new Error('target')
    const sessionFactory = endpoint => {
      if (Number(assertLoopbackEndpoint(endpoint).port) !== port) throw new Error('endpoint-port')
      return connectCdpSession(endpoint)
    }
    const { descriptors, safeMode } = await registry.buildPlan()
    if (safeMode || descriptors.length !== 1 || descriptors[0].id !== pluginId) throw new Error('plan')
    // Only bootstrap + this dom-only package. No disconnected settings/composer/host UI.
    const { buildBootstrapSource, buildLifecycleSyncSource, wrapScript, buildRuntimeSnapshotSource } = await load('injection.mjs')
    const source = [buildBootstrapSource(), buildLifecycleSyncSource(descriptors), wrapScript(descriptors[0]), buildRuntimeSnapshotSource()].join('\n')
    const injector = new CdpInjector({ targetProvider: async () => targets, sessionFactory })
    await injector.inject(source)
    // Check the current document after async startup instead of trusting an early injection receipt.
    await delay(1500)
    const current = pickCodexTargets(await listTargets(port))
    if (current.length !== 1 || current[0].id !== targets[0].id) throw new Error('target-changed')
    const session = await sessionFactory(current[0].webSocketDebuggerUrl)
    try {
      const result = await session.sendCommand('Runtime.evaluate', { expression: 'globalThis.__codexUsageIndicatorRuntime?.inspect()??null', returnByValue: true })
      const status = result.result?.value
      if (!status?.active) throw new Error('runtime-missing')
      await state('injected', { port, persistentHost: false, runtime: status })
    } finally { await session.close() }
    return
  }
  if (mode === '--check') {
    await state('ready', { runningProcesses: existing.length, restartRequired: existing.length > 0 })
    return
  }
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let runtime
  let failed = false
  const once = mode === '--once' || mode === '--wait-once'
  try {
    if (existing.length && (mode === '--start' || mode === '--once')) { await state('client-running'); process.exitCode = 1; return }
    if (existing.length) {
      await state('waiting-for-exit')
      const until = Date.now() + 30 * 60_000
      while (existing.length) {
        if (Date.now() >= until) throw new Error('exit-wait-expired')
        await delay(1000, undefined, { signal: abort.signal })
        existing = await platform.listMacCodexProcesses(app)
      }
    }
    if (abort.signal.aborted) return
    await state('starting')
    const { startMacLiveRuntime } = await load('live-runtime.mjs')
    runtime = await startMacLiveRuntime({ dataRoot: path.resolve(dataRoot), signal: abort.signal,
      dependencies: { discoverMacCodex: async () => app, listMacCodexProcesses: platform.listMacCodexProcesses } })
    // Upstream enforces loopback listener ownership and the exact app renderer target.
    const snapshot = runtime.supervisor.snapshot()
    if (snapshot.phase !== 'healthy' || snapshot.scriptStatuses.length !== 1
      || snapshot.scriptStatuses[0].id !== pluginId || snapshot.scriptStatuses[0].status !== 'running')
      throw new Error('injection-failed')
    if (once) {
      // Leave the renderer-owned plugin alive, but release all Node host bridges and sockets.
      await runtime.close()
      await state('injected', { port: runtime.port, enabledScripts: snapshot.enabledScripts, persistentHost: false })
      runtime = undefined
      return
    }
    await state('running', { port: runtime.port, enabledScripts: snapshot.enabledScripts })
    await runtime.run({ signal: abort.signal })
  } catch (error) {
    failed = !abort.signal.aborted
    const known = ['exit-wait-expired']
    await state(abort.signal.aborted ? 'stopped' : 'failed', { code: known.includes(error.message) ? error.message : 'loader-start-or-run' })
    if (!abort.signal.aborted) process.exitCode = 1
  } finally {
    try { await runtime?.close() } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop)
      // Cleanup must not replace a failure's terminal status and diagnostic code.
      if (runtime && !failed) await state('stopped')
    }
  }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)) }
  catch { console.error(JSON.stringify({ status: 'failed', code: 'preflight' })); process.exitCode = 1 }
}
