import { expect, test } from 'bun:test'
import { WhamProvider, requestError } from '../plugin/src/providers/wham'
const raw = (account = 'private-a') => ({ account_id: account, email: 'private@example.test', rate_limit: {
  primary_window: { limit_window_seconds: 604800, used_percent: 25, reset_at: 1800000000 }
} })
function setup(read: () => Promise<unknown>, changed = () => {}) {
  let discoveries = 0
  const paths: string[] = []
  const provider = new WhamProvider(async () => { discoveries++; return [{
    safeGet: async (path: string) => { paths.push(path); return read() }, makeRequest() {}
  }] }, changed)
  return { provider, paths, discoveries: () => discoveries }
}
test('固定路径、缓存发现且只输出窗口，不泄漏身份', async () => {
  const s = setup(async () => raw())
  try {
    const result = await s.provider.read(new AbortController().signal)
    await s.provider.read(new AbortController().signal)
    expect(result.coverage).toBe('weekly-only')
    expect(JSON.stringify(result)).not.toMatch(/private|email|account_id/)
    expect(s.paths).toEqual(['/wham/usage', '/wham/usage'])
    expect(s.discoveries()).toBe(1)
  } finally { s.provider.stop() }
})
test('主账号标识改变只通知失效，不将标识传给 UI', async () => {
  let account = 'private-a', changes = 0
  const s = setup(async () => raw(account), () => { changes++ })
  try {
    await s.provider.read(new AbortController().signal)
    account = 'private-b'
    const result = await s.provider.read(new AbortController().signal)
    expect(changes).toBe(1)
    expect(JSON.stringify(result)).not.toContain('private')
  } finally { s.provider.stop() }
})
test('身份不确定时阻止读取；重新确认前台后清除阻止', async () => {
  const s = setup(async () => raw())
  try {
    s.provider.invalidate(true)
    await expect(s.provider.read(new AbortController().signal)).rejects.toBeInstanceOf(Error)
    expect(s.paths.length).toBe(0)
    s.provider.invalidate(false)
    expect((await s.provider.read(new AbortController().signal)).coverage).toBe('weekly-only')
  } finally { s.provider.stop() }
})
test('请求错误保留安全状态码和 Retry-After，下次重新发现', async () => {
  const s = setup(async () => { throw { status: 429, headers: { 'retry-after': '120' }, message: 'SECRET', token: 'PRIVATE' } })
  try {
    await expect(s.provider.read(new AbortController().signal)).rejects.toHaveProperty('retryAfterMs', 120000)
    await expect(s.provider.read(new AbortController().signal)).rejects.toHaveProperty('status', 429)
    expect(s.discoveries()).toBe(2)
  } finally { s.provider.stop() }
})
test.each([401, 403, 500])('错误状态 %i 不被错误消息覆盖', status => {
  expect(requestError({ response: { status }, message: 'SECRET' }).status).toBe(status)
  expect(requestError({ status: String(status) }).status).toBeNull()
})
test('Retry-After HTTP 日期和非法输入', () => {
  const date = Date.parse('2026-11-06T10:00:00Z')
  expect(requestError({ status: 429, headers: { 'Retry-After': 'Fri, 06 Nov 2026 10:02:00 GMT' } }, date).retryAfterMs).toBe(120000)
  expect(requestError({ status: 429, headers: { 'retry-after': '' } }, date).retryAfterMs).toBeNull()
  expect(requestError({ status: 429, headers: { 'retry-after': 'Infinity' } }, date).retryAfterMs).toBeNull()
  expect(requestError({ status: 429, headers: { 'retry-after': '-1' } }, date).retryAfterMs).toBeNull()
})
test('invalidate 后无法取消的迟到网络响应被丢弃', async () => {
  let finish!: (v: unknown) => void
  const s = setup(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = s.provider.read(new AbortController().signal).catch(error => error)
    for (let i = 0; i < 20 && !finish; i++) await Promise.resolve()
    s.provider.invalidate()
    finish(raw())
    expect(await pending).toBeInstanceOf(Error)
    s.provider.stop()
    await expect(s.provider.read(new AbortController().signal)).rejects.toBeInstanceOf(Error)
  } finally { s.provider.stop() }
})
