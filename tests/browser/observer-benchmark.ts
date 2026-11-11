import { createGeometryFixture } from './geometry-fixture'
// Synthetic load only. Measures the plugin's MutationObserver callbacks, not the host's total CPU.
export async function runObserverBenchmark(doc: Document) {
  const win = doc.defaultView!, Original = win.MutationObserver
  let callbacks = 0, records = 0, callbackMs = 0
  win.MutationObserver = class extends Original {
    constructor(callback: MutationCallback) {
      super((changes, observer) => {
        const start = win.performance.now()
        try { callback(changes, observer) }
        finally { callbacks++; records += changes.length; callbackMs += win.performance.now() - start }
      })
    }
  }
  let fixture: ReturnType<typeof createGeometryFixture> | undefined
  const feed = doc.createElement('section')
  Object.assign(feed.style, { position: 'absolute', top: '0', left: '100px', width: '600px', height: '400px', overflow: 'hidden', contain: 'strict' })
  const rows: HTMLElement[] = []
  try {
    fixture = createGeometryFixture(doc, 'thread', 'dark')
    win.MutationObserver = Original
    for (let i = 0; i < 10000; i++) { const row = doc.createElement('article'); row.textContent = `synthetic ${i}`; feed.append(row); rows.push(row) }
    doc.body.append(feed)
    await new Promise(resolve => setTimeout(resolve, 200))
    const before = fixture.snapshot().runtime.ui!.scans
    callbacks = records = callbackMs = 0
    const started = win.performance.now()
    let writesMs = 0
    for (let frame = 0; frame < 180; frame++) {
      const start = win.performance.now()
      for (let i = 0; i < 50; i++) {
        const row = rows[(frame * 50 + i) % rows.length]!
        row.classList.toggle('changed'); row.textContent = `synthetic ${frame}-${i}`
      }
      writesMs += win.performance.now() - start
      await new Promise(resolve => win.requestAnimationFrame(resolve))
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    const elapsedMs = win.performance.now() - started
    const result = { scope: 'isolated-chromium-synthetic-10000-rows', rows: rows.length, updates: 9000, callbacks, records,
      elapsedMs, writesMs, mutationCallbackMs: callbackMs, callbackPercentOfWallTime: callbackMs / elapsedMs * 100,
      scans: fixture.snapshot().runtime.ui!.scans - before, snapshot: fixture.snapshot() }
    return result
  } finally { win.MutationObserver = Original; fixture?.stop(); feed.remove() }
}
