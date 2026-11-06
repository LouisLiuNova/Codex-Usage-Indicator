import { expect, test } from 'bun:test'
// @ts-expect-error Native Node supervisor, deliberately not transpiled.
import { ResidentInjector, buildDocumentSource } from '../tools/probes/resident.mjs'
const descriptor = { id: 'local.codex-usage-indicator', fingerprint: 'v1', permissions: ['dom'] }
const injection = { buildBootstrapSource: () => 'BOOT', buildLifecycleSyncSource: (plan: unknown[]) => plan.length ? 'KEEP' : 'DISABLE',
  wrapScript: (_: unknown, options?: { force: boolean }) => options?.force ? 'FORCE' : 'START' }
function fixture() {
  let active = false, listener = (_: { method: string }) => {}, opens = 0, closes = 0, resolutions = 0, fail = false
  let plan = [descriptor]
  const methods: string[] = []
  const resident = new ResidentInjector({ debounceMs: 5, heartbeatMs: 60000, injection,
    getPlan: async () => plan, resolveTarget: async () => { resolutions++; return { url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://localhost:1' } },
    connect: async () => {
      opens++
      return { onEvent: (fn: typeof listener) => { listener = fn; return () => { listener = () => {} } },
        close: () => { closes++ },
        sendCommand: async (method: string, params: { expression?: string }) => {
          methods.push(method)
          if (fail) { fail = false; throw new Error('disconnected') }
          if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `registration-${methods.length}` }
          if (method === 'Runtime.evaluate') {
            if (params.expression?.startsWith('(()=>{const l=')) return { result: { value: {
              ready: true, documentId: 'page', fingerprint: active ? 'v1' : null, status: active ? 'running' : null,
              runtime: active ? { active: true, status: 'ready' } : null
            } } }
            if (!params.expression?.includes('__codexUsageIndicatorBoot?.cancel()') || params.expression.includes('BOOT')) active = !params.expression?.includes('DISABLE'); return { result: {} }
          }
          return {}
        }
      }
    }
  })
  return { resident, methods, event: () => listener({ method: 'Page.loadEventFired' }),
    disable: () => { plan = [] }, fail: () => { fail = true }, counts: () => ({ opens, closes, resolutions, active }) }
}
test('健康检查复用连接和注册，不重复注入，停用与退出清理', async () => {
  const f = fixture()
  try {
    await f.resident.start()
    const before = f.resident.snapshot()
    await f.resident.sync()
    expect(f.resident.snapshot()).toMatchObject({ connections: 1, registrations: 1, repairs: 0, checks: before.checks + 1 })
    expect(f.counts()).toMatchObject({ resolutions: 1, active: true })
    expect(f.methods.filter(x => x === 'Page.addScriptToEvaluateOnNewDocument').length).toBe(1)
    f.disable(); await f.resident.sync(true)
    expect(f.counts().active).toBe(false)
    expect(f.resident.snapshot().registrations).toBe(2)
  } finally { await f.resident.stop() }
  expect(f.counts()).toMatchObject({ opens: 1, closes: 1 })
})
test('连续页面事件合并，断线重新核验连接，停止后不再恢复', async () => {
  const f = fixture()
  try {
    await f.resident.start()
    const checks = f.resident.snapshot().checks
    for (let i = 0; i < 50; i++) f.event()
    await new Promise(r => setTimeout(r, 30))
    expect(f.resident.snapshot().checks).toBe(checks + 1)
    f.fail(); await f.resident.sync()
    expect(f.resident.snapshot().connected).toBe(false)
    await f.resident.sync()
    expect(f.counts()).toMatchObject({ opens: 2, resolutions: 2 })
  } finally { await f.resident.stop() }
  const checks = f.resident.snapshot().checks
  f.event(); await f.resident.sync()
  expect(f.resident.snapshot().checks).toBe(checks)
})
test('预注册只在唯一宿主主文档运行，并等待DOM ready', () => {
  const source = buildDocumentSource([descriptor], injection, 'app://-/index.html')
  expect(source).toContain('globalThis.top!==globalThis')
  expect(source).toContain('location.href!=="app://-/index.html"')
  expect(source).toContain('DOMContentLoaded')
  expect(() => buildDocumentSource([{ ...descriptor, permissions: ['local-storage'] }], injection, 'about:blank')).toThrow('isolated-dom-plan')
})

test('断线后停止重新核验连接，不能把断线当作Renderer清理', async () => {
  const f = fixture()
  await f.resident.start()
  f.fail(); await f.resident.sync()
  expect(f.resident.snapshot().connected).toBe(false)
  expect(await f.resident.stop()).toBe(true)
  expect(f.counts()).toMatchObject({ resolutions: 2, opens: 2, closes: 2, active: false })
})
