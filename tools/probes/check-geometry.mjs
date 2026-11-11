// Only an isolated about:blank target; synthetic provider, no real client navigation.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
const [loaderRoot, portText, bundle, output] = process.argv.slice(2)
const { listTargets, connectCdpSession } = await import(pathToFileURL(path.resolve(loaderRoot, 'src/cdp.mjs')).href)
const targets = (await listTargets(Number(portText))).filter(t => t.type === 'page')
if (targets.length !== 1 || targets[0].url !== 'about:blank') throw new Error('isolated-target-required')
const session = await connectCdpSession(targets[0].webSocketDebuggerUrl)
const evaluate = async expression => {
  const r = await session.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error('evaluation')
  return r.result?.value
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { scope: 'isolated-chromium-synthetic-geometry', cases: [] }
try {
  const source = await readFile(bundle, 'utf8')
  await evaluate(`(()=>{const module={exports:{}};((module)=>{${source}\n})(module);globalThis.__geometryModule=module.exports})()`)
  for (const width of [640, 1000, 1440]) for (const scale of [1, 2]) for (const theme of ['light', 'dark']) for (const mode of ['home', 'thread']) {
    await session.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: scale, mobile: false })
    await evaluate(`globalThis.__geometry=__geometryModule.createGeometryFixture(document,${JSON.stringify(mode)},${JSON.stringify(theme)})`)
    // Wait for the initial scheduled mount; headless background timers can exceed 150ms.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate('__geometry.snapshot().runtime.ui.scans > 0')) break
      await wait(100)
    }
    for (let i = 0; i < 6; i++) { await evaluate('__geometry.mutate()'); await wait(80) }
    const result = await evaluate('__geometry.snapshot()')
    const passed = mode === 'home'
      ? result?.runtime?.ui?.slots === 1 && result.runtime.ui.adapters.some(a => a.kind === 'composer' && a.code === 'context') && result.overlap === null && result.replacements === 0
      : result?.runtime?.ui?.slots === 2 && result.sameSlot && result.replacements === 0 && result.aligned
      && result.overlap === 12 && result.textBelow && result.upperEdgeHidden && result.joinedEdge && result.nativeAbove && result.viewport
    report.cases.push({ width, scale, theme, mode, passed, result })
    if (width === 1000 && scale === 1 && mode === 'thread' && theme === 'dark' && output) {
      const shot = await session.sendCommand('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}.png`, Buffer.from(shot.data, 'base64'))
    }
    await evaluate('__geometry.stop();delete globalThis.__geometry')
  }
  report.passed = report.cases.every(c => c.passed)
  if (output) await writeFile(`${output}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, total: report.cases.length, failures: report.cases.filter(c => !c.passed) }))
  if (!report.passed) process.exitCode = 1
} finally {
  await evaluate('globalThis.__geometry?.stop();delete globalThis.__geometry;delete globalThis.__geometryModule').catch(() => {})
  await session.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await session.close()
}
