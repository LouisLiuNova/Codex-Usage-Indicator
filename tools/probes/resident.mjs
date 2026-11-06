// Thin adapter over the pinned Loader's CDP and lifecycle APIs. No host bridge or second server.
import { syncDocument, pluginId } from './recovery.mjs'
export function validatePlan(descriptors) {
  if (descriptors.length > 1 || descriptors.some(d => d.id !== pluginId || d.permissions?.some(p => p !== 'dom')))
    throw new Error('isolated-dom-plan')
}
export function buildDocumentSource(descriptors, injection, url) {
  validatePlan(descriptors)
  const source = [injection.buildBootstrapSource(), injection.buildLifecycleSyncSource(descriptors),
    ...descriptors.map(d => injection.wrapScript(d)),
    ...(!descriptors.length ? ['globalThis.__codexUsageIndicatorRuntime?.stop()'] : [])].join('\n')
  return `(()=>{if(globalThis.top!==globalThis||location.href!==${JSON.stringify(url)})return;
    globalThis.__codexUsageIndicatorBoot?.cancel();
    let active=true;const record={cancel:()=>{active=false;document.removeEventListener('DOMContentLoaded',start);if(globalThis.__codexUsageIndicatorBoot===record)delete globalThis.__codexUsageIndicatorBoot}};
    const start=()=>{if(!active)return;record.cancel();${source}\n};
    globalThis.__codexUsageIndicatorBoot=record;
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start()})()`
}
export class ResidentInjector {
  constructor({ resolveTarget, connect, getPlan, injection, onState = () => {}, heartbeatMs = 15000, debounceMs = 100 }) {
    Object.assign(this, { resolveTarget, connect, getPlan, injection, onState, heartbeatMs, debounceMs })
    this.stopped = false; this.dirtyPlan = true; this.pending = false; this.work = null
    this.session = null; this.plan = null; this.registration = null; this.key = null; this.last = null
    this.metrics = { checks: 0, events: 0, connections: 0, registrations: 0, repairs: 0, failures: 0, commands: 0, sentBytes: 0 }
    this.failures = 0
  }
  async start() {
    this.heartbeat = setInterval(() => { void this.sync() }, this.heartbeatMs)
    await this.sync(true)
    return this
  }
  notify(refreshPlan = false) {
    if (this.stopped) return
    this.dirtyPlan ||= refreshPlan
    if (this.debounce) return
    this.debounce = setTimeout(() => { this.debounce = null; void this.sync() }, this.debounceMs)
  }
  sync(refreshPlan = false) {
    if (this.stopped) return Promise.resolve(this.last)
    this.dirtyPlan ||= refreshPlan; this.pending = true
    if (this.work) return this.work
    this.work = this.drain().finally(() => { this.work = null })
    return this.work
  }
  async drain() {
    while (this.pending && !this.stopped) {
      this.pending = false
      try {
        await this.step()
        this.failures = 0
        if (this.retry) clearTimeout(this.retry)
        this.retry = null
      } catch {
        this.metrics.failures++; this.failures++
        await this.disconnect()
        this.onState('degraded', this.snapshot())
        if (!this.stopped && !this.retry) this.retry = setTimeout(() => {
          this.retry = null; void this.sync(true)
        }, Math.min(15000, 1000 * 2 ** Math.min(4, this.failures - 1)))
        break
      }
    }
    return this.last
  }
  async command(method, params = {}) {
    this.metrics.commands++; this.metrics.sentBytes += Buffer.byteLength(JSON.stringify({ method, params }))
    return this.session.sendCommand(method, params)
  }
  async step() {
    if (!this.session) {
      this.target = await this.resolveTarget() // Verify loopback ownership only before a new connection.
      this.session = await this.connect(this.target.webSocketDebuggerUrl)
      this.metrics.connections++
      this.unsubscribe = this.session.onEvent(event => {
        if (['Runtime.executionContextsCleared', 'Page.domContentEventFired', 'Page.loadEventFired', 'Inspector.detached'].includes(event.method)) {
          this.metrics.events++; this.notify()
        }
      })
      await this.command('Runtime.enable'); await this.command('Page.enable')
      this.dirtyPlan = true
    }
    if (this.dirtyPlan || !this.plan || Date.now() - this.planAt >= 60000) {
      this.plan = await this.getPlan(); validatePlan(this.plan); this.dirtyPlan = false; this.planAt = Date.now()
    }
    const key = JSON.stringify([this.target.url, this.plan.map(d => [d.id, d.fingerprint])])
    if (key !== this.key) {
      if (this.registration) await this.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.registration })
      this.registration = null; this.key = null
      const source = buildDocumentSource(this.plan, this.injection, this.target.url)
      const result = await this.command('Page.addScriptToEvaluateOnNewDocument', { source })
      if (!result?.identifier) throw new Error('registration-missing')
      this.registration = result.identifier; this.key = key; this.metrics.registrations++
      const evaluation = await this.command('Runtime.evaluate', { expression: source, returnByValue: true })
      if (evaluation?.exceptionDetails) throw new Error('renderer-evaluation')
    }
    const previous = this.last
    this.last = await syncDocument({ session: { sendCommand: (method, params) => this.command(method, params) },
      descriptors: this.plan, injection: this.injection })
    this.metrics.checks++
    if (this.last.changed) this.metrics.repairs++
    if (this.last.changed || previous?.documentId !== this.last.documentId || this.failures) this.onState('running', this.snapshot())
  }
  snapshot() {
    return { ...this.metrics, connected: !!this.session, heartbeatMs: this.heartbeatMs,
      documentId: this.last?.documentId ?? null, runtime: this.last?.runtime ?? null,
      enabled: !!this.plan?.length }
  }
  async disconnect() {
    this.unsubscribe?.(); this.unsubscribe = null
    const session = this.session
    this.session = null; this.registration = null; this.key = null
    try { await session?.close() } catch { /* The peer may have already gone away. */ }
  }
  async stop({ cleanup = true } = {}) {
    if (this.stopped) return this.cleaned ?? false
    this.stopped = true; this.cleaned = false
    clearInterval(this.heartbeat); clearTimeout(this.debounce); clearTimeout(this.retry)
    await this.work
    try {
      // A disconnected socket does not prove that its renderer-owned runtime stopped.
      if (!this.session && this.metrics.connections) {
        const target = await this.resolveTarget()
        this.session = await this.connect(target.webSocketDebuggerUrl)
        this.metrics.connections++
      }
      if (this.session) {
        if (this.registration) await this.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.registration })
        await this.command('Runtime.evaluate', { expression: 'globalThis.__codexUsageIndicatorBoot?.cancel()', returnByValue: true })
        if (cleanup) {
          const result = await syncDocument({ session: this.session, descriptors: [], injection: this.injection })
          if (result.runtime?.active || result.status) throw new Error('cleanup-incomplete')
        }
      }
      this.cleaned = true
      return true
    } finally { await this.disconnect() }
  }
}
