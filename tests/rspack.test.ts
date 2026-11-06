import { expect, test } from 'bun:test'
import { clientsFromRspack, discoverClients } from '../tools/probes/renderer-capabilities'
const client = { safeGet: async () => ({}), makeRequest() {} }
function runtime(cache: object) {
  let invoked = false
  const require = Object.assign(() => { invoked = true; throw new Error('factory') }, { c: cache, m: {} })
  return { module: { __webpack_require__: require }, invoked: () => invoked }
}
function live(value: unknown) {
  // This mirrors a bundler live binding rather than running an arbitrary computed getter.
  const exports = {}
  Object.defineProperty(exports, '__esModule', { value: true })
  Object.defineProperty(exports, 'client', { enumerable: true, get: () => value })
  return { exports }
}
test('超过一万缓存记录仍能识别后部的唯一实时绑定，不执行工厂', () => {
  const cache: Record<string, unknown> = {}
  for (let i = 0; i < 10_298; i++) cache[i] = live(null)
  cache['10297'] = live(client)
  const r = runtime(cache)
  expect(clientsFromRspack(r.module)).toEqual([client])
  expect(r.invoked()).toBe(false)
})
test('不执行带调用、属性读取、代码块或副作用的 getter', () => {
  let calls = 0
  const exports = {}
  Object.defineProperty(exports, '__esModule', { value: true })
  Object.defineProperty(exports, 'dangerous', { enumerable: true, get: () => { calls++; return client } })
  const r = runtime({ a: { exports } })
  expect(clientsFromRspack(r.module)).toEqual([])
  expect(calls).toBe(0)
})
test('预算耗尽不接受部分唯一结果', () => {
  const cache: Record<string, unknown> = { a: live(client) }
  for (let i = 0; i < 16_384; i++) cache[i] = live(null)
  expect(clientsFromRspack(runtime(cache).module)).toEqual([])
})
test('客户端去重，但保留两个不同实例供上层歧义拒绝', () => {
  const other = { ...client }
  expect(clientsFromRspack(runtime({ a: live(client), b: live(client), c: live(other) }).module)).toEqual([client, other])
})
test('现有入口发现会走 Rspack 适配器', async () => {
  const r = runtime({ a: live(client) })
  const url = 'app://-/assets/123.test.js'
  expect(await discoverClients([url], async () => r.module, url, new AbortController().signal)).toEqual([client])
})
test('转译后未标记 __esModule 的简单 live binding 仍可识别', () => {
  const value = client
  const exports = {}
  Object.defineProperty(exports, 'http', { enumerable: true, get: () => value })
  expect(clientsFromRspack(runtime({ a: { exports } }).module)).toEqual([client])
})
test('导出预算耗尽后不能将先找到的客户端视作唯一', () => {
  const value = null
  const exports = {}
  for (let i = 0; i < 131_072; i++) Object.defineProperty(exports, 'x' + i, { enumerable: true, get: () => value })
  expect(clientsFromRspack(runtime({ a: live(client), b: { exports } }).module)).toEqual([])
})
test.each(['modules', 'exports'] as const)('完整入口在%s预算耗尽时拒绝旧扫描的部分候选', async kind => {
  const cache: Record<string, unknown> = { first: { exports: client } }
  if (kind === 'modules') {
    for (let i = 0; i < 16_384; i++) cache['x' + i] = { exports: null }
  } else {
    const exports: Record<string, null> = {}
    for (let i = 0; i < 131_072; i++) exports['x' + i] = null
    cache.large = { exports }
  }
  cache.last = { exports: { ...client } }
  const r = runtime(cache), url = 'app://-/assets/budget.js'
  await expect(discoverClients([url], async () => r.module, url, new AbortController().signal)).rejects.toHaveProperty('code', 'ambiguity')
  expect(r.invoked()).toBe(false)
})
