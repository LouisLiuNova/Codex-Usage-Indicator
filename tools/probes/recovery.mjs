// Reuse upstream wrapping/lifecycle contracts; verify the actual document instead of an injection receipt.
export const pluginId = 'local.codex-usage-indicator'
export async function syncDocument({ session, descriptors, injection }) {
  if (descriptors.length > 1 || descriptors.some(d => d.id !== pluginId || d.permissions?.some(p => p !== 'dom')))
    throw new Error('isolated-dom-plan')
  const evaluate = async expression => {
    const result = await session.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error('renderer-evaluation')
    return result.result?.value
  }
  const read = () => evaluate(`(()=>{const l=globalThis.__codexScriptLoader;const r=l?.scripts?.[${JSON.stringify(pluginId)}];return {foreignScripts:Object.keys(l?.scripts??{}).some(id=>id!==${JSON.stringify(pluginId)}),documentId:l?.documentId??null,ready:document.readyState!=='loading',fingerprint:r?.fingerprint??null,status:r?.status??null,pendingBoot:!!globalThis.__codexUsageIndicatorBoot,runtime:globalThis.__codexUsageIndicatorRuntime?.inspect()??null}})()`)
  const before = await read()
  if (before?.foreignScripts) throw new Error('foreign-scripts')
  if (!descriptors.length && before?.pendingBoot) await evaluate('globalThis.__codexUsageIndicatorBoot?.cancel()')
  if (!before?.ready && descriptors.length) return { ...before, changed: false }
  const descriptor = descriptors[0]
  const healthy = descriptor ? before.fingerprint === descriptor.fingerprint && before.status === 'running' && before.runtime?.active
    : !before.runtime?.active && !before.status
  if (healthy) return { ...before, changed: false }
  const source = [injection.buildBootstrapSource(), injection.buildLifecycleSyncSource(descriptors),
    ...(descriptor ? [injection.wrapScript(descriptor, { force: true })] : ['globalThis.__codexUsageIndicatorRuntime?.stop()'])].join('\n')
  await evaluate(source)
  return { ...await read(), changed: true }
}

export async function waitForStableDocument(sync, { signal, timeoutMs = 30_000, stableMs = 3000,
  now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs
  let id, since = now(), latest
  while (now() < deadline) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      latest = await sync()
      if (!latest?.ready || !latest.runtime?.active || latest.status !== 'running' || latest.runtime.status !== 'ready') { id = undefined; since = now() }
      else {
        if (id !== latest.documentId || latest.changed) { id = latest.documentId; since = now() }
        if (id && now() - since >= stableMs) return latest
      }
    } catch { id = undefined; since = now() }
    await delay(250)
  }
  throw new Error('document-not-stable')
}
