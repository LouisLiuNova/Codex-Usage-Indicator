// Synthetic provider in an isolated about:blank Chromium. Never navigates the real client.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { ResidentInjector } from './resident.mjs'
import { pluginId, waitForStableDocument } from './recovery.mjs'
const [loaderRoot, portText, bundle, output] = process.argv.slice(2)
const load = name => import(pathToFileURL(path.resolve(loaderRoot, 'src', name)).href)
const { listTargets, connectCdpSession } = await load('cdp.mjs')
const injection = await load('injection.mjs')
const resolveTarget = async () => {
  const targets = (await listTargets(Number(portText))).filter(t => t.type === 'page')
  if (targets.length !== 1 || targets[0].url !== 'about:blank') throw new Error('isolated-about-blank-required')
  return targets[0]
}
const control = await connectCdpSession((await resolveTarget()).webSocketDebuggerUrl)
const evaluate = async expression => {
  const r = await control.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error('evaluation')
  return r.result?.value
}
await control.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
const code = await readFile(bundle, 'utf8')
const descriptor = { id: pluginId, name: 'synthetic geometry', version: 'test', fingerprint: 'resident-fixture-v1',
  permissions: ['dom'], scope: 'renderer', settingsMode: 'none', source: `${code}\nlet fixture;module.exports.start=()=>{fixture=module.exports.createGeometryFixture(document,'thread','dark');return()=>fixture.stop()};module.exports.stop=()=>fixture?.stop();` }
let active = true, connection
const diagnostics = []
const resident = new ResidentInjector({ resolveTarget, injection, getPlan: async () => active ? [descriptor] : [],
  connect: async endpoint => {
    connection = await connectCdpSession(endpoint)
    const send = connection.sendCommand.bind(connection)
    connection.sendCommand = async (method, params) => {
      const result = await send(method, params)
      if (result?.exceptionDetails) diagnostics.push({ method, details: result.exceptionDetails })
      return result
    }
    return connection
  } })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const state = () => evaluate(`({documentId:globalThis.__codexScriptLoader?.documentId,runtime:globalThis.__codexUsageIndicatorRuntime?.inspect()??null,styles:document.querySelectorAll('style[data-cui-style]').length,slots:document.querySelectorAll('[data-cui-slot]').length})`)
const eventually = async predicate => {
  const start = Date.now()
  while (Date.now() - start < 10000) { const s = await state(); if (predicate(s)) return { elapsedMs: Date.now() - start, state: s }; await wait(50) }
  throw new Error('condition-timeout')
}
const report = { scope: 'isolated-chromium-resident-events', reloads: [] }
try {
  await resident.start()
  await waitForStableDocument(() => resident.sync())
  report.initial = resident.snapshot()
  // No manual sync after reload: the held registration and page events must restore it.
  for (let i = 0; i < 3; i++) {
    const before = await state(); const start = Date.now(); await control.sendCommand('Page.reload')
    const r = await eventually(s => s.documentId !== before.documentId && s.runtime?.status === 'ready' && s.slots === 2 && s.styles === 1)
    report.reloads.push({ ...r, elapsedMs: Date.now() - start })
    await wait(200)
  }
  report.afterReloads = resident.snapshot()
  active = false; resident.notify(true)
  report.disabled = await eventually(s => s.runtime === null && s.slots === 0 && s.styles === 0)
  await control.sendCommand('Page.reload'); await wait(300)
  report.disabledReload = await state()
  active = true; resident.notify(true)
  report.enabled = await eventually(s => s.runtime?.status === 'ready' && s.slots === 2 && s.styles === 1)
  await connection.close()
  // Exercise the next health check immediately; the default production interval is 15 seconds.
  await resident.sync()
  await eventually(() => true)
  const until = Date.now() + 10000
  while ((resident.snapshot().connections < 2 || !resident.snapshot().connected || resident.work) && Date.now() < until) await wait(100)
  await eventually(s => s.runtime?.status === 'ready' && s.slots === 2 && s.styles === 1)
  report.reconnected = resident.snapshot(); report.diagnostics = diagnostics
  await resident.stop()
  report.stopped = await state()
  await control.sendCommand('Page.reload'); await wait(300)
  report.stoppedReload = await state()
  // Hold the current document in the loading state to exercise a queued boot at shutdown.
  await evaluate(`Object.defineProperty(document,'readyState',{value:'loading',configurable:true})`)
  const pending = new ResidentInjector({ resolveTarget, injection, getPlan: async () => [descriptor], connect: connectCdpSession })
  try {
    await pending.start()
    report.pendingBoot = await evaluate('!!globalThis.__codexUsageIndicatorBoot')
    await pending.stop()
    await evaluate(`delete document.readyState;document.dispatchEvent(new Event('DOMContentLoaded'))`)
    report.cancelledBoot = await state()
  } finally { await pending.stop(); await evaluate('delete document.readyState') }
  report.passed = report.reloads.every(r => r.state.slots === 2 && r.state.styles === 1)
    && report.afterReloads.connections === 1 && report.disabledReload.runtime === null
    && report.reconnected.connections >= 2 && report.reconnected.connected && !report.stopped.runtime && report.stopped.styles === 0
    && !report.stoppedReload.runtime && report.pendingBoot && !report.cancelledBoot.runtime
  if (output) await writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({passed:report.passed,reloadMs:report.reloads.map(r=>r.elapsedMs),reconnected:report.reconnected.connected,pendingBootCancelled:report.pendingBoot&&!report.cancelledBoot.runtime,diagnostics}))
  if (!report.passed) process.exitCode = 1
} finally {
  await resident.stop().catch(() => {})
  await control.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await control.close()
}
