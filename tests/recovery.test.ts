import { expect, test } from 'bun:test'
// @ts-expect-error Native Node entry, deliberately not transpiled.
import { syncDocument, waitForStableDocument } from '../tools/probes/recovery.mjs'

test('就绪回读跨文档变化重新计时，早期成功不能当作启动完成', async () => {
  let time = 0, calls = 0
  const result = await waitForStableDocument(async () => ({ documentId: ++calls < 4 ? 'early' : 'final', ready: true,
    status: 'running', runtime: { active: true, status: 'ready' } }), {
    now: () => time, delay: async (ms: number) => { time += ms }, stableMs: 1000, timeoutMs: 5000
  })
  expect(result.documentId).toBe('final')
  expect(time).toBeGreaterThanOrEqual(1750)
})
test('一直缺失或加载中的Renderer不能宣称injected', async () => {
  let time = 0
  await expect(waitForStableDocument(async () => ({ ready: false }), {
    now: () => time, delay: async (ms: number) => { time += ms }, timeoutMs: 1000
  })).rejects.toThrow('document-not-stable')
})
test('修复运行记录尚在但实际运行时丢失，健康样本不重复注入', async () => {
  let source = '', live = false
  const session = { sendCommand: async (_: string, p: { expression: string }) => {
    if (!p.expression.startsWith('(()=>{const l=')) { source = p.expression; live = true; return { result: {} } }
    return { result: { value: { ready: true, documentId: 'page', fingerprint: 'same', status: 'running', runtime: { active: live } } } }
  } }
  const injection = { buildBootstrapSource: () => 'bootstrap', buildLifecycleSyncSource: () => 'sync',
    wrapScript: (_: unknown, options: { force: boolean }) => options.force ? 'forced' : 'ordinary' }
  const args = { session, descriptors: [{ id: 'local.codex-usage-indicator', fingerprint: 'same', permissions: ['dom'] }], injection }
  expect((await syncDocument(args)).changed).toBe(true)
  expect(source).toContain('forced')
  source = ''
  expect((await syncDocument(args)).changed).toBe(false)
  expect(source).toBe('')
  await expect(syncDocument({ ...args, descriptors: [{ id: 'other' }] })).rejects.toThrow('isolated-dom-plan')
})
