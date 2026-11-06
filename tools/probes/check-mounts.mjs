// Run the project's synthetic fixture in a Codex Renderer, with waits outside the browser.
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const [loaderRoot, portText, bundle] = process.argv.slice(2)
const report = { schemaVersion: 1, scope: 'isolated-chromium-iframe', status: 'failed', code: 'arguments', checks: {} }
let session, created = false
try {
  const port = Number(portText)
  if (!loaderRoot || !bundle || !/^\d{1,5}$/.test(portText ?? '') || port < 1 || port > 65535) throw new Error('arguments')
  report.code = 'loader'
  const root = path.resolve(loaderRoot), pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'codex-script-loader' || pkg.version !== '0.6.0') throw new Error('loader')
  const { listTargets, pickCodexTargets, connectCdpSession } = await import(pathToFileURL(path.join(root, 'src/cdp.mjs')).href)
  report.code = 'target'
  const targets = pickCodexTargets(await listTargets(port)); if (targets.length !== 1) throw new Error('target')
  session = await connectCdpSession(targets[0].webSocketDebuggerUrl, { timeoutMs: 15000 })
  const evaluate = async expression => {
    const result = await session.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error('evaluation')
    return result.result?.value
  }
  report.code = 'busy'
  if (await evaluate(`!!globalThis.__cuiMountFixture || !!document.querySelector('iframe[data-cui-fixture]')`)) throw new Error('busy')
  report.code = 'setup'
  const code = await readFile(path.resolve(bundle), 'utf8')
  await evaluate(`(()=>{const module={exports:{}};((module)=>{${code}\n})(module);const control=module.exports.createMountLifecycleFixture(document);globalThis.__cuiMountFixture=control;const stop=control.stop;const timer=setTimeout(()=>control.stop(),60000);control.stop=()=>{clearTimeout(timer);stop();if(globalThis.__cuiMountFixture===control)delete globalThis.__cuiMountFixture}})()`)
  created = true
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const stage = async (name, action, expected) => {
    report.code = name
    if (action) await evaluate(`globalThis.__cuiMountFixture.${action}()`)
    let state
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(500); state = await evaluate('globalThis.__cuiMountFixture.snapshot()')
      if (expected(state)) { report.checks[name] = state; return state }
    }
    report.checks[name] = state; throw new Error('condition')
  }
  await stage('initial-hidden', null, value => value.slots === 1)
  const shown = await stage('revealed', 'reveal', value => value.slots === 2)
  await evaluate('globalThis.__cuiMountFixture.unrelated()'); await wait(1500)
  const unrelated = await evaluate('globalThis.__cuiMountFixture.snapshot()')
  report.checks['unrelated-filtered'] = unrelated
  if (unrelated.scans !== shown.scans) throw new Error('unrelated-scan')
  await stage('composer-rebuilt', 'rebuildComposer', value => value.slots === 2 && value.scans > unrelated.scans)
  const rebuilt = report.checks['composer-rebuilt']
  await stage('rail-rebuilt', 'rebuildRail', value => value.slots === 2 && value.scans > rebuilt.scans)
  const beforeDuplicate = report.checks['rail-rebuilt']
  await stage('hidden-duplicate', 'addHiddenDuplicate', value => value.slots === 2 && value.scans > beforeDuplicate.scans)
  await stage('ambiguity-rejected', 'revealDuplicate', value => value.slots === 1 && value.adapters.some(a => a.kind === 'composer' && a.code === 'ambiguity'))
  await stage('ambiguity-recovered', 'removeDuplicate', value => value.slots === 2)
  await stage('removed-slot-recovered', 'removeSlot', value => value.slots === 2 && value.scans > report.checks['ambiguity-recovered'].scans)
  report.status = 'passed'; delete report.code
} catch { process.exitCode = 1 }
finally {
  if (session) {
    try {
      if (created) await session.sendCommand('Runtime.evaluate', { expression: 'globalThis.__cuiMountFixture?.stop()' })
      const result = await session.sendCommand('Runtime.evaluate', { expression: `({global:!!globalThis.__cuiMountFixture,iframes:document.querySelectorAll('iframe[data-cui-fixture]').length})`, returnByValue: true })
      report.cleanup = result.result?.value
      if (created && (!report.cleanup || report.cleanup.global !== false || report.cleanup.iframes !== 0)) {
        report.status = 'failed'; report.code = 'cleanup'; process.exitCode = 1
      }
    } catch { report.status = 'failed'; report.code = 'cleanup-observation'; process.exitCode = 1 }
    finally {
      try { await session.close() }
      catch { report.status = 'failed'; report.code = 'session-close'; process.exitCode = 1 }
    }
  }
  console.log(JSON.stringify(report))
}
