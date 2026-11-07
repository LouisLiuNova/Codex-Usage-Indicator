// Only an isolated about:blank page; verify real SVG computed colors and generated warning markers.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
const [loaderRoot, portText, bundle, output] = process.argv.slice(2)
const { listTargets, connectCdpSession } = await import(pathToFileURL(path.resolve(loaderRoot, 'src/cdp.mjs')).href)
const targets = (await listTargets(Number(portText))).filter(t => t.type === 'page')
if (targets.length !== 1 || targets[0].url !== 'about:blank') throw new Error('isolated-target-required')
const session = await connectCdpSession(targets[0].webSocketDebuggerUrl)
const evaluate = async expression => {
  const result = await session.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) throw new Error('evaluation')
  return result.result?.value
}
const report = { scope: 'isolated-chromium-synthetic-ring-colors', cases: [] }
try {
  await session.sendCommand('Emulation.setDeviceMetricsOverride', { width: 800, height: 420, deviceScaleFactor: 1, mobile: false })
  const code = await readFile(bundle, 'utf8')
  await evaluate(`(()=>{const module={exports:{}};((module)=>{${code}\n})(module);globalThis.__ringColors=module.exports.createRingColorFixture(document)})()`)
  for (const theme of ['light', 'dark']) {
    // App theme must win even when the OS preference is the opposite.
    await session.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'light' ? 'dark' : 'light' }] })
    await evaluate(`__ringColors.theme(${JSON.stringify(theme)})`)
    for (const kind of ['fiveHour', 'weekly']) for (const value of [50, 30, 29.99, 10, 9.99, 0.1, 0, null]) {
      await evaluate(`__ringColors.update(${kind === 'fiveHour' ? JSON.stringify(value) : 75},${kind === 'weekly' ? JSON.stringify(value) : 75})`)
      const entries = await evaluate('__ringColors.snapshot()'), current = entries.find(e => e.kind === kind), other = entries.find(e => e.kind !== kind)
      const level = value === null || value >= 30 ? 'normal' : value >= 10 ? 'low' : 'critical'
      const normal = kind === 'fiveHour' ? 'rgb(102, 153, 161)' : 'rgb(143, 119, 181)'
      const expected = level === 'normal' ? normal : level === 'low' ? 'rgb(176, 119, 54)'
        : theme === 'light' ? 'rgb(142, 53, 74)' : 'rgb(219, 77, 109)'
      const marker = level === 'critical', title = value === null ? '额度未知' : value === 0 ? '已经用尽' : marker ? '即将用尽' : ''
      const passed = current.stroke === expected && current.level === level && current.warning === String(marker)
        && current.marker.includes('!') === marker && (!marker || current.markerColor === expected) && current.title === title
        && current.scheme === theme && other.level === 'normal' && other.warning === 'false'
      report.cases.push({ theme, kind, value, expected, passed, current })
    }
    if (output) {
      await evaluate('__ringColors.update(29.99,9.99)')
      const shot = await session.sendCommand('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}-${theme}.png`, Buffer.from(shot.data, 'base64'))
    }
  }
  report.passed = report.cases.every(c => c.passed)
  if (output) await writeFile(`${output}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, total: report.cases.length, failures: report.cases.filter(c => !c.passed) }))
  if (!report.passed) process.exitCode = 1
} finally {
  await evaluate('globalThis.__ringColors?.stop();delete globalThis.__ringColors').catch(() => {})
  await session.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
  await session.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await session.close()
}
