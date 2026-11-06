// Isolated Chromium experiment; never reload a real Codex renderer.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const [loader, portText, bundle, mode] = process.argv.slice(2)
const { listTargets, connectCdpSession } = await import(pathToFileURL(path.resolve(loader, 'src/cdp.mjs')).href)
const targets = (await listTargets(Number(portText))).filter(t => t.type === 'page')
if (targets.length !== 1 || targets[0].url !== 'about:blank') throw new Error('isolated-about-blank-required')
const endpoint = targets[0].webSocketDebuggerUrl
const evaluate = async (session, expression) => {
  const result = await session.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) throw new Error('evaluation')
  return result.result?.value
}
if (mode === '--inject') {
  const session = await connectCdpSession(endpoint)
  try {
    const code = await readFile(bundle, 'utf8')
    const source = `(()=>{const start=()=>{const module={exports:{}};((module)=>{${code}\n})(module);
      module.exports.createRuntime(document,{read:async()=>({source:'renderer-wham',coverage:'weekly-only',quality:'normal',fiveHour:null,weekly:{remainingPercent:75,resetsAt:1800000000},diagnostics:[]})})};
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start()})()`
    await session.sendCommand('Page.enable')
    await session.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })
    await evaluate(session, source)
  } finally { await session.close() }
} else {
  const child = spawnSync(process.execPath, [process.argv[1], loader, portText, bundle, '--inject'], { timeout: 10000, encoding: 'utf8' })
  if (child.status !== 0) throw new Error('injector-exit')
  const report = { scope: 'isolated-chromium-synthetic-provider', injectorExited: true }
  const read = async () => {
    const session = await connectCdpSession(endpoint)
    try { return await evaluate(session, 'globalThis.__codexUsageIndicatorRuntime?.inspect()??null') }
    finally { await session.close() }
  }
  report.before = await read()
  await delay(31000)
  report.after = await read()
  report.pollingAfterExit = report.after?.status === 'ready' && report.after.requests > report.before?.requests
  const session = await connectCdpSession(endpoint)
  try { await session.sendCommand('Page.reload') } finally { await session.close() }
  await delay(1000)
  report.afterReload = await read()
  report.reloadRestored = !!report.afterReload?.active
  console.log(JSON.stringify(report))
  if (!report.pollingAfterExit) process.exitCode = 1
}
