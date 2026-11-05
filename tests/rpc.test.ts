import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { ReadRpc } from '../tools/probes/rpc'

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
  const { child, rpc } = fixture(mode, 200)
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
