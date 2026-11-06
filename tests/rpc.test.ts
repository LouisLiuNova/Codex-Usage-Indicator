import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { collectAppServer, ReadRpc } from '../tools/probes/rpc'

function fixture(mode: string, timeout = 1000) {
  const child = spawn(process.execPath, ['run', 'tests/fixtures/rpc-server.ts', mode], { stdio: 'pipe' })
  return { child, rpc: new ReadRpc(child, timeout) }
}
test('握手、通知、分块行、多余请求与只读额度', async () => {
  const { child, rpc } = fixture('ok')
  try {
    expect(await rpc.call('initialize', {})).toEqual({})
    rpc.notifyInitialized()
    const account = await rpc.call('account/read', { refreshToken: false })
    expect(account).toHaveProperty('account.type', 'chatgpt')
    const limits = await rpc.call('account/rateLimits/read', {})
    expect(limits).toHaveProperty('rateLimitsByLimitId.codex.primary.windowDurationMins', 10080)
  } finally { await rpc.close() }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  await rpc.close()
  await expect(rpc.call('initialize', {})).rejects.toHaveProperty('code', 'exit')
})
test.each([['hang', 'timeout'], ['exit', 'exit'], ['malformed', 'protocol'], ['oversize', 'protocol'], ['rpc-error', 'rpc']])('%s 安全归类 %s', async (mode, code) => {
  // Only the hanging-server case measures a short deadline. Other cases classify protocol errors,
  // and must allow the real child runtime to start on a busy host.
  const { child, rpc } = fixture(mode, mode === 'hang' ? 200 : 1500)
  try { await expect(rpc.call('initialize', {})).rejects.toHaveProperty('code', code) }
  finally { await rpc.close() }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
})
test('启动失败不泄漏路径或原始错误', async () => {
  const child = spawn('/missing/private-command', [], { stdio: 'pipe' })
  const rpc = new ReadRpc(child, 100)
  try { await expect(rpc.call('initialize', {})).rejects.toHaveProperty('code', 'spawn') }
  finally { await rpc.close() }
})
test('单飞约束且关闭会终止挂起请求', async () => {
  const { rpc } = fixture('hang')
  const pending = rpc.call('initialize', {}).catch(error => error)
  await expect(rpc.call('initialize', {})).rejects.toHaveProperty('code', 'protocol')
  await rpc.close()
  expect(await pending).toHaveProperty('code', 'exit')
})
test('完整探针输出白名单并关闭进程', async () => {
  const { child, rpc } = fixture('ok')
  const result = await collectAppServer(rpc)
  expect(result.normalized.coverage).toBe('weekly-only')
  expect(result.identity).toBe('desktop-comparison-required')
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|email|accountId/)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
})
test('采样中切换账号作废整份输出', async () => {
  const { child, rpc } = fixture('switch')
  await expect(collectAppServer(rpc)).rejects.toHaveProperty('code', 'account-changed')
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
})
